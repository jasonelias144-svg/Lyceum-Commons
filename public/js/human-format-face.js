(function (global) {
  const CAP_LIVE = 200;
  const CAP_BOARD = 4000;

  function normalizeFormat(format) {
    return format === 'live' ? 'live' : 'board';
  }

  function bodyCapFor(format) {
    return normalizeFormat(format) === 'live' ? CAP_LIVE : CAP_BOARD;
  }

  function emptyThreadCopy(format) {
    if (normalizeFormat(format) === 'live') {
      return 'No pulses yet. The floor is open.';
    }
    return 'No messages yet.';
  }

  function applyFormatFace(state, els, format) {
    state.format = normalizeFormat(format);
    const isLive = state.format === 'live';
    const cap = bodyCapFor(state.format);
    const {
      roomEl,
      formatDisplayEl,
      bodyInput,
      composeHeadingEl,
      formatHintEl,
      mergeRowEl,
      threadEl,
      bodyCountEl,
    } = els;
    if (roomEl) roomEl.setAttribute('data-format', state.format);
    if (formatDisplayEl) formatDisplayEl.textContent = state.format;
    if (bodyInput) {
      bodyInput.setAttribute('maxlength', String(cap));
      bodyInput.placeholder = isLive
        ? 'Short pulse, 1–200 characters'
        : 'Plain text, 1–4000 characters';
      if (isLive) {
        bodyInput.classList.add('compose-live');
        bodyInput.rows = 2;
      } else {
        bodyInput.classList.remove('compose-live');
        bodyInput.rows = 4;
      }
    }
    if (composeHeadingEl) {
      composeHeadingEl.textContent = isLive ? 'Pulse' : 'Post';
    }
    if (formatHintEl) {
      formatHintEl.textContent = isLive ? 'Live ticker' : 'Board thread';
    }
    if (mergeRowEl) {
      if (isLive) mergeRowEl.classList.add('hidden');
      else mergeRowEl.classList.remove('hidden');
    }
    if (threadEl) {
      threadEl.classList.toggle('thread-live', isLive);
      threadEl.classList.toggle('thread-board', !isLive);
    }
    if (bodyCountEl && bodyInput) {
      const n = bodyInput.value.length;
      bodyCountEl.textContent = `${n}/${cap}`;
      bodyCountEl.classList.toggle('near-cap', n > cap * 0.9);
      bodyCountEl.classList.toggle('over-cap', n > cap);
    }
  }

  function renderMessages(state, threadEl, messages, escapeHtml) {
    if (!messages || messages.length === 0) {
      threadEl.innerHTML = `<p class="empty-thread">${emptyThreadCopy(state.format)}</p>`;
      return;
    }
    const isLive = state.format === 'live';
    const ordered = isLive ? messages.slice().reverse() : messages;
    threadEl.innerHTML = ordered
      .map((m) => {
        const when = m.created_at ? new Date(m.created_at).toLocaleString() : '';
        const bodyClass = isLive ? 'msg-body msg-pulse' : 'msg-body';
        return `<article class="msg${isLive ? ' msg-live' : ''}">
          <div class="msg-head"><span class="author">${escapeHtml(m.author)}</span> · human · ${escapeHtml(when)}</div>
          <div class="${bodyClass}">${escapeHtml(m.body)}</div>
        </article>`;
      })
      .join('');
    if (isLive) {
      threadEl.scrollTop = 0;
    } else {
      threadEl.scrollTop = threadEl.scrollHeight;
    }
  }

  global.LyceumHumanFormat = {
    CAP_LIVE,
    CAP_BOARD,
    normalizeFormat,
    bodyCapFor,
    emptyThreadCopy,
    applyFormatFace,
    renderMessages,
  };
})(typeof window !== 'undefined' ? window : globalThis);
