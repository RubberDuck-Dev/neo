'use strict';
// The bookshelf, pen names, plugins, publishing, versions and sync windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openNeo, canLaunch } = require('../helpers/renderer');

let launchable = false;
test.before(async () => { launchable = await canLaunch(); });
const needsBrowser = (t) => { if (!launchable) { t.skip('Chromium not installed (npx playwright install chromium)'); return true; } return false; };

const metasStub = `
  const metas = { 'book-1': { ...book, author: 'Old Name' }, 'book-2': { id: 'book-2', title: 'The Well', author: 'Someone', chapterOrder: [], tabNames: { notes: 'Notes', outline: 'Outline' } } };
  api.readBookMeta = async (id) => JSON.parse(JSON.stringify(metas[id]));
  api.writeBookMeta = async (id, m) => { metas[id] = JSON.parse(JSON.stringify(m)); calls.push(['writeBookMeta', m]); return true; };
  window.__metas = metas;`;
const twoBooks = { shelves: [{ id: 's1', name: 'WIP', bookIds: ['book-1', 'book-2'] }] };

test('cover menus keep manual images and omit AI painting', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo({ init: `book.coverImage = 'cover-123.png'; book.coverMode = 'abstract';` });
  try {
    await r.page.locator('.book').first().click({ button: 'right' });
    const context = await r.page.locator('.modal-backdrop .fr-choice').allTextContents();
    assert.ok(context.some(label => label.includes('Replace cover art')));
    assert.ok(context.every(label => !/paint.*cover|AI cover/i.test(label)));
    await r.page.click('.modal-backdrop .m-cancel');
    await r.page.locator('.book').first().hover();
    await r.page.click('.book .b-refresh');
    const refresh = await r.page.locator('.modal-backdrop .fr-choice').allTextContents();
    assert.ok(refresh.some(label => label.includes('Show your cover art')));
    assert.ok(refresh.every(label => !/paint.*cover|AI cover/i.test(label)));
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('the title-page author and the pen name stay one name', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo({ init: metasStub, lib: twoBooks });
  try {
    const authors = () => r.page.evaluate(() => Object.values(window.__metas).map((m) => m.author));
    assert.deepEqual(await authors(), ['A. Writer', 'A. Writer'], 'older books brought in line on load');
    await r.openBook();
    await r.page.evaluate(() => { const el = document.querySelector('#tp-author'); el.focus(); el.textContent = 'Mark Megaw'; });
    await r.page.keyboard.press('Enter');
    await r.page.waitForTimeout(1200);
    assert.deepEqual(await authors(), ['Mark Megaw', 'Mark Megaw']);
    const lib = (await r.lastCall('writeLibrary'))[1];
    assert.equal(lib.authors[0].name, 'Mark Megaw');
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('library search from the shelf opens the book on the match', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo({ init: `api.searchLibrary = async () => [{ bookId: 'book-1', title: 'The Gate', count: 3, hits: [
    { chapterId: 'c1', chapterIndex: 0, chapterTitle: '', ordinal: 2, before: '…but the ', match: 'door', after: ' swung wide.' }] }];` });
  try {
    await r.menu({ type: 'find' }); // ⌘F on the shelf
    await r.page.keyboard.type('door');
    await r.page.waitForTimeout(450);
    await r.page.click('.lsearch-hit');
    await r.page.waitForTimeout(900);
    assert.equal(await r.page.$eval('#search-count', (e) => e.textContent), '3 of 3');
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('Writing Sprints only appear with the plugin installed', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo();
  try {
    await r.openBook();
    const sprintSection = async () => {
      await r.menu({ type: 'stats' });
      await r.page.waitForTimeout(150);
      const has = !!(await r.page.$('#st-word-sprint'));
      await r.page.click('.stats-modal .m-ok');
      await r.page.waitForTimeout(150);
      return has;
    };
    assert.equal(await sprintSection(), false);
    await r.menu({ type: 'plugins' });
    await r.page.click('[data-plugin="sprints"]');
    await r.page.waitForTimeout(200);
    assert.equal(await sprintSection(), true);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('Publishing Details: first manuscript export asks once, then exports', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo({ init: `api.exportSave = async (p) => { (window.__exports ||= []).push(p); return '/tmp/x'; };` });
  try {
    await r.openBook();
    await r.menu({ type: 'export', format: 'manuscript' });
    await r.page.waitForTimeout(200);
    assert.equal(await r.page.$eval('.pub-tabs .active', (b) => b.textContent), 'Manuscript');
    await r.page.fill('[data-f="legalName"]', 'Mark Example');
    await r.page.click('.pub-tabs [data-tab="matter"]');
    await r.page.fill('[data-m="about"]', 'Lives by the sea.');
    await r.page.click('.pub-modal .m-ok');
    await r.page.waitForTimeout(400);
    const exports = await r.page.evaluate(() => window.__exports);
    const doc = exports[0].zipEntries.find((e) => e.path === 'word/document.xml').content;
    assert.match(doc, /Mark Example/);
    assert.match(doc, /by A\. Writer/);
    assert.ok(!doc.includes('Lives by the sea'), 'end matter stays out of submissions');
    await r.menu({ type: 'export', format: 'txt' });
    await r.page.waitForTimeout(300);
    assert.match((await r.page.evaluate(() => window.__exports.at(-1).content)), /ABOUT THE AUTHOR[\s\S]*Lives by the sea/);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('Compare shows what changed since a version', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo({ init: `
    api.listCheckpoints = async () => [{ id: 'v1', valid: true, createdAt: '2026-09-25T10:00:00Z', reason: 'writing' }];
    api.readCheckpoint = async () => ({ createdAt: '2026-09-25T10:00:00Z', meta: { chapterOrder: ['c1', 'c2'] },
      chapters: { c1: '<p>Katherine opened the door. She wanted the door to stay shut, but the door swung wide.</p><p>Outside, Katherine saw the garden. It was very quiet and she began to walk quickly toward the gate.</p><p>“Katharine,” someone called. Katherine turned. The gate creaked.</p>', c2: '<p>Morning came. Katherine and Tomas drank coffee in the garden.</p>' } });` });
  try {
    await r.openBook();
    await r.menu({ type: 'syncSettings' });
    await r.page.click('#sy-history-versions');
    await r.page.waitForTimeout(250);
    await r.page.click('[data-compare="v1"]');
    await r.page.waitForTimeout(250);
    const summary = await r.page.$eval('.compare-modal', (m) => m.innerText);
    assert.match(summary, /1 chapter changed · \+3 \/ −0 words/);
    assert.deepEqual(await r.page.$$eval('.compare-modal ins', (a) => a.map((e) => e.textContent.trim()).filter(Boolean)), ['Added', 'slowly', 'really just']);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});
