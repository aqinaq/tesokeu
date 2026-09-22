const TesokeuSync = (() => {
  const LIBRARY = 'stillword-library-v1';
  const SETTINGS = 'stillword-settings-v1';
  const STATS = 'tesokeu-stats-v1';
  const GOAL = 'tesokeu-weekly-goal-v1';
  const SESSION = 'tesokeu-sync-v1';
  const keys = [LIBRARY, SETTINGS, STATS, GOAL];
  const ui = document.querySelector('#sync-status');
  let session = read(SESSION, null);
  let busy = false;
  let lastPull = 0;
  let polling = false;

  function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function bookFingerprint(book) {
    const metadata = { ...book };
    delete metadata.position;
    delete metadata.bookmarks;
    const value = JSON.stringify(metadata);
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return hash >>> 0;
  }
  function snapshot() {
    const fallback = { books: SAMPLE_BOOKS.map(book => ({ ...book, position: 0 })), activeId: 'noticing' };
    return { format: 'tesokeu-sync', version: 1, library: read(LIBRARY, fallback), settings: read(SETTINGS, {}), stats: read(STATS, { totalWords: 0, totalMs: 0, sessions: 0, daily: {} }), goal: read(GOAL, null) };
  }
  function summary(data) {
    const books = {};
    (data.library?.books || []).forEach(book => { books[book.id] = { fingerprint: bookFingerprint(book), position: book.position || 0, bookmarks: Array.isArray(book.bookmarks) ? [...book.bookmarks].sort((a, b) => a - b) : [] }; });
    return { books, activeId: data.library?.activeId || null, settings: data.settings, stats: data.stats, goal: data.goal };
  }
  function saveSession(data) {
    session = { token: data.token, revision: data.revision, base: summary(data.snapshot) };
    localStorage.setItem(SESSION, JSON.stringify(session));
  }
  function applyLocal(data) {
    const before = keys.map(key => localStorage.getItem(key));
    try {
      localStorage.setItem(LIBRARY, JSON.stringify(data.library));
      localStorage.setItem(SETTINGS, JSON.stringify(data.settings));
      localStorage.setItem(STATS, JSON.stringify(data.stats));
      if (data.goal == null) localStorage.removeItem(GOAL); else localStorage.setItem(GOAL, JSON.stringify(data.goal));
    } catch {
      keys.forEach((key, index) => { try { if (before[index] == null) localStorage.removeItem(key); else localStorage.setItem(key, before[index]); } catch {} });
      throw new Error('This browser has no room for the synced collection.');
    }
  }
  function number(value) { return Number.isFinite(value) ? value : 0; }
  function mergeStats(base, local, remote) {
    const merged = { ...remote };
    for (const key of ['totalWords', 'totalMs', 'sessions']) merged[key] = Math.max(0, number(remote?.[key]) + number(local?.[key]) - number(base?.[key]));
    merged.daily = { ...(remote?.daily || {}) };
    for (const day of new Set([...Object.keys(base?.daily || {}), ...Object.keys(local?.daily || {})])) {
      merged.daily[day] = Math.max(0, number(remote?.daily?.[day]) + number(local?.daily?.[day]) - number(base?.daily?.[day]));
    }
    return merged;
  }
  function mergeBookmarks(base, local, remote) {
    const b = new Set(base || []), l = new Set(local || []), r = new Set(remote || []);
    return [...new Set([...l, ...r])].filter(mark => !b.has(mark) || (l.has(mark) && r.has(mark))).sort((a, b) => a - b);
  }
  function merge(base, local, remote) {
    const baseBooks = base?.books || {};
    const localBooks = new Map((local.library?.books || []).map(book => [book.id, book]));
    const remoteBooks = new Map((remote.library?.books || []).map(book => [book.id, book]));
    const order = [...new Set([...localBooks.keys(), ...remoteBooks.keys()])];
    const books = [];
    for (const id of order) {
      const left = localBooks.get(id), right = remoteBooks.get(id), original = baseBooks[id];
      if (original && (!left || !right)) continue;
      if (!left || !right) { books.push(left || right); continue; }
      const leftMoved = number(left.position) !== number(original?.position);
      const rightMoved = number(right.position) !== number(original?.position);
      const position = leftMoved && rightMoved ? Math.max(number(left.position), number(right.position)) : leftMoved ? left.position : right.position;
      const metadata = bookFingerprint(left) !== original?.fingerprint ? left : right;
      books.push({ ...metadata, position, bookmarks: mergeBookmarks(original?.bookmarks, left.bookmarks, right.bookmarks) });
    }
    const ids = new Set(books.map(book => book.id));
    const activeId = (local.library?.activeId !== base?.activeId ? local.library?.activeId : remote.library?.activeId);
    const settings = { ...remote.settings };
    for (const key of Object.keys(local.settings || {})) if (!same(local.settings[key], base?.settings?.[key])) settings[key] = local.settings[key];
    return {
      format: 'tesokeu-sync', version: 1,
      library: { books, activeId: ids.has(activeId) ? activeId : books[0]?.id || null },
      settings, stats: mergeStats(base?.stats, local.stats, remote.stats),
      goal: !same(local.goal, base?.goal) ? local.goal : remote.goal
    };
  }
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(`/api/sync/${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}), ...(options.headers || {}) }
      });
    } catch { throw new Error('The sync service could not be reached. Try again soon.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || 'Device sync failed.'); error.status = response.status; throw error; }
    return data;
  }
  function status(message) { if (ui) ui.textContent = message; }
  function render() {
    if (!ui) return;
    const paired = Boolean(session?.token);
    document.querySelector('#sync-create').hidden = paired;
    document.querySelector('#sync-code').hidden = !paired;
    document.querySelector('.sync-join').hidden = paired;
    document.querySelector('#sync-manage').hidden = !paired;
    if (!paired) document.querySelector('#sync-code-box').hidden = true;
    status(paired ? 'Connected · Changes sync automatically when this page is open.' : 'This browser is not connected to another device.');
  }
  async function reconcile(remote) {
    let current = remote;
    for (let attempt = 0; attempt < 3; attempt++) {
      const local = snapshot();
      const merged = merge(session.base, local, current.snapshot);
      try {
        const result = await request('state', { method: 'PUT', body: JSON.stringify({ revision: current.revision, snapshot: merged }) });
        const changedHere = !same(local, merged);
        if (changedHere) applyLocal(merged);
        saveSession({ token: session.token, revision: result.revision, snapshot: merged });
        lastPull = Date.now();
        if (changedHere) location.reload(); else status('Connected · Up to date.');
        return;
      } catch (error) {
        if (error.status !== 409) throw error;
        current = await request('state');
      }
    }
    throw new Error('Both devices are changing at once. Pause briefly and try again.');
  }
  async function syncNow(forceRead = false) {
    if (!session?.token || busy) return;
    busy = true;
    try {
      const local = snapshot();
      if (!same(summary(local), session.base)) {
        try {
          const result = await request('state', { method: 'PUT', body: JSON.stringify({ revision: session.revision, snapshot: local }) });
          saveSession({ token: session.token, revision: result.revision, snapshot: local });
          lastPull = Date.now(); status('Connected · Changes saved.');
        } catch (error) {
          if (error.status !== 409) throw error;
          await reconcile(await request('state'));
        }
      } else if (forceRead || Date.now() - lastPull > 20000) {
        const remote = await request('state');
        lastPull = Date.now();
        if (remote.revision > session.revision) {
          applyLocal(remote.snapshot);
          saveSession({ token: session.token, ...remote });
          location.reload();
        } else status('Connected · Up to date.');
      }
    } catch (error) {
      if (error.status === 404) { session = null; localStorage.removeItem(SESSION); render(); status('The sync space is gone. Your books remain in this browser.'); }
      else status(error.message);
    } finally { busy = false; }
  }
  function startPolling() {
    if (polling || !session?.token) return;
    polling = true;
    syncNow(true);
    setInterval(() => { if (!document.hidden) syncNow(); }, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(true); });
    window.addEventListener('focus', () => syncNow(true));
  }
  function showCode(code) {
    document.querySelector('#sync-code-value').textContent = code;
    document.querySelector('#sync-code-box').hidden = false;
    status('Enter this code on your other device within 10 minutes. It works once.');
  }
  if (ui) {
    render();
    document.querySelector('#sync-create').addEventListener('click', async () => {
      const button = document.querySelector('#sync-create'); button.disabled = true; status('Making your code…');
      try { const local = snapshot(); const result = await request('create', { method: 'POST', body: JSON.stringify({ snapshot: local }) }); saveSession({ ...result, snapshot: local }); render(); showCode(result.code); startPolling(); }
      catch (error) { status(error.message); } finally { button.disabled = false; }
    });
    document.querySelector('#sync-code').addEventListener('click', async () => {
      try { await syncNow(); const result = await request('code', { method: 'POST' }); showCode(result.code); } catch (error) { status(error.message); }
    });
    document.querySelector('#sync-join').addEventListener('click', async () => {
      const input = document.querySelector('#sync-input');
      if (!confirm('Connect this device? Its current bookshelf and progress will be replaced with the collection from your other device.')) return;
      status('Connecting this device…');
      try { const result = await request('join', { method: 'POST', body: JSON.stringify({ code: input.value.trim() }) }); applyLocal(result.snapshot); saveSession(result); location.reload(); }
      catch (error) { status(error.message); }
    });
    document.querySelector('#sync-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(document.querySelector('#sync-code-value').textContent); status('Code copied. Enter it on your other device.'); }
      catch { status('Select and copy the code shown above.'); }
    });
    document.querySelector('#sync-disconnect').addEventListener('click', () => { localStorage.removeItem(SESSION); session = null; render(); status('This browser is disconnected. Your books remain here.'); });
    document.querySelector('#sync-delete').addEventListener('click', async () => {
      if (!confirm('Delete the online collection for every connected device? Books already saved in each browser will remain there.')) return;
      try { await request('state', { method: 'DELETE' }); localStorage.removeItem(SESSION); session = null; render(); status('The online collection was deleted. Books on this browser remain.'); }
      catch (error) { status(error.message); }
    });
  }
  startPolling();
  return { syncNow };
})();
