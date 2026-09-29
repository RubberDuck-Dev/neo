"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openNeo, canLaunch } = require("../helpers/renderer");
let launchable;
test.before(async () => { launchable = await canLaunch(); });
function skip(t) { if (!launchable) { t.skip("Chromium unavailable"); return true; } return false; }

test("sprints clean up on book close and re-enable without duplicate controls", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ lib: { authors: [{ id: "a1", name: "A. Writer", plugins: ["sprints"] }] } });
  try {
    await r.openBook();
    await r.menu({ type: "stats" });
    assert.equal(await r.page.locator('.stats-sprint-time[aria-pressed="true"]').getAttribute('data-minutes'), '20');
    await r.page.click("#st-timer-sprint");
    assert.equal(await r.page.locator("#sprint-controls").count(), 1);
    await r.page.click("#back-to-shelf");
    await r.page.waitForTimeout(1200);
    assert.equal(await r.page.locator("#sprint-controls").count(), 0);
    await r.openBook();
    assert.equal(await r.page.locator("#sprint-controls").count(), 1);
    await r.page.evaluate(() => NeoPlugins.setEnabled("sprints", false));
    assert.equal(await r.page.locator("#sprint-controls").count(), 0);
    await r.page.evaluate(() => NeoPlugins.setEnabled("sprints", true));
    assert.equal(await r.page.locator("#sprint-controls").count(), 1);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("sprint timer offers quick durations and validates custom minutes", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ lib: { authors: [{ id: "a1", name: "A. Writer", plugins: ["sprints"] }] } });
  try {
    await r.openBook();
    await r.menu({ type: "stats" });
    assert.deepEqual(await r.page.locator('.stats-sprint-time').evaluateAll(buttons => buttons.map(b => b.dataset.minutes)), ['10', '20', '30', 'custom']);
    await r.page.click('.stats-sprint-time[data-minutes="10"]');
    await r.page.click('#st-timer-sprint');
    assert.match(await r.page.locator('#goal-counter').textContent(), /^10:00$/);
    await r.menu({ type: "stats" });
    assert.match(await r.page.locator('#st-sprint-remaining').textContent(), /^(10:00|9:59)$/);
    assert.equal(await r.page.locator('#st-sprint-pause').textContent(), 'Pause');
    assert.equal(await r.page.locator('#st-sprint-state').textContent(), 'remaining');
    assert.equal(await r.page.locator('#st-sprint-pause').evaluate(el => {
      const sample = document.createElement('span');
      sample.style.backgroundColor = 'var(--accent)';
      document.body.appendChild(sample);
      const matches = getComputedStyle(el).backgroundColor === getComputedStyle(sample).backgroundColor;
      sample.remove();
      return matches;
    }), true);
    await r.page.click('#st-sprint-pause');
    assert.equal(await r.page.locator('#st-sprint-pause').textContent(), 'Resume');
    assert.equal(await r.page.locator('#st-sprint-state').textContent(), 'paused');
    await r.page.click('#st-sprint-pause');
    assert.equal(await r.page.locator('#st-sprint-pause').textContent(), 'Pause');
    await r.page.click('#st-sprint-end');
    await r.page.click('.stats-sprint-time[data-minutes="custom"]');
    assert.equal(await r.page.locator('.stats-sprint-custom').isVisible(), true);
    assert.equal(await r.page.locator('.stats-sprint-custom').evaluate(el => el.parentElement.classList.contains('stats-sprint-time-options')), true);
    const customBox = await r.page.locator('#st-sprint-minutes').boundingBox();
    const choiceBox = await r.page.locator('.stats-sprint-time[data-minutes="custom"]').boundingBox();
    const startBox = await r.page.locator('#st-timer-sprint').boundingBox();
    assert.ok(Math.abs((customBox.y + customBox.height / 2) - (choiceBox.y + choiceBox.height / 2)) < 8, 'custom minutes stays on the duration row');
    assert.ok(Math.abs((startBox.y + startBox.height / 2) - (choiceBox.y + choiceBox.height / 2)) < 8, 'Start timer is vertically centered');
    await r.page.setViewportSize({ width: 420, height: 740 });
    const narrowCustom = await r.page.locator('#st-sprint-minutes').boundingBox();
    const narrowChoice = await r.page.locator('.stats-sprint-time[data-minutes="custom"]').boundingBox();
    assert.ok(Math.abs((narrowCustom.y + narrowCustom.height / 2) - (narrowChoice.y + narrowChoice.height / 2)) < 8, 'custom minutes stays inline in a narrow window');
    await r.page.click('#st-timer-sprint');
    assert.match(await r.page.locator('.stats-sprint-error').textContent(), /whole number/);
    await r.page.fill('#st-sprint-minutes', '13');
    await r.page.click('#st-timer-sprint');
    assert.match(await r.page.locator('#goal-counter').textContent(), /^13:00$/);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("Note Cards retains data across disable and re-enable", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ lib: { authors: [{ id: "a1", name: "A. Writer", plugins: ["noteCards"] }] }, init: `
    const data = {};
    api.readJSON = async (b,n,f) => data[b+':'+n] || f;
    api.writeJSON = async (b,n,d) => { data[b+':'+n] = JSON.parse(JSON.stringify(d)); calls.push(['writeJSON',b,n,d]); };
  ` });
  try {
    await r.openBook();
    await r.page.click('[data-tab="outline"]');
    await r.page.click('[data-outline-view="cards"]');
    await r.page.click(".add-card");
    await r.page.locator(".note-card-title").last().fill("Keep this research");
    await r.page.evaluate(() => NeoPlugins.setEnabled("noteCards", false));
    assert.equal(await r.page.locator('[data-tab="cards"]').count(), 0);
    await r.page.evaluate(() => NeoPlugins.setEnabled("noteCards", true));
    await r.page.click('[data-tab="outline"]');
    await r.page.click('[data-outline-view="cards"]');
    assert.equal(await r.page.locator(".note-card-title").last().textContent(), "Keep this research");
    assert.equal(await r.page.locator(".note-card").count(), 3);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("Git enablement migrates to library scope and disabling stops automatic backup", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ lib: { authors: [{ id: "a1", name: "One", plugins: ["github"] }, { id: "a2", name: "Two" }], history: { enabled: true, git: { enabled: true, autoPush: true } } } });
  try {
    await r.menu({ type: "syncSettings" });
    assert.equal(await r.page.locator("#sy-git-remote").count(), 0);
    await r.page.locator(".sync-settings-modal .m-cancel").first().click();
    await r.page.evaluate(() => NeoPlugins.call("github", "configure"));
    assert.equal(await r.page.locator("#sy-git-remote").count(), 1);
    await r.page.locator(".github-settings-modal .m-ok").click();
    await r.page.evaluate(async () => { library.currentAuthorId = "a2"; await renderShelves(); });
    assert.equal(await r.page.evaluate(() => NeoPlugins.enabled("github")), true);
    await r.page.evaluate(() => NeoPlugins.setEnabled("github", false));
    const saved = (await r.lastCall("writeLibrary"))[1];
    assert.equal(saved.history.git.enabled, false);
    assert.equal(saved.history.git.autoPush, false);
    assert.equal(saved.history.enabled, true);
    await r.menu({ type: "syncSettings" });
    assert.equal(await r.page.locator("#sy-git-remote").count(), 0);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("moving authors and deleting the final shelf preserves every book", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ lib: { authors: [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }] } });
  try {
    await r.page.evaluate(() => moveBookToAuthor("book-1", "a2"));
    assert.equal((await r.lastCall("writeBookMeta"))[1].author, "Two");
    let saved = (await r.lastCall("writeLibrary"))[1];
    const destination = saved.shelves.find((s) => s.bookIds.includes("book-1"));
    assert.equal(destination.authorId, "a2");
    await r.page.evaluate((id) => deleteShelf(id), destination.id);
    saved = (await r.lastCall("writeLibrary"))[1];
    assert.equal(saved.shelves.some((s) => s.id === destination.id), false);
    assert.equal(saved.shelves.flatMap((s) => s.bookIds).filter((id) => id === "book-1").length, 1);
    assert.equal(saved.shelves.find((s) => s.bookIds.includes("book-1")).name, "Unsorted");
    await r.page.evaluate(() => deleteShelf("s1"));
    assert.equal((await r.lastCall("writeLibrary"))[1].shelves.some((s) => s.id === "s1"), false);
    assert.equal((await r.calls("deleteBook")).length, 0);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("export language is independent of dictionary selection", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ lib: { spellLanguage: "fr" } });
  try {
    await r.openBook();
    assert.equal(await r.page.evaluate(() => bookExportData().language), "en");
    await r.menu({ type: "publishingDetails" });
    await r.page.selectOption("#pub-language", "de");
    await r.page.click(".pub-modal .m-ok");
    assert.equal(await r.page.evaluate(() => bookExportData().language), "de");
    assert.equal(await r.page.evaluate(() => library.spellLanguage), "fr");
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("palette state changes with authors and Story Map writes only its own metadata", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ lib: { authors: [
    { id: "a1", name: "One", plugins: ["palette", "storyMap"], pluginPalette: "ink" },
    { id: "a2", name: "Two", plugins: ["palette"], pluginPalette: "moss" }
  ] } });
  try {
    assert.equal(await r.page.getAttribute("body", "data-palette"), "ink");
    await r.page.evaluate(async () => { library.currentAuthorId = "a2"; await renderShelves(); });
    assert.equal(await r.page.getAttribute("body", "data-palette"), "moss");
    await r.page.evaluate(async () => { library.currentAuthorId = "a1"; await renderShelves(); });
    await r.openBook();
    await r.page.click('[data-tab="outline"]');
    await r.page.locator('[data-story-field="thread"]').first().fill("The missing letter");
    await r.page.locator('[data-story-field="thread"]').first().blur();
    await r.page.waitForTimeout(950);
    const meta = (await r.lastCall("writeBookMeta"))[1];
    assert.equal(meta.storyMap.c1.thread, "The missing letter");
    assert.equal(meta.title, "The Gate");
    await r.page.evaluate(() => NeoPlugins.setEnabled("storyMap", false));
    assert.equal(await r.page.locator(".story-map-summary").count(), 0);
    assert.equal(await r.page.evaluate(() => book.storyMap.c1.thread), "The missing letter");
    await r.page.evaluate(() => NeoPlugins.setEnabled("palette", false));
    assert.equal(await r.page.getAttribute("body", "data-palette"), "classic");
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test('Palette Studio and Format share each pen name’s manuscript font', async (t) => {
  if (!launchable) return t.skip('Chromium not installed');
  const r = await openNeo({ lib: { authors: [
    { id: 'a1', name: 'One', plugins: ['palette'] },
    { id: 'a2', name: 'Two', plugins: ['palette'] }
  ] } });
  try {
    await r.page.evaluate(() => NeoPlugins.call('palette', 'configure'));
    const options = await r.page.locator('[data-studio-font] option').allTextContents();
    const chosen = options.find(name => name !== options[0]);
    await r.page.selectOption('[data-studio-font]', { label: chosen });
    await r.page.waitForFunction(name => library.authors[0].bodyFont === name, chosen);
    assert.equal(await r.page.locator('.palette-preview').evaluate(el => el.style.getPropertyValue('--preview-font').includes('Georgia') || !!el.style.getPropertyValue('--preview-font')), true);
    await r.page.click('.palette-studio-screen .dialog-close');
    await r.menu({ type: 'bodyFont', value: options[0] });
    assert.equal(await r.page.evaluate(() => library.authors[0].bodyFont), options[0]);
    await r.page.evaluate(() => NeoPlugins.call('palette', 'configure'));
    assert.equal(await r.page.locator('[data-studio-font]').inputValue(), options[0]);
    await r.page.click('.palette-studio-screen .dialog-close');
    await r.page.evaluate(() => { library.currentAuthorId = 'a2'; renderShelves(); });
    await r.page.waitForTimeout(250);
    assert.equal(await r.page.evaluate(() => currentAuthor().bodyFont || null), null);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("pending spelling responses cannot repaint after disabling", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ init: `
    api.spellCheckWords = (words) => new Promise((resolve) => {
      window.__finishSpell = () => resolve(Object.fromEntries(words.map((word) => [word, false])));
    });
  ` });
  try {
    await r.openBook();
    await r.page.click('.chapter-body');
    await r.menu({ type: "spellcheck" });
    await r.page.waitForFunction(() => typeof window.__finishSpell === "function");
    await r.page.evaluate(() => NeoPlugins.setEnabled("spellcheck", false));
    await r.page.evaluate(() => window.__finishSpell());
    await r.page.waitForTimeout(100);
    assert.equal(await r.page.evaluate(() => CSS.highlights.has("neo-spell")), false);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("closing a book waits for outstanding card writes", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ lib: { authors: [{ id: "a1", name: "A. Writer", plugins: ["noteCards"] }] }, init: `
    const originalWrite = api.writeBookMeta;
    api.writeBookMeta = (b,m) => {
      if (!window.__holdCards) return originalWrite(b,m);
      return new Promise(resolve => { (window.__cardWrites ||= []).push(() => { calls.push(['writeBookMeta',b,m]); resolve(true); }); });
    };
    window.__finishCards = () => { window.__holdCards=false; window.__cardWrites.splice(0).forEach(f=>f()); };
  ` });
  try {
    await r.openBook();
    await r.page.click('[data-tab="outline"]');
    await r.page.click('[data-outline-view="cards"]');
    await r.page.evaluate(()=>{window.__holdCards=true;});
    await r.page.click(".add-card");
    // Metadata writes are serialized now, so only the first reaches the bridge
    // until it is released; the close must still wait for that pending write.
    await r.page.waitForFunction(() => window.__cardWrites?.length >= 1);
    await r.page.click("#back-to-shelf");
    assert.equal(await r.page.locator("#editor-view").isVisible(), true);
    await r.page.evaluate(() => window.__finishCards());
    await r.page.waitForFunction(() => document.querySelector("#editor-view").hidden);
    assert.ok((await r.calls("writeBookMeta")).length >= 2);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("a failed optional counter cannot stop editing or saving", async (t) => {
  if (skip(t)) return;
  const r = await openNeo();
  try {
    await r.openBook();
    await r.page.evaluate(async () => {
      NeoPlugins.define("broken-test", { scope: "library", defaultEnabled: true }, () => ({ counter() { throw new Error("test counter failure"); } }));
      await NeoPlugins.reconcile();
    });
    const body = r.page.locator(".chapter-body").first();
    await body.click();
    await r.page.keyboard.type("Still writing");
    await r.page.waitForTimeout(1000);
    assert.ok((await r.calls("writeChapter")).some((call) => call[2].includes("Still writing")));
    assert.ok((await r.calls("logError")).some((call) => call[1].includes("test counter failure")));
    assert.ok(r.errors.every((error) => error.includes("test counter failure")));
  } finally { await r.close(); }
});
