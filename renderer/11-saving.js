"use strict";

/* ================================================================== */
/*  SAVING                                                             */
/* ================================================================== */

let checkpointTimer = null;

function historySettings() {
  return library.history || {};
}

function checkpointInterval() {
  const minutes = Number(historySettings().intervalMinutes) || 5;
  return Math.min(60, Math.max(5, minutes)) * 60 * 1000;
}

// Versions feed both local history and the GitHub backup; either one being
// on is reason enough to make them.
function versionsWanted() {
  const settings = historySettings();
  return settings.enabled !== false || !!(settings.git && settings.git.enabled);
}

async function checkpointNow(reason, bookId = book && book.id) {
  if (!book || !bookId || book.id !== bookId || !versionsWanted()) return;
  if (typeof window.neo.createCheckpoint !== "function") return; // NEO Pocket has no version history
  clearTimeout(checkpointTimer);
  checkpointTimer = null;
  flushAllSaves();
  await NeoPlugins.flush();
  // Chapter and metadata writes are serialized in the renderer. Wait for
  // their queues before asking the main process to snapshot the book.
  await waitForBookWrites();
  return window.neo.createCheckpoint(bookId, reason).catch((err) => {
    window.neo.logError(`checkpoint: ${err && err.stack ? err.stack : err}`);
  }).then((result) => {
    if (result && book?.id === bookId) lastCheckpointAt = new Date(result.createdAt);
  });
}

function scheduleCheckpoint(reason) {
  if (!book || !versionsWanted() || checkpointTimer) return;
  const bookId = book.id;
  checkpointTimer = setTimeout(() => {
    checkpointTimer = null;
    checkpointNow(reason, bookId);
  }, checkpointInterval());
}

// Leaving a book (or quitting) captures the writing since the last version
// instead of dropping it when the timer's book is gone.
function finishPendingCheckpoint(reason) {
  if (!checkpointTimer) return;
  return checkpointNow(reason);
}

// Track the last confirmed disk state. A shared library must not rewrite
// unchanged chapters on blur or when a checkpoint is taken.
const chapterWrites = new Map();
function persistChapter(chId, html = chapterHTML[chId] || '') {
  if (!book) return Promise.resolve(false);
  const bookId = book.id, key = bookId + '/' + chId;
  dirtyChapters.add(chId);
  const previous = chapterWrites.get(key) || Promise.resolve();
  const work = previous.then(() => window.neo.writeChapter(bookId, chId, html))
    .then(() => {
      if (book?.id === bookId && book.chapterOrder.includes(chId)) {
        savedHTML[chId] = html;
        if (chapterHTML[chId] === html) dirtyChapters.delete(chId);
      }
      lastSavedAt = new Date();
      return true;
    }).catch(err => { window.neo.logError(`chapter save: ${err?.stack || err}`); return false; });
  chapterWrites.set(key, work);
  work.finally(() => { if (chapterWrites.get(key) === work) chapterWrites.delete(key); });
  return work;
}

function scheduleChapterSave(chId) {
  dirtyChapters.add(chId);
  clearTimeout(saveTimers[chId]);
  saveTimers[chId] = setTimeout(() => saveChapterNow(chId), 800);
}

function saveChapterNow(chId) {
  if (!book || !book.chapterOrder.includes(chId) || !dirtyChapters.has(chId)) return Promise.resolve(false);
  return persistChapter(chId);
}

// Ignore per-device position and counters when comparing shared metadata.
function metaSig(meta) {
  if (!meta) return '';
  const stable = {};
  for (const key of Object.keys(meta).sort()) {
    if (['lastPosition','modified','wordCount','dailyCounts'].includes(key)) continue;
    const value = meta[key];
    if (value == null || value === '') continue;
    if (typeof value === 'object' && Object.keys(value).length === 0) continue;
    stable[key] = value;
  }
  return JSON.stringify(stable);
}

function scheduleMetaSave() {
  metaSavePending = true;
  clearTimeout(saveTimers.meta);
  saveTimers.meta = setTimeout(() => saveMeta(false), 800);
  scheduleCheckpoint("writing");
}
let metaWriteQueue = Promise.resolve();
function saveMeta(force = true) {
  if (!book || (!force && !metaSavePending)) return Promise.resolve(false);
  const bookId = book.id, sig = metaSig(book), snapshot = structuredClone(book);
  metaWriteQueue = metaWriteQueue.catch(() => {}).then(async () => {
    const stamp = await window.neo.writeBookMeta(bookId, snapshot);
    if (book?.id === bookId) {
      if (typeof stamp === 'string') book.modified = stamp;
      savedMetaSig = sig;
      metaSavePending = metaSig(book) !== sig;
      if (metaSavePending) scheduleMetaSave();
      lastSavedAt = new Date();
    }
    return true;
  }).catch(err => { window.neo.logError(`meta save: ${err?.stack || err}`); return false; });
  return metaWriteQueue;
}

function flushAllSaves() {
  if (!book) return;
  const position = {chapterId:currentChapterId, scroll:$('#paper-scroll').scrollTop};
  if (!book.lastPosition || book.lastPosition.chapterId !== position.chapterId || Math.abs((book.lastPosition.scroll || 0) - position.scroll) > 40) {
    book.lastPosition = position; metaSavePending = true;
  }
  for (const chId of book.chapterOrder) {
    if (chapterHTML[chId] !== undefined && (dirtyChapters.has(chId) || chapterHTML[chId] !== savedHTML[chId]) && !chapterWrites.has(book.id + '/' + chId)) persistChapter(chId);
  }
  flushAux();
  if (metaSavePending || metaSig(book) !== savedMetaSig) saveMeta();
}

async function waitForBookWrites() {
  for (let pass = 0; pass < 3; pass++) {
    await Promise.all([...chapterWrites.values(), metaWriteQueue]);
    if (!book) break;
    const pending = book.chapterOrder.filter(id => chapterHTML[id] !== undefined && chapterHTML[id] !== savedHTML[id]);
    if (!pending.length && !metaSavePending) break;
    await Promise.all(pending.map(id => persistChapter(id)));
    if (metaSavePending) await saveMeta(false);
  }
}

window.addEventListener("beforeunload", flushAllSaves);
// Focus loss preserves a changed caret/scroll position. The interval is only
// a safety net for an edit that still has a pending debounce; idle books do
// not write themselves to disk.
window.addEventListener("blur", () => {
  if (book) flushAllSaves();
});
setInterval(() => {
  if (book && (dirtyChapters.size || auxDirty || metaSavePending)) flushAllSaves();
}, 20000);

async function backToShelf() {
  await NeoPlugins.closeBook();
  if (revisionOn) toggleRevisionPass(false);
  stopReadAloud(true);
  flushAllSaves();
  await waitForBookWrites();
  await finishPendingCheckpoint("closed book");
  tabPlaces = {};
  dirtyChapters = new Set();
  metaSavePending = false;
  book = null;
  currentChapterId = null;
  undoStack = [];
  $("#editor-view").hidden = true;
  $("#bookshelf-view").hidden = false;
  await NeoPlugins.reconcile();
  renderShelves();
}
$("#back-to-shelf").onclick = backToShelf;
