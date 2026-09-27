'use strict';
// NEO Pocket: the same renderer inside the Android shell's page, talking to
// the real pocket-bridge.js over an in-memory stand-in for Capacitor's
// Filesystem plugin. Catches the renderer relying on markup or bridge calls
// Pocket doesn't have — which stops the whole app loading on the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canLaunch } = require('../helpers/renderer');

const ROOT = path.join(__dirname, '..', '..');
let launchable = false;
let www = null;

test.before(async () => {
  launchable = await canLaunch();
  // what the Pocket workflow assembles: pocket/www plus the desktop's shared files
  www = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pocket-'));
  fs.cpSync(path.join(ROOT, 'pocket', 'www'), www, { recursive: true });
  fs.cpSync(path.join(ROOT, 'renderer'), path.join(www, 'renderer'), { recursive: true });
  for (const dir of ['plugins', 'shared', 'locales']) fs.cpSync(path.join(ROOT, dir), path.join(www, dir), { recursive: true });
  for (const f of ['covers.js', 'styles.css']) fs.copyFileSync(path.join(ROOT, f), path.join(www, f));
  fs.mkdirSync(path.join(www, 'fonts'));
  for (const f of fs.readdirSync(path.join(ROOT, 'fonts')).filter((n) => n.endsWith('.woff2'))) fs.copyFileSync(path.join(ROOT, 'fonts', f), path.join(www, 'fonts', f));
});

const library = {
  authorName: 'A. Writer', authors: [{ id: 'a1', name: 'A. Writer' }], currentAuthorId: 'a1', firstRunDone: true, hintShown: true,
  shelves: [{ id: 's1', name: 'WIP', bookIds: ['book-1'] }],
};
const files = {
  'NEO Library/library.json': JSON.stringify(library),
  'NEO Library/book-1/book.json': JSON.stringify({ id: 'book-1', title: 'The Gate', author: 'A. Writer', chapterOrder: ['c1'], tabNames: { notes: 'Notes', outline: 'Outline' } }),
  'NEO Library/book-1/chapters/c1.html': '<p>Katherine opened the green door.</p><p>The garden was green.</p>',
};

async function openPocket(ios = false) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('missing: ' + r.url().replace(/^.*neo-pocket-[^/]+\//, '')));
  await page.addInitScript(({seed, ios}) => {
    const store = new Map(Object.entries(seed));
    window.__files = store;
    window.__cloudFetch = [];
    const norm = (p) => decodeURI(String(p)).replace('file:///icloud/NEO Library', 'NEO Library').replace(/\/+$/, '');
    const Filesystem = {
      async mkdir() {},
      async readFile({ path }) { if (!store.has(norm(path))) throw new Error('File does not exist'); return { data: store.get(norm(path)) }; },
      async writeFile({ path, data }) { store.set(norm(path), data); return {}; },
      async deleteFile({ path }) { store.delete(norm(path)); },
      async readdir({ path }) {
        const prefix = norm(path) + '/';
        const names = new Set([...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0]));
        return { files: [...names].map((name) => ({ name })) };
      },
      async getUri({ path }) { return { uri: 'file:///pocket/' + path }; },
      async stat({ path }) { if (!store.has(norm(path))) throw new Error('missing'); return { type: 'file' }; },
    };
    window.Capacitor = { getPlatform: () => ios ? 'ios' : 'android', Plugins: { Filesystem, LibraryHome: { locate: async () => ({path: 'file:///icloud/NEO%20Library', cloud: true}), fetch: async (options) => { window.__cloudFetch.push(options); } } }, convertFileSrc: (u) => u, isNativePlatform: () => true };
  }, { seed: files, ios });
  await page.goto('file://' + path.join(www, 'index.html').replace(/\\/g, '/'));
  await page.waitForTimeout(800);
  return { browser, page, errors };
}

test('Pocket loads the shared renderer without errors and saves to the library', async (t) => {
  if (!launchable) return t.skip('Chromium not installed (npx playwright install chromium)');
  const { browser, page, errors } = await openPocket();
  try {
    assert.ok(await page.$('.book'), 'the shelf shows the book');
    await page.click('.book');
    await page.waitForTimeout(600);
    await page.click('.chapter-body p:last-child');
    await page.keyboard.press('End');
    await page.keyboard.type(' Typed on the phone.');
    await page.waitForTimeout(1500);
    const saved = await page.evaluate(() => window.__files.get('NEO Library/book-1/chapters/c1.html'));
    assert.match(saved, /Typed on the phone\./);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Pocket: library search, Revision Pass and focus mode from the keyboard', async (t) => {
  if (!launchable) return t.skip('Chromium not installed (npx playwright install chromium)');
  const { browser, page, errors } = await openPocket();
  try {
    await page.click('#library-search-btn');
    await page.keyboard.type('green');
    await page.waitForTimeout(500);
    assert.match(await page.$eval('.lsearch-summary', (e) => e.textContent), /2 matches in 1 book/);
    await page.click('.lsearch-hit');
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape'); // close Find
    await page.click('.chapter-body p');
    await page.keyboard.press('Control+Shift+Semicolon');
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => CSS.highlights.has('neo-rev-echo')), 'Revision Pass runs');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+KeyO');
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => document.body.classList.contains('focus-mode')));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Pocket iOS uses LibraryHome URLs and requests cloud files before reading', async t => {
  if(!launchable)return t.skip('Chromium unavailable');
  const {browser,page,errors}=await openPocket(true);
  try {
    assert.equal(await page.evaluate(()=>window.neo.libraryPath()),'file:///icloud/NEO%20Library');
    await page.click('.book'); await page.waitForTimeout(600);
    assert.match(await page.locator('.chapter-body').textContent(),/Katherine/);
    await page.click('.chapter-body p:last-child'); await page.keyboard.press('End'); await page.keyboard.type(' From iOS.');
    await page.waitForTimeout(1100);
    assert.match(await page.evaluate(()=>window.__files.get('NEO Library/book-1/chapters/c1.html')),/From iOS/);
    const fetched=await page.evaluate(()=>window.__cloudFetch);
    assert.ok(fetched.some(f=>f.path?.includes('/book-1/chapters/c1.html')));
    assert.equal((await page.evaluate(()=>window.neo.listBooks()))[0].id,'book-1');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
