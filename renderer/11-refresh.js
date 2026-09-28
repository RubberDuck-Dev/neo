"use strict";

// Shared libraries can change on disk while NEO is open. Keep a separate
// confirmed-disk baseline so a remote edit never silently replaces local prose.
let refreshingFromDisk = false;
async function refreshFromDisk() {
  if (refreshingFromDisk) return;
  refreshingFromDisk = true;
  try {
    if (!book) {
      if (library && !$('#bookshelf-view').hidden) {
        const remote = await window.neo.readLibrary();
        if (remote?.firstRunDone && JSON.stringify(remote) !== JSON.stringify(library)) {
          library = remote;
          const shelf = $('#bookshelf-view'), scroll = shelf.scrollTop;
          await NeoPlugins.reconcile();
          await renderShelves(); shelf.scrollTop = scroll; applyFonts();
        }
      }
      return;
    }
    const bookId = book.id;
    if (window.neo.refreshBook) await window.neo.refreshBook(bookId);
    const remoteMeta = await window.neo.readBookMeta(bookId);
    if (book?.id !== bookId || !remoteMeta) return;
    const localDirty = auxDirty || metaSig(book) !== savedMetaSig ||
      book.chapterOrder.some(id => dirtyChapters.has(id) || chapterHTML[id] !== savedHTML[id]);
    if (metaSig(remoteMeta) !== savedMetaSig) {
      if (localDirty) return;
      const position = {chapterId:currentChapterId, scroll:$('#paper-scroll').scrollTop}, tab = currentTab;
      await openBook(bookId);
      if (tab !== 'manuscript') switchTab(tab);
      requestAnimationFrame(() => {
        if (position.chapterId && book?.chapterOrder.includes(position.chapterId)) currentChapterId = position.chapterId;
        $('#paper-scroll').scrollTop = position.scroll;
        highlightNav();
      });
      toast('Updated from your other device');
      return;
    }
    let adopted = 0, conflicts = 0;
    for (const chId of [...book.chapterOrder]) {
      const disk = await window.neo.readChapter(bookId, chId);
      if (book?.id !== bookId) return;
      if (typeof disk !== 'string' || disk === savedHTML[chId] || (disk === '' && savedHTML[chId])) continue;
      if (chapterHTML[chId] === savedHTML[chId] && !dirtyChapters.has(chId)) {
        chapterHTML[chId] = disk; savedHTML[chId] = disk; wordCache[chId] = null; adopted++;
      } else {
        const twinId = 'ch-' + crypto.randomUUID();
        const index = book.chapterOrder.indexOf(chId);
        book.chapterOrder.splice(index + 1, 0, twinId);
        book.chapterTitles ||= {};
        const time = new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
        book.chapterTitles[twinId] = `${book.chapterTitles[chId] || 'Chapter ' + (index + 1)} from other device, ${time}`;
        chapterHTML[twinId] = disk;
        await persistChapter(twinId, disk); // preserve remote copy before local overwrite
        await persistChapter(chId, chapterHTML[chId]);
        scheduleMetaSave(); conflicts++;
      }
    }
    if (adopted || conflicts) {
      const caret = captureCaret(), scroll = $('#paper-scroll').scrollTop;
      renderChapters(); $('#paper-scroll').scrollTop = scroll;
      if (caret) restoreCaret(caret);
      updateCounters(); scheduleNavRefresh();
      if (currentTab === 'outline') renderOutline();
      toast(conflicts ? 'Both devices changed this chapter. The other version is saved after it.' : 'Updated from your other device', conflicts ? 8000 : 3000);
    }
  } catch (err) { window.neo.logError(`shared library refresh: ${err?.stack || err}`); }
  finally { refreshingFromDisk = false; }
}
window.addEventListener('focus', () => setTimeout(refreshFromDisk, 300));
setInterval(() => { if (document.visibilityState === 'visible') refreshFromDisk(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') setTimeout(refreshFromDisk, 300);
  else if (book) flushAllSaves();
});
