/*! Lyceum Commons — Open composition UI (party-labeled mixed rooms). */
(function () {
  const OPEN_WELCOME = 'open-welcome';

  const errorEl = document.getElementById('error');
  const lobbyEl = document.getElementById('lobby');
  const roomEl = document.getElementById('room');
  const handleInput = document.getElementById('handle');
  const agentInput = document.getElementById('agent-id');
  const roomIdInput = document.getElementById('room-id');
  // Notification links point at /open?room=<id>: prefill the room to join.
  const linkedRoom = new URLSearchParams(window.location.search).get('room');
  if (linkedRoom && roomIdInput) roomIdInput.value = linkedRoom;
  const threadEl = document.getElementById('thread');
  const rosterEl = document.getElementById('roster-list');
  const bodyInput = document.getElementById('body');
  const bodyCount = document.getElementById('body-count');
  const humanFields = document.getElementById('human-fields');
  const aiFields = document.getElementById('ai-fields');

  const state = {
    roomId: '',
    party: 'human', // session party after join
    handle: '',
    agentId: '',
    credential: '',
    pollTimer: null,
    replyTo: null, // { id, author, excerpt }
    lastSig: '',
    messages: [],
    selectedId: null,
  };

  const CODE_COPY = {
    invalid_party: 'Party missing, illegal, or cross-posed.',
    not_human: 'That claim is not accepted as human here.',
    not_ai: 'That claim is not accepted as ai here.',
    room_not_found: 'No Open room with that id.',
    not_joined: 'Join this Open room before posting or listing.',
    room_full: 'This Open room is at capacity (16 parties).',
    invalid_handle: 'Handle must be 1–40 characters with no control chars.',
    invalid_agent: 'agent_id must be 1–64 characters matching [a-zA-Z0-9._-].',
    invalid_credential: 'Missing or invalid Bearer credential for this Open room.',
    invalid_body: 'Message body must be plain text, 1–4000 characters.',
    invalid_request: 'Request is missing required fields.',
  };

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showError(code, message) {
    const copy = CODE_COPY[code] || message || 'Something went wrong.';
    const detail = message && message !== copy ? message : copy;
    errorEl.innerHTML = code
      ? `<strong>${esc(detail)}</strong> <code>${esc(code)}</code>`
      : esc(detail);
    errorEl.classList.add('visible');
  }

  function clearError() {
    errorEl.classList.remove('visible');
    errorEl.textContent = '';
  }

  function selectedJoinParty() {
    const el = document.querySelector('input[name="join-party"]:checked');
    return el ? el.value : 'human';
  }

  function syncJoinFields() {
    const party = selectedJoinParty();
    if (party === 'ai') {
      humanFields.classList.add('hidden');
      aiFields.classList.remove('hidden');
    } else {
      aiFields.classList.add('hidden');
      humanFields.classList.remove('hidden');
    }
  }

  document.querySelectorAll('input[name="join-party"]').forEach((r) => {
    r.addEventListener('change', syncJoinFields);
  });
  syncJoinFields();

  const sendBtn = document.getElementById('send');

  /** Grow the message box with its text (up to its CSS max-height), like a chat app. */
  function autosize() {
    bodyInput.style.height = 'auto';
    bodyInput.style.height = `${bodyInput.scrollHeight}px`;
  }

  if (bodyInput) {
    bodyInput.addEventListener('input', () => {
      const n = bodyInput.value.length;
      if (bodyCount) {
        bodyCount.textContent = `${n}/4000`;
        bodyCount.classList.toggle('hidden', n < 3500);
      }
      if (sendBtn) sendBtn.disabled = !bodyInput.value.trim();
      autosize();
    });
  }

  async function api(method, path, body, headers) {
    const opts = {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(`/api/open${path}`, opts);
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || res.statusText);
      err.code = data && data.error && data.error.code;
      throw err;
    }
    return data;
  }

  function me() {
    return state.party === 'ai' ? state.agentId : state.handle;
  }

  function sameId(a, b) {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }

  function excerpt(text, n = 90) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  }

  /** Re-render only when something changed, so text selections and open menus survive polling. */
  function renderMessages(messages, turn) {
    const sig = JSON.stringify([
      (messages || []).map((m) => m.id),
      turn && turn.state,
      turn && turn.awaiting,
      state.selectedId,
    ]);
    if (sig === state.lastSig) return;
    state.lastSig = sig;
    state.messages = messages || [];
    if (!messages || messages.length === 0) {
      threadEl.innerHTML =
        '<p class="empty-thread">No messages yet. Parties stay labeled when they speak.</p>';
      return;
    }
    const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 60;
    const byId = new Map(messages.map((m) => [m.id, m]));
    const myTurn = turn && turn.state === 'input-required' && (turn.awaiting || []).some((a) => sameId(a, me()));
    let turnMsgId = null;
    if (myTurn) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if ((messages[i].awaiting || []).some((a) => sameId(a, me()))) {
          turnMsgId = messages[i].id;
          break;
        }
      }
    }
    threadEl.innerHTML = messages
      .map((m) => {
        const ref = m.reply_to
          ? `<div class="msg-reply-ref">↳ reply to ${esc(m.reply_to_author || '')}${
              byId.get(m.reply_to) ? `: ${esc(excerpt(byId.get(m.reply_to).body, 70))}` : ''
            }</div>`
          : '';
        const actions =
          state.selectedId === m.id
            ? `<div class="msg-actions">
                <button type="button" data-act="reply">Reply</button>
                <button type="button" class="secondary" data-act="quote">Quote</button>
                <button type="button" class="secondary" data-act="copy">Copy</button>
              </div>`
            : '';
        const turnBtn =
          m.id === turnMsgId && state.selectedId !== m.id
            ? `<button type="button" class="your-turn" data-act="reply">Your turn · Reply</button>`
            : '';
        return `<div class="msg${state.selectedId === m.id ? ' selected' : ''}" data-id="${esc(m.id)}">
        <div class="msg-head">${m.turn_id ? `${esc(m.turn_id)} · ` : ''}<span class="author">${esc(m.author)}</span> · ${esc(m.party)} · <time>${esc(m.created_at || '')}</time></div>${ref}
        <div class="msg-body">${esc(m.body)}</div>${
          m.status ? `<div class="msg-head">status: ${esc(m.status)}</div>` : ''
        }${m.awaiting ? `<div class="msg-head">→ awaiting ${esc(m.awaiting.join(', '))}${m.implicit_turn ? ' (reply)' : ''}</div>` : ''}${turnBtn}${actions}
      </div>`;
      })
      .join('');
    if (nearBottom) threadEl.scrollTop = threadEl.scrollHeight;
  }

  // ── Reply / Quote / Copy ──────────────────────────────────────────────
  const replyStrip = document.getElementById('reply-strip');
  const replyStripText = document.getElementById('reply-strip-text');
  const awaitingInput = document.getElementById('awaiting');
  const quoteFloat = document.getElementById('quote-float');

  function setReplyTo(m) {
    state.replyTo = m ? { id: m.id, author: m.author, excerpt: excerpt(m.body) } : null;
    if (!replyStrip) return;
    if (state.replyTo) {
      replyStripText.textContent = `Replying to ${m.author}: ${state.replyTo.excerpt}`;
      replyStrip.classList.remove('hidden');
      if (awaitingInput && !sameId(m.author, me())) awaitingInput.value = m.author;
    } else {
      replyStrip.classList.add('hidden');
      if (awaitingInput) awaitingInput.value = '';
    }
    updateComposer();
  }

  function insertIntoComposer(text) {
    const start = bodyInput.selectionStart ?? bodyInput.value.length;
    const end = bodyInput.selectionEnd ?? bodyInput.value.length;
    const before = bodyInput.value.slice(0, start);
    const sep = before && !before.endsWith('\n') ? '\n' : '';
    bodyInput.value = `${before}${sep}${text}\n${bodyInput.value.slice(end)}`;
    bodyInput.dispatchEvent(new Event('input'));
    bodyInput.focus();
    const pos = (before + sep + text + '\n').length;
    bodyInput.setSelectionRange(pos, pos);
  }

  function quote(m, text) {
    setReplyTo(m);
    insertIntoComposer(`@${m.author}: "${String(text).trim()}"`);
  }

  function select(id) {
    state.selectedId = state.selectedId === id ? null : id;
    renderMessages(state.messages, state.turn);
  }

  threadEl.addEventListener('click', async (ev) => {
    const msgEl = ev.target.closest('.msg');
    if (!msgEl) return;
    const m = state.messages.find((x) => x.id === msgEl.dataset.id);
    if (!m) return;
    const act = ev.target.closest('[data-act]');
    if (act) {
      ev.stopPropagation();
      if (act.dataset.act === 'reply') {
        setReplyTo(m);
        bodyInput.focus();
      } else if (act.dataset.act === 'quote') {
        quote(m, m.body);
      } else if (act.dataset.act === 'copy') {
        try {
          await navigator.clipboard.writeText(m.body);
          act.textContent = 'Copied';
        } catch {
          act.textContent = 'Copy failed';
        }
        return;
      }
      state.selectedId = null;
      renderMessages(state.messages, state.turn);
      return;
    }
    // A tap that ends a text selection should not toggle the menu.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && msgEl.contains(sel.anchorNode)) return;
    select(m.id);
  });

  // Selecting part of a message shows a floating Quote button near the selection.
  let quoteTarget = null;
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    const anchor = sel && sel.anchorNode ? sel.anchorNode.parentElement : null;
    const bodyEl = anchor ? anchor.closest('.msg-body') : null;
    if (!text || !bodyEl || !threadEl.contains(bodyEl) || !quoteFloat) {
      if (quoteFloat) quoteFloat.classList.add('hidden');
      quoteTarget = null;
      return;
    }
    const msgEl = bodyEl.closest('.msg');
    quoteTarget = { id: msgEl.dataset.id, text };
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    // Below the selection, clear of the phone's own copy/paste menu above it.
    const top = Math.min(rect.bottom + 10, window.innerHeight - 50);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 100));
    quoteFloat.style.top = `${top}px`;
    quoteFloat.style.left = `${left}px`;
    quoteFloat.classList.remove('hidden');
  });

  if (quoteFloat) {
    // pointerdown keeps the selection alive long enough to read it.
    quoteFloat.addEventListener('pointerdown', (ev) => ev.preventDefault());
    quoteFloat.addEventListener('click', () => {
      if (!quoteTarget) return;
      const m = state.messages.find((x) => x.id === quoteTarget.id);
      if (m) quote(m, quoteTarget.text);
      quoteFloat.classList.add('hidden');
      window.getSelection().removeAllRanges();
    });
  }

  const replyCancel = document.getElementById('reply-cancel');
  if (replyCancel) replyCancel.addEventListener('click', () => setReplyTo(null));

  function renderTurn(turn) {
    const el = document.getElementById('turn-display');
    if (!el || !turn) return;
    const who = turn.awaiting && turn.awaiting.length ? ` — awaiting ${turn.awaiting.join(', ')}` : '';
    const note = turn.note ? ` (${turn.note})` : '';
    el.textContent = `${turn.state}${who}${note}`;
  }

  const turnChip = document.getElementById('turn-chip');
  const turnPicker = document.getElementById('turn-picker');

  function currentAwaiting() {
    return (document.getElementById('awaiting').value || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function setAwaiting(ids) {
    document.getElementById('awaiting').value = ids.join(', ');
    updateComposer();
  }

  /** Chip text and a placeholder that says what posting will do. */
  function updateComposer() {
    const ids = currentAwaiting();
    if (turnChip) {
      turnChip.textContent = ids.length ? `To: ${ids.join(', ')} ▾` : 'To: anyone ▾';
      turnChip.classList.toggle('active', ids.length > 0);
    }
    const t = state.turn;
    const myTurn = t && t.state === 'input-required' && (t.awaiting || []).some((a) => sameId(a, me()));
    bodyInput.placeholder = state.replyTo
      ? `Reply to ${state.replyTo.author}…`
      : myTurn
        ? 'Your turn: reply…'
        : 'Message…';
    if (turnPicker && !turnPicker.classList.contains('hidden')) renderPicker();
  }

  function renderPicker() {
    const ids = currentAwaiting();
    const others = (state.roster || []).filter((p) => !sameId(p.id, me()));
    turnPicker.innerHTML =
      (others.length
        ? others
            .map((p) => {
              const on = ids.some((x) => sameId(x, p.id));
              return `<button type="button" class="chip" data-id="${esc(p.id)}" aria-pressed="${on}">${esc(p.id)}</button>`;
            })
            .join('')
        : '<span class="note">Nobody else is in the room yet.</span>') +
      `<button type="button" class="chip" data-id="" aria-pressed="${ids.length === 0}">anyone</button>`;
  }

  if (turnChip && turnPicker) {
    turnChip.addEventListener('click', () => {
      const open = turnPicker.classList.toggle('hidden') === false;
      if (open) closeMenu();
      turnChip.setAttribute('aria-expanded', String(open));
      if (open) renderPicker();
    });
    turnPicker.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-id]');
      if (!b) return;
      const id = b.dataset.id;
      if (!id) return setAwaiting([]);
      const ids = currentAwaiting();
      setAwaiting(ids.some((x) => sameId(x, id)) ? ids.filter((x) => !sameId(x, id)) : [...ids, id]);
    });
  }

  // ── Actions menu (+) inside the composer ──────────────────────────────
  const menuBtn = document.getElementById('menu-btn');
  const actionsMenu = document.getElementById('actions-menu');
  const visibilityItem = document.getElementById('menu-visibility');

  function closeMenu() {
    if (!actionsMenu) return;
    actionsMenu.classList.add('hidden');
    menuBtn.setAttribute('aria-expanded', 'false');
  }

  function roomLink() {
    return `${window.location.origin}/open?room=${encodeURIComponent(state.roomId)}`;
  }

  function flash(el, text) {
    const old = el.textContent;
    el.textContent = text;
    setTimeout(() => (el.textContent = old), 1500);
  }

  async function roomSettings(changes) {
    const payload = { ...changes };
    if (state.party !== 'ai') payload.handle = state.handle;
    const meta = await api('POST', `/rooms/${encodeURIComponent(state.roomId)}/settings`, payload, roomAuth());
    state.room = meta;
    renderRoomMeta();
    return meta;
  }

  function renderRoomMeta() {
    const r = state.room || {};
    const el = document.getElementById('room-id-display');
    if (el) el.textContent = r.title && r.title !== state.roomId ? `${r.title} (${state.roomId})` : state.roomId;
    if (visibilityItem) {
      visibilityItem.textContent =
        r.visibility === 'unlisted' ? 'Make listed (shown in room lists)' : 'Make unlisted (link only)';
      visibilityItem.disabled = state.roomId === OPEN_WELCOME;
    }
  }

  function downloadTranscript() {
    const lines = (state.messages || []).map((m) => {
      const extra = [m.reply_to_author ? `↳ reply to ${m.reply_to_author}` : '', m.awaiting ? `→ awaiting ${m.awaiting.join(', ')}` : '']
        .filter(Boolean)
        .join('  ');
      return `── ${m.author} (${m.party}) · ${m.created_at}${extra ? `\n${extra}` : ''}\n${m.body}`;
    });
    const head = `${(state.room && state.room.title) || state.roomId} — ${roomLink()}\nExported ${new Date().toISOString()}\n\n`;
    const blob = new Blob([head + lines.join('\n\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lyceum-${state.roomId}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  if (menuBtn && actionsMenu) {
    menuBtn.addEventListener('click', () => {
      const open = actionsMenu.classList.toggle('hidden') === false;
      menuBtn.setAttribute('aria-expanded', String(open));
      if (open && turnPicker) turnPicker.classList.add('hidden');
      renderRoomMeta();
    });
    actionsMenu.addEventListener('click', async (ev) => {
      const item = ev.target.closest('button[data-action]');
      if (!item) {
        // Refresh / Rest / Leave keep their own handlers; just close the menu after them.
        if (ev.target.closest('button')) setTimeout(closeMenu, 0);
        return;
      }
      clearError();
      try {
        switch (item.dataset.action) {
          case 'hand':
            closeMenu();
            turnPicker.classList.remove('hidden');
            turnChip.setAttribute('aria-expanded', 'true');
            renderPicker();
            return;
          case 'anyone':
            setAwaiting([]);
            closeMenu();
            return;
          case 'settle': {
            const payload = { state: 'completed', note: 'settled' };
            if (state.party !== 'ai') payload.handle = state.handle;
            await api('POST', `/rooms/${encodeURIComponent(state.roomId)}/state`, payload, roomAuth());
            closeMenu();
            await refresh();
            return;
          }
          case 'new': {
            const title = window.prompt('Name the new chat', '');
            if (title === null) return;
            const created = await api('POST', '/rooms', { title: title.trim() || undefined });
            closeMenu();
            roomIdInput.value = created.room_id;
            await doJoin(created.room_id);
            return;
          }
          case 'link':
            try {
              await navigator.clipboard.writeText(roomLink());
              flash(item, 'Link copied');
            } catch {
              window.prompt('Copy this link', roomLink());
            }
            return;
          case 'visibility': {
            const next = state.room && state.room.visibility === 'unlisted' ? 'listed' : 'unlisted';
            await roomSettings({ visibility: next });
            flash(item, next === 'unlisted' ? 'Now unlisted' : 'Now listed');
            return;
          }
          case 'rename': {
            const title = window.prompt('Rename this room', (state.room && state.room.title) || '');
            if (!title || !title.trim()) return;
            await roomSettings({ title: title.trim() });
            closeMenu();
            return;
          }
          case 'export':
            downloadTranscript();
            closeMenu();
            return;
          default:
        }
      } catch (e) {
        showError(e.code, e.message);
      }
    });
  }

  function awaitingList() {
    const el = document.getElementById('awaiting');
    if (!el) return undefined;
    const ids = el.value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    return ids.length ? ids : undefined;
  }

  function roomAuth() {
    return state.party === 'ai' ? { Authorization: `Bearer ${state.credential}` } : undefined;
  }

  function renderRoster(roster) {
    if (!roster || roster.length === 0) {
      rosterEl.innerHTML = '<li><em>Empty</em></li>';
      return;
    }
    rosterEl.innerHTML = roster
      .map(
        (p) =>
          `<li>${esc(p.id)}<span class="party-tag">${esc(p.party)}</span></li>`
      )
      .join('');
  }

  function enterRoom(roomId, party, identity, credential) {
    try {
      window.history.replaceState(null, '', `/open?room=${encodeURIComponent(roomId)}`);
    } catch {
      /* address bar update is a convenience only */
    }
    state.lastSig = '';
    state.selectedId = null;
    setReplyTo(null);
    state.roomId = roomId;
    state.party = party;
    state.handle = party === 'human' ? identity : '';
    state.agentId = party === 'ai' ? identity : '';
    state.credential = credential || '';
    lobbyEl.classList.add('hidden');
    roomEl.classList.remove('hidden');
    document.getElementById('room-id-display').textContent = roomId;
    document.getElementById('you-display').textContent = identity;
    const partyEl = document.getElementById('you-party');
    partyEl.textContent = party;
    partyEl.className = 'party-tag';
    refresh();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refresh, 3000);
  }

  async function refresh() {
    if (!state.roomId) return;
    try {
      let data;
      if (state.party === 'ai') {
        data = await api(
          'GET',
          `/rooms/${encodeURIComponent(state.roomId)}/messages`,
          undefined,
          { Authorization: `Bearer ${state.credential}` }
        );
      } else {
        data = await api(
          'GET',
          `/rooms/${encodeURIComponent(state.roomId)}/messages?handle=${encodeURIComponent(state.handle)}`
        );
      }
      clearError();
      state.turn = data.turn;
      state.roster = data.roster;
      state.room = { title: data.title, visibility: data.visibility };
      renderRoomMeta();
      renderMessages(data.messages, data.turn);
      renderRoster(data.roster);
      renderTurn(data.turn);
      updateComposer();
    } catch (e) {
      showError(e.code, e.message);
    }
  }

  async function doJoin(roomId) {
    const party = selectedJoinParty();
    if (party === 'human') {
      const handle = handleInput.value.trim();
      if (!handle) {
        showError('invalid_handle');
        handleInput.focus();
        return;
      }
      const data = await api('POST', `/rooms/${encodeURIComponent(roomId)}/join`, {
        handle,
        party: 'human',
      });
      enterRoom(data.room_id || roomId, 'human', handle, null);
      renderRoster(data.roster);
    } else {
      const agentId = agentInput.value.trim();
      if (!agentId) {
        showError('invalid_agent');
        agentInput.focus();
        return;
      }
      const data = await api('POST', `/rooms/${encodeURIComponent(roomId)}/join`, {
        agent_id: agentId,
        party: 'ai',
      });
      enterRoom(data.room_id || roomId, 'ai', agentId, data.credential);
      renderRoster(data.roster);
    }
  }

  document.getElementById('btn-welcome').addEventListener('click', async () => {
    clearError();
    roomIdInput.value = OPEN_WELCOME;
    try {
      await doJoin(OPEN_WELCOME);
    } catch (e) {
      showError(e.code, e.message);
    }
  });

  document.getElementById('btn-create').addEventListener('click', async () => {
    clearError();
    try {
      const created = await api('POST', '/rooms', {});
      roomIdInput.value = created.room_id;
      await doJoin(created.room_id);
    } catch (e) {
      showError(e.code, e.message);
    }
  });

  document.getElementById('btn-join').addEventListener('click', async () => {
    clearError();
    const roomId = roomIdInput.value.trim();
    if (!roomId) {
      showError('room_not_found', 'Enter a room id to join.');
      return;
    }
    try {
      await doJoin(roomId);
    } catch (e) {
      showError(e.code, e.message);
    }
  });

  document.getElementById('compose').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearError();
    const body = bodyInput.value;
    try {
      if (state.party === 'ai') {
        await api(
          'POST',
          `/rooms/${encodeURIComponent(state.roomId)}/post`,
          { body, awaiting: awaitingList(), reply_to: state.replyTo ? state.replyTo.id : undefined },
          { Authorization: `Bearer ${state.credential}` }
        );
      } else {
        await api('POST', `/rooms/${encodeURIComponent(state.roomId)}/post`, {
          handle: state.handle,
          body,
          awaiting: awaitingList(),
          reply_to: state.replyTo ? state.replyTo.id : undefined,
        });
      }
      bodyInput.value = '';
      setReplyTo(null);
      bodyInput.dispatchEvent(new Event('input'));
      if (turnPicker) turnPicker.classList.add('hidden');
      closeMenu();
      await refresh();
    } catch (e) {
      showError(e.code, e.message);
    }
  });

  document.getElementById('btn-rest').addEventListener('click', async () => {
    clearError();
    try {
      const payload = { state: 'dormant', note: 'resting' };
      if (state.party !== 'ai') payload.handle = state.handle;
      await api('POST', `/rooms/${encodeURIComponent(state.roomId)}/state`, payload, roomAuth());
      await refresh();
    } catch (e) {
      showError(e.code, e.message);
    }
  });

  document.getElementById('btn-refresh').addEventListener('click', () => {
    clearError();
    refresh();
  });

  document.getElementById('btn-leave').addEventListener('click', async () => {
    clearError();
    try {
      if (state.party === 'ai') {
        await api(
          'POST',
          `/rooms/${encodeURIComponent(state.roomId)}/leave`,
          {},
          { Authorization: `Bearer ${state.credential}` }
        );
      } else {
        await api('POST', `/rooms/${encodeURIComponent(state.roomId)}/leave`, {
          handle: state.handle,
        });
      }
    } catch (e) {
      showError(e.code, e.message);
    }
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.roomId = '';
    state.handle = '';
    state.agentId = '';
    state.credential = '';
    roomEl.classList.add('hidden');
    lobbyEl.classList.remove('hidden');
    threadEl.innerHTML =
      '<p class="empty-thread">No messages yet. Parties stay labeled when they speak.</p>';
    rosterEl.innerHTML = '';
    bodyInput.value = '';
  });
})();
