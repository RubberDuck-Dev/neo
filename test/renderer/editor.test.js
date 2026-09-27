'use strict';
// The writing room: typing and saving, and the on-demand tools.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openNeo, canLaunch } = require('../helpers/renderer');

let launchable = false;
test.before(async () => { launchable = await canLaunch(); });
const needsBrowser = (t) => { if (!launchable) { t.skip('Chromium not installed (npx playwright install chromium)'); return true; } return false; };

test('typing saves the chapter; versions wait for the timer, then land on quit', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo();
  try {
    await r.openBook();
    await r.page.click('.chapter[data-id="c1"] .chapter-body p:last-child');
    await r.page.keyboard.press('End');
    await r.page.keyboard.type(' More words.');
    await r.page.keyboard.press('Shift+Enter');
    await r.page.keyboard.type('A line of verse');
    await r.page.keyboard.press('Enter');
    await r.page.keyboard.press('Enter');
    await r.page.waitForTimeout(1200);
    const saved = (await r.lastCall('writeChapter'))[2];
    assert.match(saved, /More words\./);
    assert.match(saved, /<p class="poetry"><i>A line of verse<\/i><\/p>/);
    assert.ok(!/focus-current|class=""/.test(saved), 'no rendering helpers in the saved file');
    assert.equal((await r.calls('checkpoint')).length, 0, 'no version per keystroke');
    await r.menu({ type: 'flush' });
    assert.deepEqual((await r.calls('checkpoint')).map((c) => c[1]), ['quit']);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('Revision Pass marks echoes, filler, adverbs and name slips; Esc clears it', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo();
  try {
    await r.openBook();
    await r.page.click('.chapter[data-id="c1"] .chapter-body p');
    await r.menu({ type: 'revisionPass' });
    await r.page.waitForTimeout(300);
    assert.ok((await r.highlight('neo-rev-echo')).includes('door'));
    assert.ok((await r.highlight('neo-rev-filler')).includes('began to'));
    assert.ok((await r.highlight('neo-rev-adverb')).includes('slowly'));
    assert.deepEqual(await r.highlight('neo-rev-name'), ['Katharine']);
    await r.page.keyboard.press('Escape');
    assert.equal(await r.highlight('neo-rev-echo'), null);
    assert.equal(await r.page.$eval('#editor-view', (e) => e.hidden), false, 'Esc ends the pass, not the book');
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('Read Aloud reads from the caret sentence with the chosen voice and speed', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo({
    lib: { readAloudVoice: 'Daniel', readAloudRate: 1.4 },
    init: `
      window.__spoken = [];
      const voices = [{ name: 'Samantha', lang: 'en-US' }, { name: 'Daniel', lang: 'en-GB' }];
      const synth = new EventTarget(); synth.getVoices = () => voices; synth.cancel = () => {};
      synth.speak = (u) => { window.__spoken.push([u.text, u.rate, u.voice && u.voice.name]); setTimeout(() => u.onend && u.onend(), 20); };
      Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };`,
  });
  try {
    await r.openBook();
    await r.page.evaluate(() => {
      const p = document.querySelectorAll('.chapter[data-id="c1"] .chapter-body p')[1];
      const range = document.createRange(); range.setStart(p.firstChild, 12); range.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await r.menu({ type: 'readAloud' });
    await r.page.waitForTimeout(400);
    const spoken = await r.page.evaluate(() => window.__spoken);
    assert.deepEqual(spoken[0], ['Outside, Katherine saw the garden.', 1.4, 'Daniel']);
    assert.equal(spoken.at(-1)[0], 'The gate creaked.');
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('Focus mode dims everything but the current paragraph', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo();
  try {
    await r.openBook();
    await r.menu({ type: 'focusMode' });
    await r.page.click('.chapter[data-id="c1"] .chapter-body p:nth-child(2)');
    await r.page.waitForTimeout(350);
    const text = await r.page.locator('.chapter[data-id="c1"] .chapter-body p:nth-child(2)').textContent();
    assert.deepEqual(await r.highlight('neo-focus'), [text]);
    assert.equal(await r.page.locator('body').evaluate(el => el.classList.contains('focus-mode')), true);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('Chapter status and Outline titles', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo();
  try {
    await r.openBook();
    await r.page.evaluate(() => { const p = document.querySelector('#nav-pane'); p.dataset.pinned = '1'; p.classList.add('open'); });
    await r.page.waitForTimeout(400);
    await r.page.click('.nav-item[data-id="c1"] .n-row', { button: 'right' });
    await r.page.click('.status-menu button:nth-child(3)');
    assert.equal(await r.page.$eval('#nav-head > span', (e) => e.textContent), 'Chapters · 1 of 2 done');
    await r.page.click('.tab[data-tab="outline"]');
    await r.page.waitForTimeout(200);
    await r.page.click('.ol-chapter .ol-title');
    await r.page.keyboard.type('The Gate Opens');
    await r.page.keyboard.press('Enter');
    await r.page.click('.tab[data-tab="manuscript"]');
    assert.equal(await r.page.$eval('.chapter[data-id="c1"] .ch-title', (e) => e.textContent), 'The Gate Opens');
    await r.page.waitForTimeout(900);
    const meta = (await r.lastCall('writeBookMeta'))[1];
    assert.equal(meta.chapterStatus.c1, 'done');
    assert.equal(meta.chapterTitles.c1, 'The Gate Opens');
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('word counts treat Chinese and Japanese characters as words', async (t) => {
  if (needsBrowser(t)) return;
  const r = await openNeo();
  try {
    const counts = await r.page.evaluate(() => [countWords('夜很深了。她推开门。'), countWords('Katherine 走进花园。'), countWords('The door, the gate.'), countWords('すべては、ここから。')]);
    assert.deepEqual(counts, [8, 5, 4, 8]);
  } finally { await r.close(); }
});
