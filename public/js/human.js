(function () {
  const WELCOME_ROOM_ID = 'welcome';

  const errorEl = document.getElementById('error');
  const lobby = document.getElementById('lobby');
  const roomEl = document.getElementById('room');
  const handleInput = document.getElementById('handle');
  const roomIdInput = document.getElementById('room-id');
  const threadEl = document.getElementById('thread');
  const rosterList = document.getElementById('roster-list');
  const bodyInput = document.getElementById('body');

  const state = {
    handle: '',
    roomId: '',
    pollTimer: null,
  };

  const ERROR_PLAIN = {
    not_human: 'Human stream refuses AI or machine parties.',
    room_not_found: 'No Human room with that id.',
    not_joined: 'Join this room before posting.',
    room_full: 'This Human room is at capacity (16 parties).',
    invalid_handle: 'Handle must be 1–40 characters with no control chars.',
    invalid_body: 'Message body must be 1–4000 characters of plain text.',
    invalid_request: 'Request is missing required fields (including party: "human").',
  };

  function showError(code, fallback) {
    const msg = ERROR_PLAIN[code] || fallback || 'Something went wrong.';
    errorEl.innerHTML = code
      ? `<strong>${escapeHtml(msg)}</strong> <code>${escapeHtml(code)}</code>`
      : escapeHtml(msg);
    errorEl.classList.add('visible');
  }

  function clearError() {
    errorEl.classList.remove('visible');
    errorEl.textContent = '';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function api(path, options) {
    const res = await fetch(`/api/human${path}`, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...options,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const code = data && data.error && data.error.code;
      const message = data && data.error && data.error.message;
      const err = new Error(message || res.statusText);
      err.code = code;
      throw err;
    }
    return data;
  }

  function emptyThreadCopy(roomId) {
    if (roomId === WELCOME_ROOM_ID) {
      return 'No messages yet. The floor is open.';
    }
    return 'No messages yet.';
  }

  function enterRoom(roomId, handle) {
    state.roomId = roomId;
    state.handle = handle;
    lobby.classList.add('hidden');
    roomEl.classList.remove('hidden');
    document.getElementById('room-id-display').textContent = roomId;
    document.getElementById('you-display').textContent = handle;
    threadEl.innerHTML = `<p class="empty-thread">${emptyThreadCopy(roomId)}</p>`;
    refresh();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refresh, 4000);
  }

  function leaveUi() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.roomId = '';
    roomEl.classList.add('hidden');
    lobby.classList.remove('hidden');
    threadEl.innerHTML = '<p class="empty-thread">No messages yet. The floor is open.</p>';
    rosterList.innerHTML = '';
    bodyInput.value = '';
  }

  function renderMessages(messages) {
    if (!messages || messages.length === 0) {
      threadEl.innerHTML = `<p class="empty-thread">${emptyThreadCopy(state.roomId)}</p>`;
      return;
    }
    threadEl.innerHTML = messages
      .map((m) => {
        const when = m.created_at ? new Date(m.created_at).toLocaleString() : '';
        return `<article class="msg">
          <div class="msg-head"><span class="author">${escapeHtml(m.author)}</span> · human · ${escapeHtml(when)}</div>
          <div class="msg-body">${escapeHtml(m.body)}</div>
        </article>`;
      })
      .join('');
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  function renderRoster(roster) {
    if (!roster || roster.length === 0) {
      rosterList.innerHTML = '<li><em>Empty</em></li>';
      return;
    }
    rosterList.innerHTML = roster
      .map(
        (p) =>
          `<li>${escapeHtml(p.handle)}<span class="party-tag">${escapeHtml(p.party || 'human')}</span></li>`
      )
      .join('');
  }

  async function refresh() {
    if (!state.roomId) return;
    try {
      const data = await api(
        `/rooms/${encodeURIComponent(state.roomId)}/messages?handle=${encodeURIComponent(state.handle)}`
      );
      clearError();
      renderMessages(data.messages);
      renderRoster(data.roster);
    } catch (err) {
      showError(err.code, err.message);
    }
  }

  function requireHandle() {
    const handle = handleInput.value.trim();
    if (!handle) {
      showError('invalid_handle');
      handleInput.focus();
      return null;
    }
    return handle;
  }

  async function joinRoom(roomId, handle) {
    await api(`/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      body: JSON.stringify({ handle, party: 'human' }),
    });
    enterRoom(roomId, handle);
  }

  document.getElementById('btn-welcome').addEventListener('click', async () => {
    clearError();
    const handle = requireHandle();
    if (!handle) return;
    try {
      await joinRoom(WELCOME_ROOM_ID, handle);
    } catch (err) {
      showError(err.code, err.message);
    }
  });

  document.getElementById('btn-create').addEventListener('click', async () => {
    clearError();
    const handle = requireHandle();
    if (!handle) return;
    try {
      const created = await api('/rooms', { method: 'POST', body: JSON.stringify({}) });
      await joinRoom(created.room_id, handle);
    } catch (err) {
      showError(err.code, err.message);
    }
  });

  document.getElementById('btn-join').addEventListener('click', async () => {
    clearError();
    const handle = requireHandle();
    if (!handle) return;
    const roomId = roomIdInput.value.trim();
    if (!roomId) {
      showError('room_not_found', 'Enter a room id to join.');
      return;
    }
    try {
      await joinRoom(roomId, handle);
    } catch (err) {
      showError(err.code, err.message);
    }
  });

  document.getElementById('compose').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const body = bodyInput.value;
    try {
      await api(`/rooms/${encodeURIComponent(state.roomId)}/post`, {
        method: 'POST',
        body: JSON.stringify({ handle: state.handle, body, party: 'human' }),
      });
      bodyInput.value = '';
      await refresh();
    } catch (err) {
      showError(err.code, err.message);
    }
  });

  document.getElementById('btn-refresh').addEventListener('click', () => {
    clearError();
    refresh();
  });

  document.getElementById('btn-leave').addEventListener('click', async () => {
    clearError();
    try {
      await api(`/rooms/${encodeURIComponent(state.roomId)}/leave`, {
        method: 'POST',
        body: JSON.stringify({ handle: state.handle, party: 'human' }),
      });
    } catch (err) {
      // still leave UI
      showError(err.code, err.message);
    }
    leaveUi();
  });

  // Deep link from home: /human?room=welcome focuses the arrival path.
  try {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room === WELCOME_ROOM_ID) {
      roomIdInput.value = WELCOME_ROOM_ID;
      handleInput.focus();
    }
  } catch (_) {
    /* ignore */
  }
})();
