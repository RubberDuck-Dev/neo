// Loads NEO's renderer (index.html + renderer/*.js) in headless Chromium with
// an in-memory stand-in for the window.neo bridge. Tests drive it the way a
// writer would: menu messages, clicks, typing. Nothing touches the disk.
//
//   const r = await openNeo({ init: 'api.x = async () => 1;', lib: {...} });
//   await r.openBook();
//   await r.menu({ type: 'revisionPass' });
//   r.errors  // page errors and console errors, should stay empty
//
// Needs Playwright's Chromium: `npx playwright install chromium` once.

'use strict';
const path = require('path');

const INDEX = 'file://' + path.join(__dirname, '..', '..', 'index.html').replace(/\\/g, '/');
const CH1 = '<p>Katherine opened the door slowly. She really just wanted the door to stay shut, but the door swung wide.</p>' +
  '<p>Outside, Katherine saw the garden. It was very quiet and she began to walk quickly toward the gate.</p>' +
  '<p>“Katharine,” someone called. Katherine turned. The gate creaked.</p>';
const CH2 = '<p>Morning came. Katherine and Tomas drank coffee in the garden.</p>';

let chromium = null;
function browserType() {
  if (!chromium) chromium = require('playwright').chromium;
  return chromium;
}

async function canLaunch() {
  try {
    const b = await browserType().launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
}

async function openNeo({ init = '', lib = {}, chapters = null } = {}) {
  const browser = await browserType().launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(({ init, lib, chapters, CH1, CH2 }) => {
    const calls = [];
    window.__calls = calls;
    const book = { id: 'book-1', title: 'The Gate', author: 'A. Writer', chapterOrder: ['c1', 'c2'], chapterTitles: {}, chapterNotes: {}, tabNames: { notes: 'Notes', outline: 'Outline' }, wordGoal: 0 };
    const library = { authorName: 'A. Writer', authors: [{ id: 'a1', name: 'A. Writer' }], currentAuthorId: 'a1', firstRunDone: true, hintShown: true, pageTheme: 'night', shelves: [{ id: 's1', name: 'WIP', bookIds: ['book-1'] }], history: { enabled: true }, ...lib };
    const text = chapters || { c1: CH1, c2: CH2 };
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const api = {
      logError: async (message) => { console.error(message); calls.push(["logError", message]); },
      readLibrary: async () => clone(library),
      writeLibrary: async (d) => { calls.push(['writeLibrary', clone(d)]); return true; },
      readBookMeta: async () => clone(book),
      writeBookMeta: async (id, m) => { calls.push(['writeBookMeta', clone(m)]); return true; },
      readChapter: async (b, c) => text[c] || '',
      writeChapter: async (b, c, h) => { calls.push(['writeChapter', c, h]); return true; },
      readAux: async () => '',
      readJSON: async (b, n, f) => f,
      createCheckpoint: async (b, r) => { calls.push(['checkpoint', r]); return { id: 'x', createdAt: new Date().toISOString() }; },
      gitStatus: async () => ({ available: true, initialized: false }),
      onMenu: (cb) => { window.__menu = cb; },
      appVersion: async () => '0.0.0', libraryPath: async () => '/tmp',
      spellCheckWords: async (w) => Object.fromEntries(w.map((x) => [x, true])),
      readCover: async () => null,
    };
    // eslint-disable-next-line no-eval
    eval(init);
    window.neo = new Proxy(api, {
      get: (t, k) => (k in t ? t[k] : (...a) => {
        calls.push([k, ...a]);
        return k === 'flushComplete' || k === 'poetryState' ? undefined : Promise.resolve(null);
      }),
    });
  }, { init, lib, chapters, CH1, CH2 });
  await page.goto(INDEX);
  await page.waitForTimeout(600);

  return {
    browser, page, errors,
    menu: (msg) => page.evaluate((m) => window.__menu(m), msg),
    calls: (name) => page.evaluate((n) => window.__calls.filter((c) => c[0] === n), name),
    lastCall: async (name) => (await page.evaluate((n) => window.__calls.filter((c) => c[0] === n).pop(), name)),
    async openBook() {
      await page.click('[data-id="book-1"], .book');
      await page.waitForTimeout(600);
    },
    highlight: (name) => page.evaluate((n) => {
      const h = CSS.highlights.get(n);
      return h ? [...h].map((r) => r.toString()) : null;
    }, name),
    close: () => browser.close(),
  };
}

module.exports = { openNeo, canLaunch };
