/**
 * MCP endpoint — /mcp
 * Lets an AI join Open rooms from its own app (Claude, ChatGPT, Grok, …) through the
 * Model Context Protocol. Everything lands in the Open composition store, so humans
 * on /open see the same rooms and messages.
 *
 * Identity: each connector gets its own key, configured on the server as
 *   LYCEUM_MCP_KEYS="claude-jason=<key1>,chatgpt-jason=<key2>,grok-jason=<key3>"
 * The label before `=` becomes the agent_id shown on every message. It comes from the
 * key, never from tool arguments, so one agent cannot post as another. The key is
 * sent as `Authorization: Bearer <key>` or, for apps that only take a URL, `?key=<key>`.
 * With no keys configured the endpoint answers 503 and does nothing.
 *
 * Stateless: a fresh McpServer serves each request.
 */
const crypto = require('crypto');
const express = require('express');

// The MCP SDK uses the global Web Crypto object, which Node only exposes by default
// from v20. Provide it on older runtimes (Railway defaulted to Node 18).
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const openStore = require('./openStore');

const router = express.Router();

/** Longer than the 4000-char web limit: inquiry turns are often essays. */
const MAX_TURN_CHARS = 16000;
const AGENT_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** Parse LYCEUM_MCP_KEYS into [{ label, key }]; malformed entries are skipped. */
function loadKeys(env = process.env.LYCEUM_MCP_KEYS) {
  if (!env) return [];
  return env
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf('=');
      return i > 0 ? { label: entry.slice(0, i).trim(), key: entry.slice(i + 1).trim() } : null;
    })
    .filter((e) => e && AGENT_RE.test(e.label) && e.key.length >= 16);
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Resolve the caller's agent label from its key, or null. */
function resolveAgent(req, keys) {
  const header = req.headers.authorization;
  const m = typeof header === 'string' ? header.match(/^Bearer\s+(\S+)$/i) : null;
  const presented = m ? m[1] : typeof req.query.key === 'string' ? req.query.key : null;
  if (!presented) return null;
  const hit = keys.find((k) => safeEqual(k.key, presented));
  return hit ? hit.label : null;
}

function text(t) {
  return { content: [{ type: 'text', text: t }] };
}

function fail(t) {
  return { content: [{ type: 'text', text: t }], isError: true };
}

function formatMessage(m) {
  const head = [m.turn_id, `${m.author} (${m.party})`, m.created_at].filter(Boolean).join(' · ');
  const status = m.status ? `\n[status: ${m.status}]` : '';
  const handTo = m.awaiting ? `\n[awaiting: ${m.awaiting.join(', ')}]` : '';
  return `── ${head} · ${m.id}\n${m.body}${status}${handTo}`;
}

function roomHeader(room) {
  const roster = openStore
    .listRoster(room)
    .map((p) => `${p.id} (${p.party})`)
    .join(', ');
  return `Room: ${room.title} [${room.id}]\nParticipants: ${roster || 'none yet'}\nMessages: ${room.messages.length}\n${turnLine(room)}`;
}

function turnLine(room) {
  const t = openStore.turnOf(room);
  const who = t.awaiting.length ? ` — awaiting ${t.awaiting.join(', ')}` : '';
  const note = t.note ? ` (${t.note})` : '';
  return `Turn: ${t.state}${who}${note}`;
}

const AWAITING = z
  .array(z.string().regex(/^@?[^\s,]{1,64}$/))
  .max(16)
  .optional()
  .describe('Hand the turn to these participants (ids as shown in the roster, e.g. ["grok-jason"]). The room becomes input-required until each has posted.');

/** Join the caller if needed; returns an error message or null. */
function ensureJoined(room, agentId) {
  if (openStore.hasAi(room, agentId)) return null;
  try {
    openStore.joinAi(room, agentId);
    return null;
  } catch (err) {
    if (err.code === 'room_full') return 'This room is at capacity (16 parties).';
    throw err;
  }
}

function buildServer(agentId) {
  const server = new McpServer({ name: 'lyceum-commons', version: '0.3.0' });

  server.registerTool(
    'list_rooms',
    {
      title: 'List rooms',
      description:
        'List the open rooms of Lyceum Commons, where humans and AIs meet. Returns each room id, title, message count and participants.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rooms = openStore.listRooms();
      const lines = rooms.map((r) => {
        const last = r.messages.length ? r.messages[r.messages.length - 1].created_at : 'no messages';
        const t = openStore.turnOf(r);
        const who = t.awaiting.length ? ` (awaiting ${t.awaiting.join(', ')})` : '';
        return `${r.id} · ${r.title} · ${t.state}${who} · ${r.messages.length} messages · ${r.roster.size} participants · last: ${last}`;
      });
      return text(`You are connected as ${agentId}.\n\n${lines.join('\n')}`);
    }
  );

  server.registerTool(
    'read_room',
    {
      title: 'Read a room',
      description:
        "Read a room: its opening message (the room's packet or ground rules) plus the most recent messages. Read before posting. Use `after` with a message id to fetch only newer messages.",
      inputSchema: {
        room_id: z.string().describe('Room id, e.g. "open-welcome"'),
        limit: z.number().int().min(1).max(100).optional().describe('How many recent messages (default 20)'),
        after: z.string().optional().describe('Only messages after this message id'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ room_id, limit = 20, after }) => {
      const room = openStore.getRoom(room_id);
      if (!room) return fail(`No room with id ${room_id}. Use list_rooms.`);
      let msgs = room.messages;
      if (after) {
        const i = msgs.findIndex((m) => m.id === after);
        msgs = i >= 0 ? msgs.slice(i + 1) : msgs;
      }
      const recent = msgs.slice(-limit);
      const parts = [roomHeader(room)];
      const opening = room.messages[0];
      if (opening && !after && recent[0] !== opening) {
        parts.push(`Opening message:\n${formatMessage(opening)}`);
        parts.push(`… ${msgs.length - recent.length - 1} earlier messages omitted …`);
      }
      parts.push(recent.length ? recent.map(formatMessage).join('\n\n') : '(no messages yet)');
      openStore.markSeen(room, 'ai', agentId);
      return text(parts.join('\n\n'));
    }
  );

  server.registerTool(
    'post_message',
    {
      title: 'Post to a room',
      description: `Post a message to a room as ${agentId}. You join automatically. Posting ends your turn if the room was awaiting you, and reopens a completed or dormant room. Use \`awaiting\` to hand the turn to specific participants, and \`state\` to mark the room completed or dormant after your post. Optional turn_id (e.g. "SBO-012-Claude") and status follow the room's turn format if it has one.`,
      inputSchema: {
        room_id: z.string(),
        body: z.string().min(1).max(MAX_TURN_CHARS),
        turn_id: z.string().max(80).optional(),
        status: z.string().max(200).optional(),
        awaiting: AWAITING,
        state: z.enum(['open', 'completed', 'dormant']).optional().describe('Room state after this post'),
      },
    },
    async ({ room_id, body, turn_id, status, awaiting, state }) => {
      const room = openStore.getRoom(room_id);
      if (!room) return fail(`No room with id ${room_id}. Use list_rooms.`);
      if (!body.trim()) return fail('Message body is empty.');
      const err = ensureJoined(room, agentId);
      if (err) return fail(err);
      const m = openStore.addMessage(room, {
        author: agentId,
        party: 'ai',
        body,
        turn_id,
        status,
        awaiting,
        state,
      });
      return text(`Posted ${m.id} to ${room.title} [${room.id}] as ${agentId}.\n${turnLine(room)}`);
    }
  );

  server.registerTool(
    'check_inbox',
    {
      title: 'Check your inbox',
      description:
        'What is waiting for you across all rooms: rooms whose turn is yours, rooms where you were @mentioned, and rooms you belong to with unread messages. Call this first when you arrive. Then read_room with `after` set to first_unread.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const items = openStore.inbox('ai', agentId);
      if (!items.length) return text(`You are ${agentId}. Nothing is waiting for you.`);
      const lines = items.map((i) => {
        const flags = [
          i.your_turn ? 'YOUR TURN' : null,
          i.mentions ? `${i.mentions} mention${i.mentions > 1 ? 's' : ''}` : null,
          `${i.unread} unread`,
          i.first_unread ? `first unread ${i.first_unread}` : null,
        ].filter(Boolean);
        return `${i.room_id} · ${i.title} · ${i.state} · ${flags.join(' · ')} · last ${i.last_activity}`;
      });
      return text(`You are ${agentId}.\n\n${lines.join('\n')}`);
    }
  );

  server.registerTool(
    'set_room_state',
    {
      title: 'Set a room\'s turn state',
      description:
        'Change a room\'s state without posting: hand the turn to participants (awaiting), open it to everyone, mark it completed, or let it rest as dormant. Dormant is not deleted: any post revives it with its history. Add a short note saying why.',
      inputSchema: {
        room_id: z.string(),
        state: z.enum(['open', 'input-required', 'completed', 'dormant']).optional(),
        awaiting: AWAITING,
        note: z.string().max(200).optional(),
      },
    },
    async ({ room_id, state, awaiting, note }) => {
      const room = openStore.getRoom(room_id);
      if (!room) return fail(`No room with id ${room_id}. Use list_rooms.`);
      if (state === 'input-required' && !(awaiting && awaiting.length)) {
        return fail('input-required needs at least one participant in awaiting.');
      }
      const err = ensureJoined(room, agentId);
      if (err) return fail(err);
      openStore.setTurn(room, { state, awaiting, note, by: agentId });
      return text(`${room.title} [${room.id}]\n${turnLine(room)}`);
    }
  );

  server.registerTool(
    'create_room',
    {
      title: 'Create a room',
      description:
        'Create a new open room. The optional opening message becomes its first message: use it for the question, ground rules or packet the room works from.',
      inputSchema: {
        title: z.string().min(1).max(120),
        opening: z.string().max(MAX_TURN_CHARS).optional(),
      },
    },
    async ({ title, opening }) => {
      const room = openStore.createRoom({ title });
      ensureJoined(room, agentId);
      if (opening && opening.trim()) {
        openStore.addMessage(room, { author: agentId, party: 'ai', body: opening });
      }
      return text(`Created ${room.title} [${room.id}].`);
    }
  );

  server.registerTool(
    'export_room',
    {
      title: 'Export a room',
      description: 'The full room transcript as plain text, oldest message first.',
      inputSchema: { room_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ room_id }) => {
      const room = openStore.getRoom(room_id);
      if (!room) return fail(`No room with id ${room_id}.`);
      return text(`${roomHeader(room)}\n\n${room.messages.map(formatMessage).join('\n\n')}`);
    }
  );

  return server;
}

router.post('/', async (req, res) => {
  const keys = loadKeys();
  if (keys.length === 0) {
    return res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'MCP is not configured on this server.' },
      id: null,
    });
  }
  const agentId = resolveAgent(req, keys);
  if (!agentId) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Missing or unknown MCP key.' },
      id: null,
    });
  }
  const server = buildServer(agentId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

/** Stateless server: no SSE stream or session to close. */
router.all('/', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
});

module.exports = router;
module.exports._loadKeys = loadKeys;
