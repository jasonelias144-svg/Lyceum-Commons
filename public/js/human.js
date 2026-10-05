/* Human room client — format face via /js/human-format-face.js (window.LyceumHumanFormat).
 *
 * Guest identity (same model as Open, see /guests): the first join gives this browser a guest
 * key. It is kept in localStorage with the name and room you are seated in, sent as
 * X-Lyceum-Guest on every call, and never shown on the page. A reload re-seats you under the
 * same name with that key. Idle seats expire on the server (presence TTL); this page does not
 * leave on tab close. Leave clears the stored seat. If a poll or post gets not_joined (seat
 * expired, or another tab left), we rejoin once with the stored key and retry once.
 */
(function () {
  const WELCOME = 'welcome';
  const GUEST_KEY = 'lyceum.human.guest';
  const SEAT_KEY = 'lyceum.human.seat';
  const Format = window.LyceumHumanFormat;

  const errorEl = document.getElementById('error');
  const lobbyEl = document.getElementById('lobby');
  const roomEl = document.getElementById('room');
  const topicShelfEl = document.getElementById('topic-shelf');
  const topicListEl = document.getElementById('topic-list');
  const handleInput = document.getElementById('handle');
  const roomIdInput = document.getElementById('room-id');
  const threadEl = document.getElementById('thread');
  const rosterEl = document.getElementById('roster-list');
  const bodyInput = document.getElementById('body');
  const bodyCountEl = document.getElementById('body-count');
  const formatHintEl = document.getElementById('format-hint');
  const formatDisplayEl = document.getElementById('format-display');
  const composeHeadingEl = document.getElementById('compose-heading');
  const mergeRowEl = document.getElementById('merge-row');
  const guestbookEl = document.querySelector('.guestbook-lobby');
  const lineageEl = document.getElementById('lineage');
  const titleWrapEl = document.getElementById('room-title-wrap');
  const titleDisplayEl = document.getElementById('room-title-display');
  const mergeTargetInput = document.getElementById('merge-target');

  const faceEls = {
    roomEl,
    formatDisplayEl,
    bodyInput,
    composeHeadingEl,
    formatHintEl,
    mergeRowEl,
    threadEl,
    bodyCountEl,
  };

  const state = {
    handle: '',
    roomId: '',
    title: '',
    parentId: null,
    mergedInto: null,
    format: 'board',
    pollTimer: null,
  };

  const ERROR_COPY = {
    not_human: 'Human stream refuses AI or machine parties.',
    room_not_found: 'No Human room with that id.',
    not_joined: 'Join this room before posting.',
    room_full: 'This Human room is at capacity (16 parties).',
    invalid_handle: 'Handle must be 1–40 characters with no control chars.',
    invalid_body: 'Message body must be plain text within the room format limit.',
    invalid_request: 'Request is missing required fields (including party: "human").',
    already_merged: 'This room was already merged into another.',
    cannot_merge_self: 'A room cannot merge into itself.',
    cannot_merge_welcome: 'The welcome lobby cannot be merged away.',
    cannot_merge_into_welcome: 'Rooms cannot be merged into the welcome lobby.',
    cannot_merge_root: 'Seeded root topic rooms cannot be merged away.',
    room_merged: 'This room was merged; join the target room instead.',
    handle_taken: 'That name, or one that looks the same, is already taken in this room. Pick another name.',
    guest_key_required:
      'This browser has no guest key for that name. Join with it again to get one; if someone else holds it, pick another name.',
    guest_name_limit:
      'One guest key can hold up to 5 names. Use a name you already have, or leave every room where you use one to free it.',
  };

  /* ---------- Guest key and seat (localStorage; private mode falls back to this page) ---------- */

  let pageGuestKey = '';
  let pageSeat = null;

  function guestKey() {
    try {
      return localStorage.getItem(GUEST_KEY) || pageGuestKey;
    } catch (_) {
      return pageGuestKey;
    }
  }

  function saveGuestKey(key) {
    pageGuestKey = key;
    try {
      localStorage.setItem(GUEST_KEY, key);
    } catch (_) {
      /* private mode: the key lasts as long as this page */
    }
  }

  function loadSeat() {
    try {
      const seat = JSON.parse(localStorage.getItem(SEAT_KEY) || 'null');
      if (seat && typeof seat.handle === 'string') return seat;
    } catch (_) {
      /* storage unavailable */
    }
    return pageSeat;
  }

  /** Remember the name, and the room it is seated in ('' once you leave). */
  function saveSeat(handle, roomId) {
    pageSeat = { handle, roomId: roomId || '' };
    try {
      localStorage.setItem(SEAT_KEY, JSON.stringify(pageSeat));
    } catch (_) {
      /* storage unavailable */
    }
  }

  /* ---------- Errors ---------- */

  function showError(code, message) {
    const copy = ERROR_COPY[code] || message || 'Something went wrong.';
    const text = message && message !== copy ? message : copy;
    errorEl.innerHTML = code ? `<strong>${esc(text)}</strong> <code>${esc(code)}</code>` : esc(text);
    errorEl.classList.add('visible');
  }

  function clearError() {
    errorEl.classList.remove('visible');
    errorEl.textContent = '';
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- API ---------- */

  async function api(path, opts) {
    const key = guestKey();
    const res = await fetch(`/api/human${path}`, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(key ? { 'X-Lyceum-Guest': key } : {}),
      },
      ...opts,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    // Only the join that minted a key returns it; keep it for every later call.
    if (data && typeof data.guest_key === 'string') saveGuestKey(data.guest_key);
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || res.statusText);
      err.code = data && data.error && data.error.code;
      throw err;
    }
    return data;
  }

  /** Seat-gone responses: rejoin once with the stored key, then retry the action once. */
  function seatGone(err) {
    return Boolean(err && (err.code === 'not_joined' || err.code === 'guest_key_required'));
  }

  /**
   * Rejoin the stored room with the stored key. Does not clear the seat on failure.
   * Returns true when the join succeeded.
   */
  async function silentRejoin() {
    const seat = loadSeat();
    if (!seat || !seat.handle || !seat.roomId) return false;
    if (!guestKey()) return false;
    try {
      await api(`/rooms/${encodeURIComponent(seat.roomId)}/join`, {
        method: 'POST',
        body: JSON.stringify({ handle: seat.handle, party: 'human' }),
      });
      state.roomId = seat.roomId;
      state.handle = seat.handle;
      saveSeat(seat.handle, seat.roomId);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Run `action`; on seat-gone, rejoin once and retry once. Never loops. */
  async function withSeat(action) {
    try {
      return await action();
    } catch (e) {
      if (!seatGone(e)) throw e;
      if (!(await silentRejoin())) {
        const seat = loadSeat();
        if (seat && seat.handle) handleInput.value = seat.handle;
        resetRoom();
        throw e;
      }
      return await action();
    }
  }

  /* ---------- Rendering ---------- */

  function refreshFace() {
    Format.applyFormatFace(state, faceEls, state.format);
  }

  function setFormat(format) {
    Format.applyFormatFace(state, faceEls, format);
  }

  function showLobby(visible) {
    for (const el of [lobbyEl, topicShelfEl, guestbookEl]) {
      if (el) el.classList.toggle('hidden', !visible);
    }
  }

  function renderLineage() {
    if (!lineageEl) return;
    if (state.title) {
      if (titleWrapEl) titleWrapEl.classList.remove('hidden');
      if (titleDisplayEl) titleDisplayEl.textContent = state.title;
    } else if (titleWrapEl) {
      titleWrapEl.classList.add('hidden');
    }
    const parts = [];
    if (state.parentId) {
      parts.push(
        `Branched from <button type="button" class="linkish" data-goto-room="${esc(state.parentId)}">${esc(state.parentId)}</button>`
      );
    }
    if (state.mergedInto) {
      parts.push(
        `Merged into <button type="button" class="linkish" data-goto-room="${esc(state.mergedInto)}">${esc(state.mergedInto)}</button>`
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
    setFormat((meta && meta.format) || 'board');
    showLobby(false);
    roomEl.classList.remove('hidden');
    document.getElementById('room-id-display').textContent = roomId;
    document.getElementById('you-display').textContent = handle;
    renderLineage();
    threadEl.innerHTML = `<p class="empty-thread">${Format.emptyThreadCopy(state.format)}</p>`;
    saveSeat(handle, roomId);
    refresh();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refresh, state.format === 'live' ? 2500 : 4000);
  }

  function topicStateLabel(topic) {
    if (topic.merged_into) return `merged → ${topic.merged_into}`;
    const n = topic.roster_count || 0;
    if (n === 0) return 'empty · board';
    if (n === 1) return '1 person · board';
    return `${n} people · board`;
  }

  async function loadTopics() {
    if (!topicListEl) return;
    try {
      const data = await api('/topics');
      const topics = data.topics || [];
      if (topics.length === 0) {
        topicListEl.innerHTML = '<li class="topic-shelf-empty">No topic rooms yet.</li>';
        return;
      }
      topicListEl.innerHTML = topics
        .map(
          (t) => `<li class="topic-row" data-topic-id="${esc(t.id)}">
          <div class="topic-meta">
            <span class="topic-title">${esc(t.title)}</span>
            <span class="topic-state">${esc(topicStateLabel(t))}</span>
          </div>
          <button type="button" class="secondary topic-enter" data-enter-topic="${esc(t.id)}">Enter</button>
        </li>`
        )
        .join('');
    } catch (_) {
      topicListEl.innerHTML = '<li class="topic-shelf-empty">Could not load topic rooms.</li>';
    }
  }

  async function refresh() {
    if (!state.roomId) return;
    try {
      await withSeat(async () => {
        const data = await api(
          `/rooms/${encodeURIComponent(state.roomId)}/messages?handle=${encodeURIComponent(state.handle)}`
        );
        clearError();
        state.title = data.title || state.title;
        state.parentId = data.parent_id || null;
        state.mergedInto = data.merged_into || null;
        if (data.format) setFormat(data.format);
        renderLineage();
        Format.renderMessages(state, threadEl, data.messages, esc);
        const roster = data.roster;
        rosterEl.innerHTML =
          roster && roster.length
            ? roster.map((p) => `<li>${esc(p.handle)}<span class="party-tag">${esc(p.party || 'human')}</span></li>`).join('')
            : '<li><em>Empty</em></li>';
      });
    } catch (e) {
      showError(e.code, e.message);
    }
  }

  /* ---------- Actions ---------- */

  function readHandle() {
    const handle = handleInput.value.trim();
    if (handle) return handle;
    showError('invalid_handle');
    handleInput.focus();
    return null;
  }

  async function join(roomId, handle) {
    const meta = await api(`/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      body: JSON.stringify({ handle, party: 'human' }),
    });
    enterRoom(roomId, handle, meta);
  }

  function resetRoom() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.roomId = '';
    state.title = '';
    state.parentId = null;
    state.mergedInto = null;
    state.format = 'board';
    roomEl.classList.add('hidden');
    showLobby(true);
    threadEl.innerHTML = '<p class="empty-thread">No messages yet. The floor is open.</p>';
    rosterEl.innerHTML = '';
    bodyInput.value = '';
    if (mergeTargetInput) mergeTargetInput.value = '';
    setFormat('board');
    renderLineage();
    loadTopics();
  }

  function onAction(fn) {
    return async (ev) => {
      clearError();
      try {
        await fn(ev);
      } catch (e) {
        showError(e.code, e.message);
      }
    };
  }

  document.getElementById('btn-welcome').addEventListener(
    'click',
    onAction(async () => {
      const handle = readHandle();
      if (handle) await join(WELCOME, handle);
    })
  );

  document.getElementById('btn-create').addEventListener(
    'click',
    onAction(async () => {
      const handle = readHandle();
      if (!handle) return;
      const created = await api('/rooms', { method: 'POST', body: JSON.stringify({}) });
      await join(created.room_id, handle);
    })
  );

  document.getElementById('btn-join').addEventListener(
    'click',
    onAction(async () => {
      const handle = readHandle();
      if (!handle) return;
      const roomId = roomIdInput.value.trim();
      if (!roomId) return showError('room_not_found', 'Enter a room id to join.');
      await join(roomId, handle);
    })
  );

  if (topicListEl) {
    topicListEl.addEventListener(
      'click',
      onAction(async (ev) => {
        const btn = ev.target.closest('[data-enter-topic]');
        if (!btn) return;
        const handle = readHandle();
        if (handle) await join(btn.getAttribute('data-enter-topic'), handle);
      })
    );
  }

  if (lineageEl) {
    lineageEl.addEventListener(
      'click',
      onAction(async (ev) => {
        const btn = ev.target.closest('[data-goto-room]');
        if (!btn) return;
        const handle = state.handle || readHandle();
        if (handle) await join(btn.getAttribute('data-goto-room'), handle);
      })
    );
  }

  if (bodyInput) bodyInput.addEventListener('input', refreshFace);

  document.getElementById('compose').addEventListener(
    'submit',
    onAction(async (ev) => {
      ev.preventDefault();
      const body = bodyInput.value;
      await withSeat(async () => {
        await api(`/rooms/${encodeURIComponent(state.roomId)}/post`, {
          method: 'POST',
          body: JSON.stringify({ handle: state.handle, body, party: 'human' }),
        });
      });
      bodyInput.value = '';
      refreshFace();
      await refresh();
    })
  );

  document.getElementById('btn-refresh').addEventListener('click', () => {
    clearError();
    refresh();
  });

  const branchBtn = document.getElementById('btn-branch');
  if (branchBtn) {
    branchBtn.addEventListener(
      'click',
      onAction(async () => {
        if (!state.roomId || !state.handle) return;
        const branch = await withSeat(() =>
          api(`/rooms/${encodeURIComponent(state.roomId)}/branch`, {
            method: 'POST',
            body: JSON.stringify({ handle: state.handle, party: 'human' }),
          })
        );
        enterRoom(branch.room_id, state.handle, branch);
      })
    );
  }

  const mergeBtn = document.getElementById('btn-merge');
  if (mergeBtn) {
    mergeBtn.addEventListener(
      'click',
      onAction(async () => {
        if (!state.roomId || !state.handle) return;
        const target = mergeTargetInput ? mergeTargetInput.value.trim() : '';
        if (!target) return showError('invalid_request', 'Enter a target room id to merge into.');
        const result = await withSeat(() =>
          api(`/rooms/${encodeURIComponent(state.roomId)}/merge`, {
            method: 'POST',
            body: JSON.stringify({ handle: state.handle, party: 'human', target_id: target }),
          })
        );
        await join(result.target.room_id, state.handle);
      })
    );
  }

  document.getElementById('btn-leave').addEventListener('click', async () => {
    clearError();
    try {
      await api(`/rooms/${encodeURIComponent(state.roomId)}/leave`, {
        method: 'POST',
        body: JSON.stringify({ handle: state.handle, party: 'human' }),
      });
    } catch (e) {
      showError(e.code, e.message);
    }
    // Keep the name for next time, but no longer seated anywhere.
    saveSeat(state.handle, '');
    handleInput.value = state.handle;
    resetRoom();
  });

  /* ---------- Start: deep link, remembered name, re-seat after reload ---------- */

  let linkedRoom = '';
  try {
    const room = new URLSearchParams(window.location.search).get('room');
    if (room === WELCOME || (room && room.indexOf('topic-') === 0)) linkedRoom = room;
  } catch (_) {
    /* no query string */
  }
  if (linkedRoom) roomIdInput.value = linkedRoom;

  setFormat('board');
  loadTopics();

  const seat = loadSeat();
  if (seat && seat.handle) handleInput.value = seat.handle;
  if (seat && seat.handle && seat.roomId && (!linkedRoom || linkedRoom === seat.roomId)) {
    // Re-join with this browser's key. Seat storage is only cleared by Leave, so a failed
    // rejoin still leaves the name/room remembered for the next try.
    join(seat.roomId, seat.handle).catch((e) => {
      showError(e.code, e.message);
    });
  } else if (linkedRoom) {
    handleInput.focus();
  }
})();
