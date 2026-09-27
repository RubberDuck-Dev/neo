"use strict";

// The only adapter between bundled plugins and the legacy editor globals.
// Plugins receive operations and snapshots; editor/save state stays here.
function configurePlugins() {
  NeoPlugins.configure({
    capabilities: typeof window.neo.capabilities === "object" ? window.neo.capabilities : { spellcheck: true, git: true },
    enabled(p) {
      if (p.scope === "library") return library.plugins?.[p.id] ?? p.defaultEnabled ?? false;
      return (currentAuthor().plugins || []).includes(p.id);
    },
    async setEnabled(p, value) {
      if (p.scope === "library") {
        library.plugins ||= {};
        library.plugins[p.id] = value;
      } else {
        const author = currentAuthor();
        author.plugins = (author.plugins || []).filter((id) => id !== p.id);
        if (value) author.plugins.push(p.id);
      }
      if (!value && p.disableSettings) {
        const settings = Object.fromEntries((p.libraryFields || []).map((key) => [key, structuredClone(library[key])]));
        const patch = p.disableSettings(settings);
        for (const key of p.libraryFields || []) if (key in patch) library[key] = patch[key];
      }
      await window.neo.writeLibrary(library);
    },
    contextKey(p) { return `${p.scope === "author" ? currentAuthor().id : "library"}:${p.bookScoped ? book?.id || "" : ""}`; },
    report: (error) => reportError(`plugin: ${error.stack || error}`),
    refreshViews() {
      if (book) { updateCounters(); if (currentTab === "outline") renderOutline(); }
    },
    context(p) {
      const author = currentAuthor();
      const bookId = book?.id;
      let closed = false;
      let writes = Promise.resolve();
      let writeError = null;
      const cleanup = new Set();
      const ownedNodes = new Set();
      const track = (work) => {
        if (closed) return Promise.reject(new Error("Plugin context closed"));
        const next = writes.then(work);
        writes = next.then(() => { writeError = null; }, (err) => {
          writeError = err;
          window.neo.logError(`plugin ${p.id}: ${err.stack || err}`);
        });
        return next;
      };
      const context = {
        $, escHtml, toast,
        get authorName() { return author.name || "Anonymous"; },
        settings: Object.fromEntries((p.settings || []).map((key) => [key, structuredClone(author[key])])),
        saveSettings(settings) {
          for (const key of p.settings || []) author[key] = structuredClone(settings[key]);
          return track(() => window.neo.writeLibrary(structuredClone(library)));
        },
        get pageTheme() { return library.pageTheme; },
        get hasBook() { return !!book && (!p.bookScoped || book.id === bookId); },
        bookSnapshot: () => book ? structuredClone(book) : null,
        updateBook(patch) {
          if (!book || book.id !== bookId) return;
          for (const key of p.bookFields || []) if (key in patch) book[key] = structuredClone(patch[key]);
          scheduleMetaSave();
        },
        readData: (name, fallback) => window.neo.readJSON(bookId, name, fallback),
        writeData(name, data) {
          const snapshot = structuredClone(data);
          return track(() => window.neo.writeJSON(bookId, name, snapshot));
        },
        chapterWords, chapterText, countWords, editorElFor,
        wordCount: () => book ? bookWordCount() : 0,
        refreshCounters: () => { if (book) updateCounters(); },
        refreshOutline: () => { if (book && currentTab === "outline") renderOutline(); },
        openChapter(id) { switchTab("manuscript"); focusChapter(id); },
        get currentTab() { return currentTab; },
        get currentChapterId() { return currentChapterId; },
        addTab(id, label) {
          const tab = document.createElement("div");
          tab.className = "tab plugin-tab";
          tab.dataset.tab = id;
          tab.textContent = label;
          $("#tabs").appendChild(tab);
          const panel = document.createElement("div");
          panel.id = `${id}-list`;
          panel.hidden = true;
          panel.dataset.pluginPanel = id;
          $("#aux-paper").appendChild(panel);
          cleanup.add(() => {
            if (currentTab === id) switchTab("manuscript");
            tab.remove(); panel.remove();
          });
          return panel;
        },
        listen(target, event, handler, options) {
          target.addEventListener(event, handler, options);
          const off = () => { target.removeEventListener(event, handler, options); cleanup.delete(off); };
          cleanup.add(off);
          return off;
        },
        own(node) {
          for (const old of ownedNodes) if (!old.isConnected) ownedNodes.delete(old);
          ownedNodes.add(node); return node;
        },
        openLibrary: openPlugins,
        settingsDialog,
        ipcErrorText, timeAgo, optionModal,
        async flushSaves() { flushAllSaves(); await NeoPlugins.flush(); },
        git: {
          status: () => window.neo.gitStatus(),
          connect: (url) => window.neo.connectGitRemote(url),
          push: () => window.neo.pushGit(),
          restore: (url) => window.neo.restoreFromGit(url),
          replaceStarter: () => window.neo.replaceGitStarter()
        },
        get librarySettings() {
          return Object.fromEntries((p.libraryFields || []).map((key) => [key, structuredClone(library[key])]));
        },
        saveLibrarySettings(patch) {
          const changes = Object.fromEntries((p.libraryFields || []).filter(key => key in patch).map(key => [key, structuredClone(patch[key])]));
          return track(async () => {
            await window.neo.writeLibrary(structuredClone({ ...library, ...changes }));
            Object.assign(library, changes);
          });
        },
        spell: {
          check: (words) => window.neo.spellCheckWords(words),
          suggest: (word) => window.neo.spellSuggest(word),
          learn: (word) => window.neo.spellLearn(word),
          language: (code) => window.neo.setSpellLanguage(code),
          stop: () => window.neo.stopSpellcheck?.()
        },
        async flush() { await writes; if (writeError) throw writeError; },
        async close() {
          closed = true;
          for (const fn of [...cleanup].reverse()) fn();
          for (const node of ownedNodes) node.remove();
          cleanup.clear(); ownedNodes.clear();
          await writes;
        }
      };
      return context;
    }
  });
}

async function migratePluginPreferences() {
  library.plugins ||= {};
  let changed = false;
  if (!("github" in library.plugins)) {
    library.plugins.github = !!library.history?.git?.enabled || (library.authors || []).some((a) => a.plugins?.includes("github"));
    changed = true;
  }
  for (const author of library.authors || []) {
    if (author.plugins?.includes("github")) {
      author.plugins = author.plugins.filter((id) => id !== "github");
      changed = true;
    }
  }
  if (changed) await window.neo.writeLibrary(library);
}
