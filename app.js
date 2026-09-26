const STORAGE_KEY = 'stillword-library-v1';
const SETTINGS_KEY = 'stillword-settings-v1';
const STATS_KEY = 'tesokeu-stats-v1';
const $ = (selector) => document.querySelector(selector);
const elements = {
  list: $('#book-list'), count: $('#book-count'), title: $('#reader-title'), author: $('#reader-author'),
  word: $('#display-word'), position: $('#reader-position'), time: $('#reading-time'), hint: $('#stage-hint'),
  progress: $('#progress-fill'), play: $('#play-button'), playIcon: $('#play-icon'), speed: $('#speed-slider'),
  speedValue: $('#speed-value'), menu: $('#reader-options'), dialog: $('#add-dialog'), form: $('#add-form'),
  error: $('#form-error'), file: $('#file-input'), selectedFile: $('#selected-file')
};

function wordsFor(text) { return (text || '').trim().match(/\S+/g) || []; }
const wordCache = new WeakMap();
function bookWords(book) {
  if (!book) return [];
  let cached = wordCache.get(book);
  if (!cached || cached.text !== book.text) {
    cached = { text: book.text, words: wordsFor(book.text) };
    wordCache.set(book, cached);
  }
  return cached.words;
}
function loadJSON(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; } }
function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ books: state.books, activeId: state.activeId })); return true; } catch { return false; } }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ speed: state.speed, theme: state.theme, size: state.size, punctuation: state.punctuation, longWordPause: state.longWordPause })); } catch {} }
function saveStats() { try { localStorage.setItem(STATS_KEY, JSON.stringify(state.stats)); } catch {} }

const stored = loadJSON(STORAGE_KEY, null);
const settings = loadJSON(SETTINGS_KEY, {});
const state = {
  books: Array.isArray(stored?.books) ? stored.books.filter(b => b && typeof b.text === 'string' && typeof b.title === 'string').map(b => b.author === 'Stillword Library' ? { ...b, author: 'Tesokeu Library' } : b) : SAMPLE_BOOKS.map(b => ({ ...b, position: 0 })),
  activeId: stored?.activeId || 'noticing',
  speed: Number.isFinite(settings.speed) ? Math.max(100, Math.min(900, settings.speed)) : 300,
  theme: ['dark', 'light', 'sepia'].includes(settings.theme) ? settings.theme : 'dark',
  size: ['small', 'medium', 'large'].includes(settings.size) ? settings.size : 'medium',
  punctuation: settings.punctuation !== false,
  longWordPause: settings.longWordPause !== false,
  stats: loadJSON(STATS_KEY, { totalWords: 0, totalMs: 0, sessions: 0, daily: {} }),
  playing: false, timer: null, tab: 'upload'
};
const requestedBook = new URLSearchParams(location.search).get('book');
if (requestedBook && state.books.some(b => b.id === requestedBook)) state.activeId = requestedBook;
if (!state.books.some(b => b.id === state.activeId)) state.activeId = state.books[0]?.id || null;
state.books.forEach(book => { book.position = clampPosition(book.position, bookWords(book).length); });
const requestedPosition = new URLSearchParams(location.search).get('at');
if (requestedBook === state.activeId && requestedPosition !== null && /^\d+$/.test(requestedPosition)) {
  const book = state.books.find(b => b.id === state.activeId);
  if (book) { book.position = Math.min(wordsFor(book.text).length, Number(requestedPosition)); save(); }
}
if (requestedBook === state.activeId) save();

function activeBook() { return state.books.find(b => b.id === state.activeId); }
function activeWords() { return bookWords(activeBook()); }
let pendingSave = null;
function flushProgress() { if (pendingSave === null) return; clearTimeout(pendingSave); pendingSave = null; save(); saveStats(); }
function queueProgressSave() { if (pendingSave === null) pendingSave = setTimeout(flushProgress, 1000); }
function stop() { state.playing = false; clearTimeout(state.timer); state.timer = null; flushProgress(); renderPlayback(); }
let renderedBookmarksKey = '';
function clampPosition(value, total = activeWords().length) { return Math.max(0, Math.min(total, Math.round(Number(value) || 0))); }
function positionExcerpt(index) { return activeWords().slice(Math.max(0, index - 3), index + 5).join(' ') || 'End of read'; }

function pivotIndex(word) {
  const letters = [...word.replace(/^[^\p{L}\p{N}]+/u, '')];
  const leading = [...word].length - letters.length;
  const length = letters.length;
  const offset = length <= 1 ? 0 : length <= 5 ? 1 : length <= 9 ? 2 : length <= 13 ? 3 : 4;
  return Math.min([...word].length - 1, leading + offset);
}

function renderWord(word) {
  const chars = [...word];
  const index = pivotIndex(word);
  elements.word.replaceChildren();
  const before = document.createElement('span'); before.className = 'word-before'; before.textContent = chars.slice(0, index).join('');
  const focus = document.createElement('span'); focus.className = 'focus-letter'; focus.textContent = chars[index] || '';
  const after = document.createElement('span'); after.className = 'word-after'; after.textContent = chars.slice(index + 1).join('');
  elements.word.append(before, focus, after);
  elements.word.setAttribute('aria-label', word);
  fitRenderedWord();
}

// Keep the RSVP pivot centered while reducing only words that cannot fit at the
// chosen size. Each side is measured separately because a long suffix can clip
// even when the complete word would otherwise fit inside the stage.
function fitRenderedWord() {
  const stage = elements.word.parentElement;
  if (!stage || !stage.clientWidth || typeof getComputedStyle !== 'function') return;
  elements.word.classList.remove('fit-balanced');
  elements.word.style.removeProperty('font-size');
  const before = elements.word.querySelector('.word-before');
  const focus = elements.word.querySelector('.focus-letter');
  const after = elements.word.querySelector('.word-after');
  if (!before || !focus || !after) return;
  const sideWidth = Math.max(0, (stage.clientWidth - focus.offsetWidth - 32) / 2);
  const scale = Math.min(1,
    before.scrollWidth ? sideWidth / before.scrollWidth : 1,
    after.scrollWidth ? sideWidth / after.scrollWidth : 1);
  if (scale < 1) {
    const baseSize = parseFloat(getComputedStyle(elements.word).fontSize);
    if (baseSize * scale >= 16) {
      elements.word.style.fontSize = `${baseSize * scale * 0.98}px`;
    } else {
      // For very asymmetric words, relax pivot alignment before making the text
      // uncomfortably small. The whole word remains visible and centred.
      elements.word.classList.add('fit-balanced');
      const totalWidth = before.scrollWidth + focus.scrollWidth + after.scrollWidth;
      const balancedScale = Math.min(1, (stage.clientWidth - 32) / totalWidth);
      elements.word.style.fontSize = `${Math.max(1, baseSize * balancedScale * 0.98)}px`;
    }
  }
}

function renderShelf() {
  elements.count.textContent = state.books.length;
  elements.list.replaceChildren();
  state.books.forEach(book => {
    const words = bookWords(book);
    const item = document.createElement('a'); item.href = `./reader.html?book=${encodeURIComponent(book.id)}`; item.className = `book-item${book.id === state.activeId ? ' active' : ''}`;
    item.setAttribute('aria-label', `Read ${book.title}`);
    const cover = document.createElement('span'); cover.className = 'book-cover'; cover.style.background = book.color || '#8eab95';
    const glyph = document.createElement('span'); glyph.textContent = book.glyph || '✦'; cover.append(glyph);
    const meta = document.createElement('span'); meta.className = 'book-meta';
    const title = document.createElement('strong'); title.textContent = book.title;
    const detail = document.createElement('small'); detail.textContent = `${words.length} words · ${book.position ? `${Math.round(100 * book.position / words.length)}% read` : 'Not started'}`;
    const bar = document.createElement('span'); bar.className = 'book-progress';
    const fill = document.createElement('span'); fill.style.width = `${words.length ? Math.min(100, 100 * (book.position || 0) / words.length) : 0}%`; bar.append(fill);
    meta.append(title, detail, bar); item.append(cover, meta);
    if (book.id === state.activeId) { const chevron = document.createElement('span'); chevron.className = 'book-chevron'; chevron.textContent = '›'; item.append(chevron); }
    item.addEventListener('click', () => { stop(); state.activeId = book.id; save(); }); elements.list.append(item);
  });
}

function renderShelfProgress() {
  const book = activeBook(), total = activeWords().length;
  const item = elements.list.querySelector('.book-item.active');
  if (!book || !item) return;
  const percent = total ? Math.round(100 * book.position / total) : 0;
  item.querySelector('small').textContent = `${total} words · ${book.position ? `${percent}% read` : 'Not started'}`;
  item.querySelector('.book-progress span').style.width = `${percent}%`;
}

function renderReader() {
  const book = activeBook(); const words = activeWords();
  if (document.body.classList.contains('reader-page')) document.title = `${book?.title || 'Read'} — Tesokeu`;
  elements.title.textContent = book?.title || 'Your next read starts here';
  elements.author.textContent = book ? `${words.length} words · ${book.author || 'Your bookshelf'}` : 'Add a text to begin reading';
  $('#position-slider').max = Math.max(0, words.length - 1);
  $('#position-slider').disabled = !words.length;
  $('#bookmark-add').disabled = !words.length;
  $('#word-number').max = Math.max(1, words.length);
  $('#word-number').disabled = !words.length;
  $('#jump-word').disabled = !words.length;
  if (document.activeElement !== $('#word-number')) $('#word-number').value = words.length ? Math.min(book.position + 1, words.length) : '';
  renderBookmarks();
  if (!book || !words.length) {
    renderWord('Ready?'); elements.position.textContent = '00 / 00'; elements.time.textContent = '—';
    elements.hint.textContent = 'Add a read to get started'; elements.progress.style.width = '0%'; elements.play.disabled = true;
    $('#position-slider').value = 0; $('#position-preview').textContent = 'Start';
    $('#delete-option').hidden = true; return;
  }
  elements.play.disabled = false; $('#delete-option').hidden = false;
  const position = Math.min(Math.max(0, book.position || 0), words.length);
  const shownIndex = Math.min(position, words.length - 1);
  renderWord(words[shownIndex]);
  elements.position.textContent = `${String(Math.min(position + 1, words.length)).padStart(2, '0')} / ${words.length}`;
  const remaining = Math.max(0, words.length - position);
  const minutes = Math.ceil(remaining / state.speed);
  elements.time.textContent = remaining ? `~${minutes} min left` : 'Finished';
  elements.progress.style.width = `${Math.round(100 * position / words.length)}%`;
  if (document.activeElement !== $('#position-slider')) { $('#position-slider').value = shownIndex; $('#position-preview').textContent = `${Math.round(100 * position / words.length)}% · ${positionExcerpt(shownIndex)}`; }
  elements.hint.textContent = position >= words.length ? 'Finished — press play to read again' : state.playing ? 'You’re in the flow' : 'Press play or tap space to begin';
  if (!$('#context-panel').hidden) renderContext();
}

function renderBookmarks() {
  const book = activeBook(), words = activeWords();
  const marks = Array.isArray(book?.bookmarks) ? book.bookmarks.filter(index => Number.isInteger(index) && index >= 0 && index < words.length).sort((a, b) => a - b) : [];
  const key = `${book?.id || ''}:${marks.join(',')}`;
  if (key === renderedBookmarksKey) return;
  renderedBookmarksKey = key;
  $('#bookmark-count').textContent = `${marks.length} saved`;
  const list = $('#bookmark-list'); list.replaceChildren();
  if (!marks.length) { const empty = document.createElement('span'); empty.className = 'bookmark-empty'; empty.textContent = 'Save a spot to return to it later.'; list.append(empty); return; }
  marks.forEach(index => {
    const row = document.createElement('div'); row.className = 'bookmark-item';
    const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = `${Math.round(100 * index / words.length)}% · ${positionExcerpt(index)}`; jump.title = `Jump to word ${index + 1}`;
    jump.addEventListener('click', () => { stop(); setPosition(index); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'bookmark-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove bookmark at word ${index + 1}`);
    remove.addEventListener('click', () => { book.bookmarks = book.bookmarks.filter(mark => mark !== index); save(); renderBookmarks(); });
    row.append(jump, remove); list.append(row);
  });
}

function renderContext() {
  const words = activeWords(), position = activeBook()?.position || 0;
  const container = $('#context-text'); container.replaceChildren();
  if (!words.length) return;
  const start = Math.max(0, position - 90), end = Math.min(words.length, position + 91);
  if (start) { const marker = document.createElement('span'); marker.className = 'context-ellipsis'; marker.textContent = '… '; container.append(marker); }
  for (let i = start; i < end; i++) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `context-word${i === Math.min(position, words.length - 1) ? ' current' : ''}`;
    button.textContent = words[i] + ' ';
    if (i === Math.min(position, words.length - 1)) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => { stop(); setPosition(i); }); container.append(button);
  }
  if (end < words.length) { const marker = document.createElement('span'); marker.className = 'context-ellipsis'; marker.textContent = '…'; container.append(marker); }
}

function applyPreferences() {
  $('#reader-card').classList.remove('theme-dark', 'theme-light', 'theme-sepia', 'size-small', 'size-medium', 'size-large');
  $('#reader-card').classList.add(`theme-${state.theme}`, `size-${state.size}`);
  $('#reader').classList.remove('theme-dark', 'theme-light', 'theme-sepia');
  $('#reader').classList.add(`theme-${state.theme}`);
  document.querySelectorAll('[data-theme]').forEach(button => button.classList.toggle('selected', button.dataset.theme === state.theme));
  document.querySelectorAll('[data-size]').forEach(button => button.classList.toggle('selected', button.dataset.size === state.size));
  $('#punctuation-toggle').checked = state.punctuation;
  $('#long-word-toggle').checked = state.longWordPause;
  saveSettings();
}

function renderPlayback() {
  elements.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  elements.playIcon.innerHTML = state.playing ? '<path d="M7 5h4v14H7zm6 0h4v14h-4z"/>' : '<path d="M8 5.5v13l10-6.5z"/>';
  renderReader();
}

function setPosition(value) { const book = activeBook(); if (!book) return; book.position = clampPosition(value); save(); renderReader(); renderShelf(); }
function delayFor(word) {
  const base = 60000 / state.speed;
  const punctuationMultiplier = state.punctuation ? (/[.!?][”’"']?$/.test(word) ? 1.7 : /[,;:][”’"']?$/.test(word) ? 1.3 : 1) : 1;
  const lengthMultiplier = state.longWordPause && [...word].length >= 12 ? 1.35 : 1;
  return base * Math.max(punctuationMultiplier, lengthMultiplier);
}
function scheduleNext() {
  if (!state.playing) return;
  const book = activeBook(); const words = activeWords();
  if (!book || book.position >= words.length) { stop(); return; }
  const delay = delayFor(words[book.position]);
  state.timer = setTimeout(() => {
    if (!state.playing) return;
    const today = new Date().toISOString().slice(0, 10);
    state.stats.totalWords = (state.stats.totalWords || 0) + 1;
    state.stats.totalMs = (state.stats.totalMs || 0) + delay;
    state.stats.daily ||= {};
    state.stats.daily[today] = (state.stats.daily[today] || 0) + 1;
    book.position += 1; queueProgressSave(); renderReader(); renderShelfProgress();
    if (book.position >= words.length) stop(); else scheduleNext();
  }, delay);
}
function togglePlay(countSession = true) { const book = activeBook(); if (!book || !activeWords().length) return; if (state.playing) { stop(); return; } if (book.position >= activeWords().length) setPosition(0); state.playing = true; if (countSession) state.stats.sessions = (state.stats.sessions || 0) + 1; saveStats(); renderPlayback(); scheduleNext(); }
function changeSpeed(value) { state.speed = Math.max(100, Math.min(900, Number(value))); elements.speed.value = state.speed; elements.speedValue.textContent = state.speed; elements.speed.style.setProperty('--fill', `${(state.speed - 100) / 8}%`); saveSettings(); renderReader(); if (state.playing) { clearTimeout(state.timer); scheduleNext(); } }

function openDialog() { stop(); setTab('upload'); elements.dialog.showModal(); elements.dialog.querySelector('.dialog-tab.active').focus(); }
function closeDialog() { elements.dialog.close(); }
function setTab(tab) { state.tab = tab; document.querySelectorAll('.dialog-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab)); $('#paste-fields').hidden = tab !== 'paste'; $('#upload-fields').hidden = tab !== 'upload'; $('#link-fields').hidden = tab !== 'link'; $('#article-url').disabled = tab !== 'link'; elements.error.textContent = ''; }
function addBook(title, author, text, metadata = {}) {
  const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `book-${Date.now()}`;
  const colors = ['#8c9f96', '#a99a8c', '#8d9daa', '#9f9b7d', '#9f8997'];
  const previousId = state.activeId;
  state.books.unshift({ id, title, author, text, position: 0, color: colors[state.books.length % colors.length], glyph: '✦', ...metadata });
  state.activeId = id;
  if (!save()) { state.books.shift(); state.activeId = previousId; elements.error.textContent = 'This browser has no room to save that text. Try a shorter one.'; return; }
  renderShelf(); renderReader(); elements.form.reset(); elements.selectedFile.textContent = ''; closeDialog();
}

$('#header-add').addEventListener('click', openDialog);
$('#shelf-add').addEventListener('click', openDialog);
$('#empty-add').addEventListener('click', openDialog);
$('#close-dialog').addEventListener('click', closeDialog);
elements.dialog.addEventListener('click', event => { if (event.target === elements.dialog) closeDialog(); });
document.querySelectorAll('.dialog-tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
elements.file.addEventListener('change', () => { const file = elements.file.files[0]; elements.selectedFile.textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : ''; });
elements.form.addEventListener('submit', async event => {
  event.preventDefault(); elements.error.textContent = '';
  const button = elements.form.querySelector('.submit-button');
  button.disabled = true; button.innerHTML = 'Importing… <span>↗</span>';
  try {
    if (state.tab === 'paste') {
      const text = $('#text-content').value.trim(), title = $('#text-title').value.trim();
      if (!title || !text) throw new Error('Add a title and some text to continue.');
      addBook(title, $('#text-author').value.trim() || 'Your bookshelf', text, { kind: 'text' });
    } else {
      const parsed = state.tab === 'upload' ? await TesokeuImport.file(elements.file.files[0]) : await TesokeuImport.article($('#article-url').value.trim());
      addBook(parsed.title, parsed.author, parsed.text, { kind: parsed.kind, sourceUrl: parsed.sourceUrl || null });
    }
  } catch (error) { elements.error.textContent = error.message || 'This import could not be completed.'; }
  finally { button.disabled = false; button.innerHTML = 'Add to bookshelf <span>↗</span>'; }
});
elements.play.addEventListener('click', () => togglePlay());
$('#back-button').addEventListener('click', () => { const wasPlaying = state.playing; stop(); setPosition((activeBook()?.position || 0) - 10); if (wasPlaying) togglePlay(false); });
$('#forward-button').addEventListener('click', () => { const wasPlaying = state.playing; stop(); setPosition((activeBook()?.position || 0) + 10); if (wasPlaying && activeBook()?.position < activeWords().length) togglePlay(false); });
$('#word-jump').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#word-number'), number = Number(input.value);
  if (!Number.isInteger(number) || number < 1 || number > activeWords().length) return;
  stop(); setPosition(number - 1); input.blur();
});
elements.speed.addEventListener('input', event => changeSpeed(event.target.value));
$('#position-slider').addEventListener('input', event => { const index = clampPosition(event.target.value); $('#position-preview').textContent = `${Math.round(100 * index / Math.max(1, activeWords().length))}% · ${positionExcerpt(index)}`; });
$('#position-slider').addEventListener('change', event => { stop(); setPosition(event.target.value); $('#position-slider').blur(); });
$('#bookmark-add').addEventListener('click', () => { const book = activeBook(); if (!book) return; const index = clampPosition(book.position, activeWords().length - 1); book.bookmarks = Array.isArray(book.bookmarks) ? book.bookmarks : []; if (!book.bookmarks.includes(index)) { book.bookmarks.push(index); save(); } renderBookmarks(); });
function updateFocusButton() { const active = document.fullscreenElement === $('#reader') || $('#reader').classList.contains('focus-overlay'); $('#fullscreen-toggle').textContent = active ? '×' : '⛶'; $('#fullscreen-toggle').setAttribute('aria-label', active ? 'Exit focus view' : 'Enter focus view'); }
$('#fullscreen-toggle').addEventListener('click', async () => {
  const reader = $('#reader');
  if (document.fullscreenElement === reader) { await document.exitFullscreen(); }
  else if (reader.classList.contains('focus-overlay')) { reader.classList.remove('focus-overlay'); document.body.classList.remove('focus-open'); }
  else { try { await reader.requestFullscreen(); } catch { reader.classList.add('focus-overlay'); document.body.classList.add('focus-open'); } }
  updateFocusButton();
});
document.addEventListener('fullscreenchange', updateFocusButton);
$('#reader-menu').addEventListener('click', () => { elements.menu.hidden = !elements.menu.hidden; });
$('#restart-option').addEventListener('click', () => { stop(); setPosition(0); elements.menu.hidden = true; });
$('#delete-option').addEventListener('click', () => { const book = activeBook(); if (!book || !window.confirm(`Remove “${book.title}” from your bookshelf?`)) return; stop(); state.books = state.books.filter(item => item.id !== book.id); state.activeId = state.books[0]?.id || null; save(); renderShelf(); renderReader(); elements.menu.hidden = true; });
$('#context-toggle').addEventListener('click', () => {
  const panel = $('#context-panel');
  panel.hidden = !panel.hidden;
  $('#context-toggle').textContent = panel.hidden ? 'View nearby text ↗' : 'Hide nearby text ↑';
  $('#context-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) { stop(); renderContext(); }
});
document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => { state.theme = button.dataset.theme; applyPreferences(); }));
document.querySelectorAll('[data-size]').forEach(button => button.addEventListener('click', () => { state.size = button.dataset.size; applyPreferences(); }));
$('#punctuation-toggle').addEventListener('change', event => { state.punctuation = event.target.checked; saveSettings(); if (state.playing) { clearTimeout(state.timer); scheduleNext(); } });
$('#long-word-toggle').addEventListener('change', event => { state.longWordPause = event.target.checked; saveSettings(); if (state.playing) { clearTimeout(state.timer); scheduleNext(); } });
document.addEventListener('click', event => { if (!event.target.closest('#reader-menu, #reader-options')) elements.menu.hidden = true; });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('#reader').classList.contains('focus-overlay')) { $('#reader').classList.remove('focus-overlay'); document.body.classList.remove('focus-open'); updateFocusButton(); return; }
  const tag = document.activeElement?.tagName;
  if (elements.dialog.open || event.altKey || event.ctrlKey || event.metaKey || document.activeElement?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
  if (event.code === 'Space' && ['BUTTON', 'A'].includes(tag)) return;
  if (event.repeat && event.code === 'Space') { event.preventDefault(); return; }
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  if (event.code === 'ArrowLeft') { event.preventDefault(); stop(); setPosition((activeBook()?.position || 0) - 10); }
  if (event.code === 'ArrowRight') { event.preventDefault(); stop(); setPosition((activeBook()?.position || 0) + 10); }
  if (event.code === 'ArrowUp') { event.preventDefault(); changeSpeed(state.speed + 25); }
  if (event.code === 'ArrowDown') { event.preventDefault(); changeSpeed(state.speed - 25); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing) stop(); });
window.addEventListener('pagehide', stop);
window.addEventListener('resize', fitRenderedWord);
document.fonts?.ready?.then(fitRenderedWord);

applyPreferences(); changeSpeed(state.speed); renderShelf(); renderReader();
