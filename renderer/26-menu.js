"use strict";

/* ================================================================== */
/*  MENU — messages from the main process                             */
/* ================================================================== */

window.neo.onMenu(async (msg) => {
  if (msg.type === "flush") {
    flushAllSaves();
    await finishPendingCheckpoint("quit");
    await NeoPlugins.flush();
    window.neo.flushComplete();
  }
  if (msg.type === "help") showHelp();
  if (msg.type === "about") showAbout();
  if (msg.type === "checkUpdate") checkForUpdate();
  if (msg.type === 'update') updateMessage(msg);
  if (msg.type === 'uiLanguage') {
    flushAllSaves();
    try { if (book) sessionStorage.setItem('neo-reopen', book.id); } catch {}
    await waitForBookWrites();
    await window.neo.reloadForLanguage();
  }
  if (msg.type === "export") doExport(msg.format);
  if (msg.type === "exportCustomChapterTitles") {
    library.exportCustomChapterTitles = !!msg.checked;
    await window.neo.writeLibrary(library);
  }
  if (msg.type === "emailDraft") doEmailDraft();
  if (msg.type === "emailSettings") emailSettings();
  if (msg.type === "find") openSearch();
  NeoPlugins.notify("command", msg.type, msg.value);
  if (msg.type === "revisionPass") toggleRevisionPass();
  if (msg.type === "readAloud") toggleReadAloud();
  if (msg.type === "publishingDetails") openPublishingDetails({ tab: msg.tab || "manuscript" });
  if (msg.type === "typewriter") toggleTypewriter();
  if (msg.type === "focusMode" || msg.type === "focusCycle") cycleFocus();
  if (msg.type === "focus") setFocus(msg.value);
  if (msg.type === "reshelve") reshelveBook();
  if (msg.type === "import") importBooks();
  if (msg.type === "preferences") openPreferences();
  if (msg.type === "readAloudSettings") openReadAloudSettings();
  if (msg.type === "stats") openStats();
  if (msg.type === "syncSettings") openSyncSettings();
  if (msg.type === "gitAutoPushError") {
    const { text, starter } = ipcErrorText(msg.message, "open GitHub backup in Plugin Library to retry");
    toast(starter ? "GitHub backup paused: the repository has starter files. Open GitHub backup in Plugin Library to replace them." : `GitHub backup failed: ${text}`, 7000);
  }
  if (msg.type === "plugins") openPlugins();
  if (msg.type === "align") {
    applyAlign(msg.value);
  }
  if (msg.type === 'poetry') togglePoetry();
  if (msg.type === 'uiBright') {
    library.uiBright = !library.uiBright;
    await window.neo.writeLibrary(library);
    applyFonts();
  }
  if (msg.type === "pageTheme") {
    library.pageTheme = msg.value;
    await window.neo.writeLibrary(library);
    applyFonts();
    await NeoPlugins.reconcile();
  }
  if (msg.type === "fontSize") {
    const cur = library.editorFontSize || 17;
    library.editorFontSize =
      msg.value === 0 ? 17 : Math.min(22, Math.max(14, cur + msg.value));
    if (msg.value === 0) library.pageZoom = 1; // ⌘0 resets pinch zoom too
    await window.neo.writeLibrary(library);
    applyFonts();
  }
  if (msg.type === "bodyFontPick") {
    const name = await pickLocalFont();
    if (name) {
      currentAuthor().bodyFont = name;
      await window.neo.writeLibrary(library);
    }
    applyFonts(); // also undoes a hover preview after Cancel
  }
  if (msg.type === "bodyFont") {
    currentAuthor().bodyFont = msg.value;
    await window.neo.writeLibrary(library);
    applyFonts();
  }
  if (msg.type === "dropCap") {
    library.fonts = library.fonts || {};
    library.fonts.dropcap = msg.value;
    await window.neo.writeLibrary(library);
    applyFonts();
  }
});

// On layouts where the physical semicolon key produces another character,
// Electron's Cmd/Ctrl+; menu accelerator does not fire.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey &&
      event.code === 'Semicolon' && event.key !== ';') {
    event.preventDefault();
    NeoPlugins.notify('command', 'spellcheck');
  }
});
