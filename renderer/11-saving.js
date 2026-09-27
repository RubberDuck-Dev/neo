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
  // The main process queues these writes before the checkpoint request, so a
  // checkpoint always captures one coherent on-disk state.
  flushAllSaves();
  await NeoPlugins.flush();
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

function scheduleChapterSave(chId) {
  dirtyChapters.add(chId);
  clearTimeout(saveTimers[chId]);
  saveTimers[chId] = setTimeout(() => saveChapterNow(chId), 800);
}

function saveChapterNow(chId) {
  if (!book || !dirtyChapters.has(chId)) return;
  const html = chapterHTML[chId] || "";
  window.neo.writeChapter(book.id, chId, html).then(() => {
    if (chapterHTML[chId] === html) dirtyChapters.delete(chId);
    lastSavedAt = new Date();
  }).catch((err) => window.neo.logError(`chapter save: ${err && err.stack ? err.stack : err}`));
}

function scheduleMetaSave() {
  metaSavePending = true;
  clearTimeout(saveTimers.meta);
  saveTimers.meta = setTimeout(() => saveMeta(false), 800);
  scheduleCheckpoint("writing");
}
async function saveMeta(force = true) {
  if (book && (force || metaSavePending)) {
    book.modified = new Date().toISOString();
    await window.neo.writeBookMeta(book.id, book);
    metaSavePending = false;
    lastSavedAt = new Date();
  }
}

function flushAllSaves() {
  if (!book) return;
  const position = {
    chapterId: currentChapterId,
    scroll: $("#paper-scroll").scrollTop,
  };
  if (!book.lastPosition || book.lastPosition.chapterId !== position.chapterId || book.lastPosition.scroll !== position.scroll) {
    book.lastPosition = position;
    metaSavePending = true;
  }
  for (const chId of dirtyChapters) saveChapterNow(chId);
  flushAux();
  saveMeta(false);
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
