(function () {
  const WELCOME_ROOM_ID = 'welcome';

  const errorEl = document.getElementById('error');
  const lobby = document.getElementById('lobby');
  const roomEl = document.getElementById('room');
  const topicShelf = document.getElementById('topic-shelf');
  const topicList = document.getElementById('topic-list');
  const handleInput = document.getElementById('handle');
  const roomIdInput = document.getElementById('room-id');
  const threadEl = document.getElementById('thread');
  const rosterList = document.getElementById('roster-list');
  const bodyInput = document.getElementById('body');
  const guestbookEl = document.querySelector('.guestbook-lobby');
  const lineageEl = document.getElementById('lineage');
  const roomTitleWrap = document.getElementById('room-title-wrap');
  const roomTitleDisplay = document.getElementById('room-title-display');
  const mergeTargetInput = document.getElementById('merge-target');

  const state = {
    handle: '',
    roomId: '',
    title: '',
    parentId: null,
    mergedInto: null,
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
    already_merged: 'This room was already merged into another.',
    cannot_merge_self: 'A room cannot merge into itself.',
    cannot_merge_welcome: 'The welcome lobby cannot be merged away.',
    room_merged: 'This room was merged; join the target room instead.',
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

  function setLobbyVisible(visible) {
    if (visible) {
      lobby.classList.remove('hidden');
      if (topicShelf) topicShelf.classList.remove('hidden');
      if (guestbookEl) guestbookEl.classList.remove('hidden');
    } else {
      lobby.classList.add('hidden');
      if (topicShelf) topicShelf.classList.add('hidden');
      if (guestbookEl) guestbookEl.classList.add('hidden');
    }
  }

  function renderLineage() {
    if (!lineageEl) return;
    const parts = [];
    if (state.title) {
      if (roomTitleWrap) roomTitleWrap.classList.remove('hidden');
      if (roomTitleDisplay) roomTitleDisplay.textContent = state.title;
    } else if (roomTitleWrap) {
      roomTitleWrap.classList.add('hidden');
    }
    if (state.parentId) {
      parts.push(
        `Branched from <button type="button" class="linkish" data-goto-room="${escapeHtml(
          state.parentId
        )}">${escapeHtml(state.parentId)}</button>`
      );
    }
    if (state.mergedInto) {
      parts.push(
        `Merged into <button type="button" class="linkish" data-goto-room="${escapeHtml(
          state.mergedInto
        )}">${escapeHtml(state.mergedInto)}</button>`
      );
    }
    if (parts.length === 0) {
      lineageEl.classList.add('hidden');
      lineageEl.innerHTML = '';
      return;
    }
    lineageEl.classList.remove('hidden');
    lineageEl.innerHTML = parts.join(' · ');
  }

  function enterRoom(roomId, handle, meta) {
    state.roomId = roomId;
    state.handle = handle;
    state.title = (meta && meta.title) || '';
    state.parentId = (meta && meta.parent_id) || null;
    state.mergedInto = (meta && meta.merged_into) || null;
    setLobbyVisible(false);
    roomEl.classList.remove('hidden');
    document.getElementById('room-id-display').textContent = roomId;
    document.getElementById('you-display').textContent = handle;
    renderLineage();
    threadEl.innerHTML = `<p class="empty-thread">${emptyThreadCopy(roomId)}</p>`;
    refresh();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refresh, 4000);
  }

  function leaveUi() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.roomId = '';
    state.title = '';
    state.parentId = null;
    state.mergedInto = null;
    roomEl.classList.add('hidden');
    setLobbyVisible(true);
    threadEl.innerHTML = '<p class="empty-thread">No messages yet. The floor is open.</p>';
    rosterList.innerHTML = '';
    bodyInput.value = '';
    if (mergeTargetInput) mergeTargetInput.value = '';
    renderLineage();
    loadTopics();
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

  function topicStateLabel(topic) {
    if (topic.merged_into) return `merged → ${topic.merged_into}`;
    const roster = topic.roster_count || 0;
    if (roster === 0) return 'empty';
    if (roster === 1) return '1 person';
    return `${roster} people`;
  }

  function renderTopics(topics) {
    if (!topicList) return;
    if (!topics || topics.length === 0) {
      topicList.innerHTML = '<li class="topic-shelf-empty">No topic rooms yet.</li>';
      return;
    }
    topicList.innerHTML = topics
      .map((t) => {
        return `<li class="topic-row" data-topic-id="${escapeHtml(t.id)}">
          <div class="topic-meta">
            <span class="topic-title">${escapeHtml(t.title)}</span>
            <span class="topic-state">${escapeHtml(topicStateLabel(t))}</span>
          </div>
          <button type="button" class="secondary topic-enter" data-enter-topic="${escapeHtml(t.id)}">Enter</button>
        </li>`;
      })
      .join('');
  }

  async function loadTopics() {
    if (!topicList) return;
    try {
      const data = await api('/topics');
      renderTopics(data.topics || []);
    } catch (err) {
      topicList.innerHTML =
        '<li class="topic-shelf-empty">Could not load topic rooms.</li>';
    }
  }

  async function refresh() {
    if (!state.roomId) return;
    try {
      const data = await api(
        `/rooms/${encodeURIComponent(state.roomId)}/messages?handle=${encodeURIComponent(state.handle)}`
      );
      clearError();
      state.title = data.title || state.title;
      state.parentId = data.parent_id || null;
      state.mergedInto = data.merged_into || null;
      renderLineage();
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
    const data = await api(`/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      body: JSON.stringify({ handle, party: 'human' }),
    });
    enterRoom(roomId, handle, data);
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

  if (topicList) {
    topicList.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-enter-topic]');
      if (!btn) return;
      clearError();
      const handle = requireHandle();
      if (!handle) return;
      const roomId = btn.getAttribute('data-enter-topic');
      try {
        await joinRoom(roomId, handle);
      } catch (err) {
        showError(err.code, err.message);
      }
    });
  }

  if (lineageEl) {
    lineageEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-goto-room]');
      if (!btn) return;
      clearError();
      const handle = state.handle || requireHandle();
      if (!handle) return;
      try {
        await joinRoom(btn.getAttribute('data-goto-room'), handle);
      } catch (err) {
        showError(err.code, err.message);
      }
    });
  }

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

  const btnBranch = document.getElementById('btn-branch');
  if (btnBranch) {
    btnBranch.addEventListener('click', async () => {
      clearError();
      if (!state.roomId || !state.handle) return;
      try {
        const data = await api(`/rooms/${encodeURIComponent(state.roomId)}/branch`, {
          method: 'POST',
          body: JSON.stringify({ handle: state.handle, party: 'human' }),
        });
        enterRoom(data.room_id, state.handle, data);
      } catch (err) {
        showError(err.code, err.message);
      }
    });
  }

  const btnMerge = document.getElementById('btn-merge');
  if (btnMerge) {
    btnMerge.addEventListener('click', async () => {
      clearError();
      if (!state.roomId || !state.handle) return;
      const targetId = mergeTargetInput ? mergeTargetInput.value.trim() : '';
      if (!targetId) {
        showError('invalid_request', 'Enter a target room id to merge into.');
        return;
      }
      try {
        const data = await api(`/rooms/${encodeURIComponent(state.roomId)}/merge`, {
          method: 'POST',
          body: JSON.stringify({
            handle: state.handle,
            party: 'human',
            target_id: targetId,
          }),
        });
        await joinRoom(data.target.room_id, state.handle);
      } catch (err) {
        showError(err.code, err.message);
      }
    });
  }

  document.getElementById('btn-leave').addEventListener('click', async () => {
    clearError();
    try {
      await api(`/rooms/${encodeURIComponent(state.roomId)}/leave`, {
        method: 'POST',
        body: JSON.stringify({ handle: state.handle, party: 'human' }),
      });
    } catch (err) {
      showError(err.code, err.message);
    }
    leaveUi();
  });

  try {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room === WELCOME_ROOM_ID) {
      roomIdInput.value = WELCOME_ROOM_ID;
      handleInput.focus();
    } else if (room && room.indexOf('topic-') === 0) {
      roomIdInput.value = room;
      handleInput.focus();
    }
  } catch (_) {
    /* ignore */
  }

  loadTopics();
})();
