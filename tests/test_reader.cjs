const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const path = require('node:path');

// Run the actual reader with a minimal DOM and deterministic timers.
function reader({ books, search = '' } = {}) {
  const nodes = new Map(), timers = new Map(), storage = new Map();
  let timerId = 0, writes = 0;
  function element(tagName = 'DIV') {
    return {
      tagName, children: [], listeners: {}, style: { setProperty() {} },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      dataset: {}, hidden: true, value: '', textContent: '', attributes: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      querySelector(selector) { return get(selector); },
      blur() { document.activeElement = null; },
      scrollIntoView() {},
    };
  }
  function get(selector) {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  }
  const document = {
    activeElement: null, hidden: false, listeners: {}, body: element(),
    querySelector: get, querySelectorAll: () => [], createElement: element,
    addEventListener(name, fn) { this.listeners[name] = fn; },
  };
  const window = { listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  const sample = { id: 'noticing', title: 'Test read', text: Array.from({ length: 100 }, (_, i) => `word${i + 1}`).join(' '), position: 0 };
  if (books) storage.set('stillword-library-v1', JSON.stringify({ books, activeId: books[0]?.id }));
  const context = vm.createContext({
    document, window, location: { search }, URLSearchParams, SAMPLE_BOOKS: [sample],
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); writes++; },
    },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  return {
    get, document, window, storage,
    run: code => vm.runInContext(code, context),
    writes: () => writes,
    click(selector) { get(selector).listeners.click({}); },
    tickWord() {
      const entry = [...timers].find(([, timer]) => timer.delay < 1000);
      assert.ok(entry, 'a word should be scheduled');
      timers.delete(entry[0]); entry[1].fn();
    },
    submitWord(value) { get('#word-number').value = value; get('#word-jump').listeners.submit({ preventDefault() {} }); },
  };
}

test('play, advance, pause, and reload preserve progress and activity', () => {
  const app = reader();
  app.click('#play-button');
  app.tickWord(); app.tickWord(); app.click('#play-button');
  assert.equal(app.get('#reader-position').textContent, '03 / 100');
  const library = JSON.parse(app.storage.get('stillword-library-v1'));
  const stats = JSON.parse(app.storage.get('tesokeu-stats-v1'));
  assert.equal(library.books[0].position, 2);
  assert.equal(stats.totalWords, 2);
  assert.equal(stats.sessions, 1);
  assert.equal(reader({ books: library.books }).get('#reader-position').textContent, '03 / 100');
});

test('skipping during playback keeps a single session', () => {
  const app = reader();
  app.click('#play-button'); app.tickWord(); app.click('#forward-button'); app.click('#back-button');
  assert.equal(app.run('state.stats.sessions'), 1);
  assert.equal(app.run('state.playing'), true);
  assert.equal(app.run('activeBook().position'), 1);
});

test('word navigation is one-based, pauses playback, and rejects invalid input', () => {
  const app = reader();
  app.click('#play-button'); app.submitWord('45');
  assert.equal(app.run('state.playing'), false);
  assert.equal(app.get('#display-word').attributes['aria-label'], 'word45');
  for (const value of ['0', '101', '1.5', '', 'bad']) app.submitWord(value);
  assert.equal(app.run('activeBook().position'), 44);
  app.submitWord('100');
  assert.equal(app.get('#display-word').attributes['aria-label'], 'word100');
});

test('playback batches storage writes and retains bookshelf links', () => {
  const app = reader();
  app.click('#play-button');
  const writes = app.writes(), shelf = app.get('#book-list').children[0];
  app.tickWord(); app.tickWord(); app.tickWord();
  assert.equal(app.writes(), writes);
  assert.equal(app.get('#book-list').children[0], shelf);
  app.window.listeners.pagehide();
  assert.equal(JSON.parse(app.storage.get('stillword-library-v1')).books[0].position, 3);
  assert.equal(app.run('state.playing'), false);
});

test('bookshelf books link to the dedicated reading page', () => {
  const app = reader({ books: [{ id: 'a book & notes', title: 'My read', text: 'one two three', position: 1 }] });
  const bookLink = app.get('#book-list').children[0];
  assert.equal(bookLink.tagName, 'a');
  assert.equal(bookLink.href, './reader.html?book=a%20book%20%26%20notes');
});

test('opening a book link remembers that book as the current read', () => {
  const books = [
    { id: 'first', title: 'First', text: 'one two', position: 0 },
    { id: 'second', title: 'Second', text: 'three four', position: 0 },
  ];
  const app = reader({ books, search: '?book=second' });
  assert.equal(app.get('#reader-title').textContent, 'Second');
  assert.equal(JSON.parse(app.storage.get('stillword-library-v1')).activeId, 'second');
});

test('hidden tabs pause and save the last completed word', () => {
  const app = reader(); app.click('#play-button'); app.tickWord();
  app.document.hidden = true; app.document.listeners.visibilitychange();
  assert.equal(app.run('state.playing'), false);
  assert.equal(JSON.parse(app.storage.get('stillword-library-v1')).books[0].position, 1);
});

test('leaving an idle reader does not overwrite a newly synced collection', () => {
  const app = reader();
  const remote = JSON.stringify({ books: [], activeId: null });
  app.storage.set('stillword-library-v1', remote);
  app.window.listeners.pagehide();
  assert.equal(app.storage.get('stillword-library-v1'), remote);
});

test('missing or invalid saved positions cannot corrupt playback', () => {
  for (const position of [undefined, '2', -4, 300]) {
    const app = reader({ books: [{ id: 'test', title: 'Test', text: 'one two three', position }] });
    app.click('#play-button'); app.tickWord(); app.click('#play-button');
    assert.ok(Number.isInteger(app.run('activeBook().position')));
    assert.ok(app.run('activeBook().position >= 0 && activeBook().position <= 3'));
  }
});

test('an unknown book link cannot move another book', () => {
  const app = reader({ search: '?book=missing&at=60' });
  assert.equal(app.run('activeBook().position'), 0);
});

test('empty reads cannot start playback from a keyboard shortcut', () => {
  const app = reader({ books: [{ id: 'empty', title: 'Empty', text: ' ', position: 0 }] });
  app.run('togglePlay()');
  assert.equal(app.run('state.playing'), false);
  assert.equal(app.run('state.stats.sessions'), 0);
  assert.equal(app.get('#jump-word').disabled, true);
});

test('space preserves native button actions and ignores held-key repeats', () => {
  const app = reader(); let prevented = false;
  const event = { code: 'Space', preventDefault() { prevented = true; } };
  app.document.activeElement = { tagName: 'BUTTON' };
  app.document.listeners.keydown(event);
  assert.equal(prevented, false);
  assert.equal(app.run('state.playing'), false);
  app.document.activeElement = null;
  app.document.listeners.keydown(event);
  assert.equal(app.run('state.playing'), true);
  app.document.listeners.keydown({ ...event, repeat: true });
  assert.equal(app.run('state.playing'), true);
});

test('long words receive extra viewing time when the comprehension setting is on', () => {
  const app = reader();
  assert.equal(app.run("delayFor('short')"), 200);
  assert.equal(app.run("delayFor('characteristically')"), 270);
  app.get('#long-word-toggle').checked = false;
  app.get('#long-word-toggle').listeners.change({ target: app.get('#long-word-toggle') });
  assert.equal(app.run("delayFor('characteristically')"), 200);
});

test('opening nearby text pauses playback and exposes expanded state', () => {
  const app = reader();
  app.click('#play-button');
  app.click('#context-toggle');
  assert.equal(app.run('state.playing'), false);
  assert.equal(app.get('#context-toggle').attributes['aria-expanded'], 'true');
});
