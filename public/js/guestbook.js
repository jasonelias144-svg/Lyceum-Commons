/**
 * Guest book — short public signature wall.
 * Shared by `/` and `/human`. Not a chat thread; no replies.
 */
(function () {
  const BODY_MAX = 50;

  const listEl = document.getElementById('guestbook-list');
  const formEl = document.getElementById('guestbook-form');
  const handleEl = document.getElementById('gb-handle');
  const bodyEl = document.getElementById('gb-body');
  const statusEl = document.getElementById('guestbook-status');
  const countEl = document.getElementById('gb-count');

  if (!listEl || !formEl) return;

  const ERROR_PLAIN = {
    invalid_handle: 'Handle must be 1–40 characters with no control chars.',
    invalid_signature: 'Signature must be 1–50 characters of plain text.',
    bare_url: 'Please write a short note — not a bare URL.',
    not_human: 'The guest book is for people. AI and machine parties are not signed here.',
    invalid_request: 'Handle and signature are required.',
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', !!isError);
    statusEl.hidden = !msg;
  }

  function updateCount() {
    if (!countEl || !bodyEl) return;
    const n = bodyEl.value.length;
    countEl.textContent = `${n}/${BODY_MAX}`;
  }

  function render(signatures) {
    if (!signatures || signatures.length === 0) {
      listEl.innerHTML = '<p class="guestbook-empty">Be the first to sign</p>';
      return;
    }
    listEl.innerHTML = signatures
      .map((s) => {
        const when = s.created_at ? new Date(s.created_at).toLocaleString() : '';
        return `<article class="guestbook-entry">
          <p class="guestbook-body">${escapeHtml(s.body)}</p>
          <p class="guestbook-meta"><span class="guestbook-handle">${escapeHtml(s.handle)}</span> · <time datetime="${escapeHtml(s.created_at || '')}">${escapeHtml(when)}</time></p>
        </article>`;
      })
      .join('');
  }

  async function load() {
    try {
      const res = await fetch('/api/guestbook', { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setStatus('Could not load the guest book.', true);
        return;
      }
      render(data && data.signatures);
    } catch (_) {
      setStatus('Could not load the guest book.', true);
    }
  }

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus('');
    const handle = (handleEl.value || '').trim();
    const body = (bodyEl.value || '').trim();
    if (!handle) {
      setStatus(ERROR_PLAIN.invalid_handle, true);
      handleEl.focus();
      return;
    }
    if (!body || body.length > BODY_MAX) {
      setStatus(ERROR_PLAIN.invalid_signature, true);
      bodyEl.focus();
      return;
    }
    try {
      const res = await fetch('/api/guestbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ handle, body }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const code = data && data.error && data.error.code;
        setStatus(ERROR_PLAIN[code] || (data && data.error && data.error.message) || 'Could not sign.', true);
        return;
      }
      bodyEl.value = '';
      updateCount();
      setStatus('Signed. Thank you.');
      await load();
    } catch (_) {
      setStatus('Could not sign.', true);
    }
  });

  if (bodyEl) {
    bodyEl.addEventListener('input', updateCount);
    updateCount();
  }

  load();
})();
