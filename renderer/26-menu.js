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
  if (msg.type === "export") doExport(msg.format);
  if (msg.type === "emailDraft") doEmailDraft();
  if (msg.type === "emailSettings") emailSettings();
  if (msg.type === "find") openSearch();
  NeoPlugins.notify("command", msg.type, msg.value);
  if (msg.type === "revisionPass") toggleRevisionPass();
  if (msg.type === "readAloud") toggleReadAloud();
  if (msg.type === "publishingDetails") openPublishingDetails({ tab: msg.tab || "manuscript" });
  if (msg.type === "typewriter") toggleTypewriter();
  if (msg.type === "focusMode") toggleFocusMode();
  if (msg.type === "import") importBooks();
  if (msg.type === "stats") openStats();
  if (msg.type === "syncSettings") openSyncSettings();
  if (msg.type === "gitAutoPushError") {
    const { text, starter } = ipcErrorText(msg.message, "open Sync Settings to retry");
    toast(starter ? "GitHub backup paused: the repository has starter files. Open Sync Settings to replace them." : `GitHub backup failed: ${text}`, 7000);
  }
  if (msg.type === "plugins") openPlugins();
  if (msg.type === "coverArt") openCoverArt();
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
      library.fonts = library.fonts || {};
      library.fonts.body = name;
      await window.neo.writeLibrary(library);
    }
    applyFonts(); // also undoes a hover preview after Cancel
  }
  if (msg.type === "bodyFont") {
    library.fonts = library.fonts || {};
    library.fonts.body = msg.value;
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
