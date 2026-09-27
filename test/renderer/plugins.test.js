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

test("Note Cards retains data across disable and re-enable", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ lib: { authors: [{ id: "a1", name: "A. Writer", plugins: ["noteCards"] }] }, init: `
    const data = {};
    api.readJSON = async (b,n,f) => data[b+':'+n] || f;
    api.writeJSON = async (b,n,d) => { data[b+':'+n] = JSON.parse(JSON.stringify(d)); calls.push(['writeJSON',b,n,d]); };
  ` });
  try {
    await r.openBook();
    await r.page.click('[data-tab="cards"]');
    await r.page.click(".add-card");
    await r.page.locator(".note-card-title").fill("Keep this research");
    await r.page.evaluate(() => NeoPlugins.setEnabled("noteCards", false));
    assert.equal(await r.page.locator('[data-tab="cards"]').count(), 0);
    await r.page.evaluate(() => NeoPlugins.setEnabled("noteCards", true));
    await r.page.click('[data-tab="cards"]');
    assert.equal(await r.page.locator(".note-card-title").textContent(), "Keep this research");
    assert.equal(await r.page.locator(".note-card").count(), 1);
    assert.deepEqual(r.errors, []);
  } finally { await r.close(); }
});

test("Git enablement migrates to library scope and disabling stops automatic backup", async (t) => {
  if (skip(t)) return;
  const r = await openNeo({ lib: { authors: [{ id: "a1", name: "One", plugins: ["github"] }, { id: "a2", name: "Two" }], history: { enabled: true, git: { enabled: true, autoPush: true } } } });
  try {
    await r.menu({ type: "syncSettings" });
    assert.equal(await r.page.locator("#sy-git-remote").count(), 1);
    await r.page.locator(".sync-settings-modal .m-cancel").first().click();
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
    await r.menu({ type: "stats" });
    await r.page.fill("#st-language", "de");
    await r.page.click(".stats-modal .m-ok");
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
    api.writeJSON = (b,n,d) => new Promise((resolve) => {
      window.__finishCards = () => { calls.push(['writeJSON',b,n,d]); resolve(true); };
    });
  ` });
  try {
    await r.openBook();
    await r.page.click('[data-tab="cards"]');
    await r.page.click(".add-card");
    await r.page.waitForFunction(() => typeof window.__finishCards === "function");
    await r.page.click("#back-to-shelf");
    assert.equal(await r.page.locator("#editor-view").isVisible(), true);
    await r.page.evaluate(() => window.__finishCards());
    await r.page.waitForFunction(() => document.querySelector("#editor-view").hidden);
    assert.equal((await r.calls("writeJSON")).length, 1);
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
