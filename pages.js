const LIBRARY_KEY = 'stillword-library-v1';
const STATS_KEY = 'tesokeu-stats-v1';
const SETTINGS_KEY = 'stillword-settings-v1';
const GOAL_KEY = 'tesokeu-weekly-goal-v1';
const page = document.body.dataset.page;
const $ = selector => document.querySelector(selector);
const readJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const countWords = text => (text || '').trim().match(/\S+/g)?.length || 0;
const stored = readJSON(LIBRARY_KEY, null);
const state = {
  books: Array.isArray(stored?.books) ? stored.books.filter(book => book && typeof book.text === 'string' && typeof book.title === 'string') : SAMPLE_BOOKS.map(book => ({ ...book, position: 0 })),
  activeId: stored?.activeId || 'noticing', filter: 'all', sort: 'recent', query: '', tab: 'upload'
};
if (!state.books.some(book => book.id === state.activeId)) state.activeId = state.books[0]?.id || null;
function save() { try { localStorage.setItem(LIBRARY_KEY, JSON.stringify({ books: state.books, activeId: state.activeId })); return true; } catch { return false; } }
if (!stored) save();
function progress(book) { const total = countWords(book.text); return total ? Math.min(100, Math.round(100 * (book.position || 0) / total)) : 0; }
function status(book) { const total = countWords(book.text); return book.position >= total && total ? 'Finished' : book.position > 0 ? 'Reading' : 'Not started'; }
function node(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = text; return item; }
function readerURL(book, at) { return `./index.html?book=${encodeURIComponent(book.id)}${at == null ? '' : `&at=${encodeURIComponent(at)}`}`; }

function renderLibrary() {
  $('#total-books').textContent = state.books.length;
  $('#in-progress').textContent = state.books.filter(book => status(book) === 'Reading').length;
  $('#completed-books').textContent = state.books.filter(book => status(book) === 'Finished').length;
  let shown = state.books.filter(book => {
    const matches = `${book.title} ${book.author || ''}`.toLowerCase().includes(state.query);
    return matches && (state.filter === 'all' || (state.filter === 'reading' ? status(book) === 'Reading' : status(book) === 'Finished'));
  });
  if (state.sort === 'title') shown.sort((a, b) => a.title.localeCompare(b.title));
  if (state.sort === 'progress') shown.sort((a, b) => progress(b) - progress(a));
  const grid = $('#library-grid'); grid.replaceChildren();
  $('#library-empty').hidden = shown.length > 0;
  shown.forEach(book => {
    const card = node('article', 'library-card');
    const main = node('div', 'library-card-main');
    const cover = node('div', 'library-cover', book.glyph || '✦'); cover.style.background = book.color || '#8eab95';
    const copy = node('div', 'library-card-copy');
    copy.append(node('span', 'reading-state', `${status(book).toUpperCase()}${book.kind ? ` · ${book.kind.toUpperCase()}` : ''}`), node('h3', '', book.title), node('p', 'author', book.author === 'Stillword Library' ? 'Tesokeu Library' : book.author || 'Your bookshelf'));
    main.append(cover, copy);
    const excerpt = node('p', 'excerpt', book.text.replace(/\s+/g, ' ').slice(0, 175));
    const bottom = node('div', 'library-card-bottom');
    const bar = node('div', 'library-card-progress'); const fill = node('span'); fill.style.width = `${progress(book)}%`; bar.append(fill);
    const meta = node('div', 'library-card-meta'); meta.append(node('span', '', `${countWords(book.text).toLocaleString()} words`), node('span', '', `${progress(book)}% complete`));
    const actions = node('div', 'library-card-actions');
    const read = node('a', 'read-link', book.position ? 'Continue reading →' : 'Start reading →'); read.href = readerURL(book);
    const remove = node('button', 'remove-book', '×'); remove.type = 'button'; remove.title = `Remove ${book.title}`; remove.setAttribute('aria-label', `Remove ${book.title}`);
    remove.addEventListener('click', () => removeBook(book.id));
    actions.append(read, remove); bottom.append(bar, meta, actions);
    if (book.sourceUrl && /^https?:\/\//i.test(book.sourceUrl)) {
      const source = node('a', 'source-link', 'Original article ↗');
      source.href = book.sourceUrl; source.target = '_blank'; source.rel = 'noopener noreferrer';
      bottom.append(source);
    }
    card.append(main, excerpt, bottom);
    const marks = Array.isArray(book.bookmarks) ? book.bookmarks.filter(index => Number.isInteger(index) && index >= 0 && index < countWords(book.text)).sort((a, b) => a - b) : [];
    if (marks.length) {
      const bookmarkLinks = node('div', 'library-bookmarks');
      bookmarkLinks.append(node('strong', '', `Bookmarks (${marks.length})`));
      marks.forEach(index => { const link = node('a', '', `${Math.round(100 * index / countWords(book.text))}% · ${book.text.trim().match(/\S+/g)?.slice(index, index + 5).join(' ') || ''}`); link.href = readerURL(book, index); bookmarkLinks.append(link); });
      card.append(bookmarkLinks);
    }
    grid.append(card);
  });
}
function removeBook(id) {
  const book = state.books.find(item => item.id === id);
  if (!book || !confirm(`Remove “${book.title}” from your bookshelf?`)) return;
  const previous = state.books, previousId = state.activeId;
  state.books = state.books.filter(item => item.id !== id);
  if (state.activeId === id) state.activeId = state.books[0]?.id || null;
  if (!save()) { state.books = previous; state.activeId = previousId; alert('This browser could not save that change.'); return; }
  renderLibrary();
}
function openDialog() { setTab('upload'); $('#add-dialog').showModal(); $('#add-dialog .dialog-tab.active').focus(); }
function closeDialog() { $('#add-dialog').close(); if (location.hash === '#add') history.replaceState(null, '', location.pathname); }
function setTab(tab) { state.tab = tab; document.querySelectorAll('.dialog-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab)); $('#paste-fields').hidden = tab !== 'paste'; $('#upload-fields').hidden = tab !== 'upload'; $('#link-fields').hidden = tab !== 'link'; $('#article-url').disabled = tab !== 'link'; $('#form-error').textContent = ''; }
function addBook(title, author, text, metadata = {}) {
  const id = crypto.randomUUID?.() || `book-${Date.now()}`;
  const colors = ['#8c9f96', '#a99a8c', '#8d9daa', '#9f9b7d', '#9f8997'];
  const previousId = state.activeId;
  state.books.unshift({ id, title, author, text, position: 0, color: colors[state.books.length % colors.length], glyph: '✦', ...metadata });
  state.activeId = id;
  if (!save()) { state.books.shift(); state.activeId = previousId; $('#form-error').textContent = 'This browser has no room to save that text. Try a shorter one.'; return; }
  state.query = ''; state.filter = 'all'; $('#book-search').value = '';
  document.querySelectorAll('.filter').forEach(button => button.classList.toggle('active', button.dataset.filter === 'all'));
  renderLibrary(); $('#add-form').reset(); $('#selected-file').textContent = ''; closeDialog();
}
function initLibrary() {
  renderLibrary();
  $('#library-add').addEventListener('click', openDialog);
  $('#empty-library-add').addEventListener('click', openDialog);
  $('#close-dialog').addEventListener('click', closeDialog);
  $('#add-dialog').addEventListener('click', event => { if (event.target === $('#add-dialog')) closeDialog(); });
  document.querySelectorAll('.dialog-tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
  $('#file-input').addEventListener('change', () => { const file = $('#file-input').files[0]; $('#selected-file').textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : ''; });
  $('#add-form').addEventListener('submit', async event => {
    event.preventDefault(); $('#form-error').textContent = '';
    const button = $('#add-form .submit-button');
    button.disabled = true; button.innerHTML = 'Importing… <span>↗</span>';
    try {
      if (state.tab === 'paste') {
        const title = $('#text-title').value.trim(), text = $('#text-content').value.trim();
        if (!title || !text) throw new Error('Add a title and some text to continue.');
        addBook(title, $('#text-author').value.trim() || 'Your bookshelf', text, { kind: 'text' });
      } else {
        const parsed = state.tab === 'upload' ? await TesokeuImport.file($('#file-input').files[0]) : await TesokeuImport.article($('#article-url').value.trim());
        addBook(parsed.title, parsed.author, parsed.text, { kind: parsed.kind, sourceUrl: parsed.sourceUrl || null });
      }
    } catch (error) { $('#form-error').textContent = error.message || 'This import could not be completed.'; }
    finally { button.disabled = false; button.innerHTML = 'Add to bookshelf <span>↗</span>'; }
  });
  $('#book-search').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); renderLibrary(); });
  document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button)); renderLibrary(); }));
  $('#book-sort').addEventListener('change', event => { state.sort = event.target.value; renderLibrary(); });
  $('#export-backup').addEventListener('click', () => {
    const backup = { format: 'tesokeu-backup', version: 1, exportedAt: new Date().toISOString(), library: { books: state.books, activeId: state.activeId }, settings: readJSON(SETTINGS_KEY, {}), stats: readJSON(STATS_KEY, {}), goal: readJSON(GOAL_KEY, null) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = node('a'); link.href = url; link.download = `tesokeu-backup-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('#backup-status').textContent = 'Backup downloaded.';
  });
  $('#restore-backup').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    const status = $('#backup-status');
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error('This backup is too large to restore here.');
      const backup = JSON.parse(await file.text());
      if (backup?.format !== 'tesokeu-backup' || backup.version !== 1 || !Array.isArray(backup.library?.books) || !backup.library.books.every(book => book && typeof book.id === 'string' && typeof book.title === 'string' && typeof book.text === 'string' && Number.isFinite(book.position) && (!book.bookmarks || (Array.isArray(book.bookmarks) && book.bookmarks.every(Number.isInteger))))) throw new Error('This is not a valid Tesokeu backup.');
      if (!backup.settings || typeof backup.settings !== 'object' || !backup.stats || typeof backup.stats !== 'object') throw new Error('This backup is missing reading data.');
      if (!confirm(`Restore ${backup.library.books.length} reads? This replaces the books, progress, preferences, activity, and goal currently in this browser.`)) return;
      const keys = [LIBRARY_KEY, SETTINGS_KEY, STATS_KEY, GOAL_KEY];
      const before = keys.map(key => localStorage.getItem(key));
      try {
        localStorage.setItem(LIBRARY_KEY, JSON.stringify(backup.library));
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(backup.settings));
        localStorage.setItem(STATS_KEY, JSON.stringify(backup.stats));
        if (backup.goal == null) localStorage.removeItem(GOAL_KEY); else localStorage.setItem(GOAL_KEY, JSON.stringify(backup.goal));
      } catch (error) { keys.forEach((key, index) => { try { if (before[index] == null) localStorage.removeItem(key); else localStorage.setItem(key, before[index]); } catch {} }); throw new Error('This browser has no room to restore the backup.'); }
      location.reload();
    } catch (error) { status.textContent = error instanceof SyntaxError ? 'The selected file is not valid JSON.' : error.message; }
    finally { event.target.value = ''; }
  });
  if (location.hash === '#add') openDialog();
  window.addEventListener('hashchange', () => { if (location.hash === '#add' && !$('#add-dialog').open) openDialog(); });
}
function utcDay(offset) { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); }
function initInsights() {
  const stats = readJSON(STATS_KEY, { totalWords: 0, totalMs: 0, sessions: 0, daily: {} });
  $('#insight-words').textContent = (stats.totalWords || 0).toLocaleString();
  const minutes = Math.round((stats.totalMs || 0) / 60000);
  $('#insight-time').textContent = minutes === 0 && stats.totalMs ? '<1 min' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  $('#insight-sessions').textContent = (stats.sessions || 0).toLocaleString();
  $('#insight-completed').textContent = state.books.filter(book => status(book) === 'Finished').length;
  const days = Array.from({ length: 7 }, (_, index) => utcDay(index - 6));
  const daily = stats.daily || {}, values = days.map(day => daily[day] || 0), max = Math.max(1, ...values);
  const weeklyWords = values.reduce((a, b) => a + b, 0);
  const goalInput = $('#goal-words'), goalSummary = $('#goal-summary'), goalFill = $('#goal-fill');
  function renderGoal() {
    const goal = readJSON(GOAL_KEY, null);
    if (Number.isInteger(goal) && goal >= 100) {
      goalInput.value = goal;
      goalFill.style.width = `${Math.min(100, weeklyWords / goal * 100)}%`;
      goalSummary.textContent = weeklyWords >= goal ? `Goal reached! ${weeklyWords.toLocaleString()} of ${goal.toLocaleString()} words in the last 7 days.` : `${weeklyWords.toLocaleString()} of ${goal.toLocaleString()} words · ${(goal - weeklyWords).toLocaleString()} to go.`;
    } else { goalFill.style.width = '0%'; goalSummary.textContent = 'Set a goal to get started.'; }
  }
  $('#save-goal').addEventListener('click', () => { const goal = Number(goalInput.value); if (!Number.isInteger(goal) || goal < 100 || goal > 1000000) { goalSummary.textContent = 'Choose a goal from 100 to 1,000,000 words.'; return; } localStorage.setItem(GOAL_KEY, JSON.stringify(goal)); renderGoal(); });
  $('#remove-goal').addEventListener('click', () => { localStorage.removeItem(GOAL_KEY); renderGoal(); });
  renderGoal();
  $('#weekly-total').textContent = `${weeklyWords.toLocaleString()} ${weeklyWords === 1 ? 'word' : 'words'} this week`;
  const chart = $('#activity-chart');
  days.forEach((day, index) => {
    const wrapper = node('div', `chart-day${index === 6 ? ' today' : ''}`);
    wrapper.title = `${day}: ${values[index]} words`;
    const bar = node('div', 'chart-bar'); bar.style.height = `${Math.max(4, Math.round(values[index] / max * 120))}px`;
    const label = node('span', '', new Date(`${day}T12:00:00Z`).toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }));
    wrapper.append(bar, label); chart.append(wrapper);
  });
  const recent = $('#recent-reads');
  state.books.slice(0, 3).forEach(book => {
    const link = node('a', 'recent-read'); link.href = readerURL(book);
    const cover = node('span', 'recent-cover', book.glyph || '✦'); cover.style.background = book.color || '#8eab95';
    const copy = node('span'); copy.append(node('strong', '', book.title), node('small', '', `${progress(book)}% complete · ${countWords(book.text)} words`));
    link.append(cover, copy); recent.append(link);
  });
  if (!state.books.length) recent.append(node('p', 'empty-copy', 'Your bookshelf is empty. Add a read to get started.'));
}
if (page === 'library') initLibrary();
if (page === 'insights') initInsights();
