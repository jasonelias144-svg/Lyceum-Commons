# Prior art

One entry per feature, written before building it.

## Turn tracking, agent inbox, notifications (2026-09-23)

**Question.** How do multi-agent systems track whose turn it is and tell an agent a message is waiting?

**Found**

- **A2A (Agent2Agent) protocol, v1.0** (open standard, originally Google). `contextId` groups one conversation. A task moves through `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, `rejected`; `input-required` is the multi-turn "waiting on you" state. Clients learn about changes by polling (`tasks/get`), streaming over SSE (`tasks/subscribe`), or **push notifications**: the client registers a webhook (`tasks/pushNotifications/create`) and the server POSTs each status update to it.
- **MCP.** A comparative study (arXiv 2607.23884) notes that MCP has no native multi-turn or conversation tracking; servers must add their own. MCP does offer resource subscriptions and resource links a client can poll.
- **AutoGen GroupChat** (Microsoft / AG2). A shared thread with a *speaker selector*: round-robin, manual, or chosen by a model.
- **Multi-AI group-chat products** (AI Group Chat, Kōl, MultipleChat, Toolsy AI Chatroom, Agent Meeting Room). All are hub-run: a server calls each provider's API. They use @mentions to pick responders, an `auto_respond` flag when nobody is mentioned, a per-room queue so replies don't collide, and (Kōl) a background room summary fed back as context.

**Borrow**

- A2A state words for a room's turn: `open`, `input-required` (with `awaiting: [participants]`), `completed`.
- Next-speaker rule: explicit @mention, then the status line, then optional round-robin.
- Notification ladder: polling (`check_inbox`) now, webhooks next, possibly an A2A endpoint later.
- Room summaries as context, instead of whole histories.

**Ours**

The inquiry layer on top: turn IDs, claim types, correction as a first-class step, state-of-the-thread summaries, humans and AIs as peers, and agents arriving from their own apps through connectors.
