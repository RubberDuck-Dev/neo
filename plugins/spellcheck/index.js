"use strict";
NeoPlugins.define("spellcheck", { name: "Spellcheck", icon: "Aa", kind: "Language", description: "Check spelling on demand using bundled offline dictionaries.", scope: "library", defaultEnabled: true, requires: ["spellcheck"], libraryFields: ["spellLanguage", "customWords"] }, (ctx) => {
const { $, toast } = ctx;
let spellOn = false;
let closeCurrentMenu = () => {};
let spellScanned = new Set();
let spellRanges = new Map(); // key → [Range]
let epoch = 0;
let languageRequest = 0;
const scans = new Map();
const saveTimers = {};
const spellCache = new Map(); // word → correct?

const spellNorm = (w) => w.replace(/’/g, "'").replace(/^'+|'+$/g, "");

const spellElFor = ctx.editorElFor;

async function spellScanEl(el, key) {
  if (!el || !spellOn) return;
  const generation = epoch;
  const scan = (scans.get(key) || 0) + 1;
  scans.set(key, scan);
  spellScanned.add(key);
  const occurrences = [];

  // letters of any alphabet, with their accents, so French and German
  // words reach the dictionary whole
  const re = /[\p{L}\p{M}'’]+/gu;
  for (const n of NeoText.proseNodes(el)) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(n.data))) {
      const word = spellNorm(m[0]);
      if (word.length < 2) continue;
      if (/^[\p{Lu}'’]+$/u.test(m[0])) continue; // acronyms and shouting are legal
      occurrences.push({ node: n, start: m.index, end: m.index + m[0].length, word });
    }
  }
  const unknown = [...new Set(occurrences.map((o) => o.word))].filter(
    (w) => !spellCache.has(w),
  );
  if (unknown.length) {
    const res = await ctx.spell.check(unknown);
    if (generation !== epoch || scan !== scans.get(key)) return;
    if (!res) { spellScanned.delete(key); return; }
    for (const w of unknown) spellCache.set(w, res[w] !== false);
  }
  if (!spellOn || generation !== epoch || scan !== scans.get(key)) return;
  const ranges = [];
  for (const o of occurrences) {
    if (spellCache.get(o.word) || !o.node.isConnected) continue;
    try {
      const r = new Range();
      r.setStart(o.node, o.start);
      r.setEnd(o.node, o.end);
      ranges.push(r);
    } catch {
      /* node changed underneath us */
    }
  }
  spellRanges.set(key, ranges);
  rebuildSpellHighlight();
}

function rebuildSpellHighlight() {
  if (!spellOn) return;
  const hl = new Highlight();
  for (const list of spellRanges.values()) for (const r of list) hl.add(r);
  CSS.highlights.set("neo-spell", hl);
}

function scanSpellingIn(el, key) {
  if (!el || spellScanned.has(key)) return;
  spellScanEl(el, key);
}

// scan wherever the writer currently is
function scanSpellingHere() {
  if (ctx.currentTab === "manuscript") {
    const body = ctx.currentChapterId && spellElFor(ctx.currentChapterId);
    if (body) scanSpellingIn(body, ctx.currentChapterId);
  } else {
    scanSpellingIn(
      $("#aux-editor"),
      "aux-" + ($("#aux-editor").dataset.kind || "notes"),
    );
  }
}

function scheduleSpellRescan(key, el) {
  clearTimeout(saveTimers["sp-" + key]);
  saveTimers["sp-" + key] = setTimeout(() => {
    if (spellOn) spellScanEl(el, key);
  }, 600);
}

function toggleSpellcheck() {
  epoch++;
  spellOn = !spellOn;
  if (spellOn) {
    spellScanned = new Set();
    spellRanges = new Map();
    scanSpellingHere();
  } else {
    CSS.highlights.delete("neo-spell");
    spellRanges = new Map();
    closeCurrentMenu();
  }
  toast(spellOn ? "Spellcheck on" : "Spellcheck off");
}

// Edit → Spellcheck Language: swap the dictionary, remember the choice with
// the library, and re-check whatever is on screen
const SPELL_LANGUAGE_NAMES = Object.fromEntries(Object.entries(NeoLanguage.dictionaries).map(([code, data]) => [code, data.label]));
async function changeSpellLanguage(code) {
  const request = ++languageRequest;
  epoch++;
  const ok = await ctx.spell.language(code);
  if (request !== languageRequest) return;
  if (!ok) { toast('That dictionary would not load'); return; }
  await ctx.saveLibrarySettings({ spellLanguage: code });
  spellCache.clear();
  if (spellOn) {
    spellScanned = new Set();
    spellRanges = new Map();
    CSS.highlights.delete('neo-spell');
    scanSpellingHere();
  }
  toast('Spellcheck: ' + (SPELL_LANGUAGE_NAMES[code] || code));
}

// right-click a flagged word for suggestions
ctx.listen(document, "contextmenu", async (e) => {
  if (!spellOn) return;
  const editor =
    e.target.closest && e.target.closest(".chapter-body, #aux-editor");
  if (!editor) return;
  const pos = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!pos || pos.startContainer.nodeType !== Node.TEXT_NODE) return;
  const node = pos.startContainer;
  const text = node.data;
  const isW = (c) => /[\p{L}\p{M}'’]/u.test(c);
  let a = pos.startOffset, b = pos.startOffset;
  while (a > 0 && isW(text[a - 1])) a--;
  while (b < text.length && isW(text[b])) b++;
  if (a === b) return;
  const word = spellNorm(text.slice(a, b));
  if (spellCache.get(word) !== false) return; // only flagged words get our menu
  e.preventDefault();
  const chEl = editor.closest ? editor.closest(".chapter") : null;
  const key =
    editor.id === "aux-editor"
      ? "aux-" + (editor.dataset.kind || "notes")
      : chEl
        ? chEl.dataset.id
        : null;
  const generation = epoch;
  const sugg = await ctx.spell.suggest(word);
  if (!spellOn || generation !== epoch || !node.isConnected) return;
  showSpellMenu(e.clientX, e.clientY, word, sugg, {
    replace: (s) => {
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(node, a);
      r.setEnd(node, b);
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand("insertText", false, s);
      if (key) spellScanEl(spellElFor(key), key);
    },
    learn: async () => {
      const library = ctx.librarySettings;
      library.customWords = library.customWords || [];
      if (!library.customWords.includes(word)) library.customWords.push(word);
      await ctx.saveLibrarySettings(library);
      await ctx.spell.learn(word);
      spellCache.set(word, true);
      for (const k of [...spellScanned]) spellScanEl(spellElFor(k), k);
    },
  });
});

function showSpellMenu(x, y, word, suggestions, actions) {
  closeCurrentMenu();
  const menu = document.createElement("div");
  menu.className = "spell-menu";
  let stopOutside = () => {};
  const removeMenu = () => { menu.remove(); stopOutside(); };
  closeCurrentMenu = removeMenu;
  if (suggestions.length) {
    for (const s of suggestions) {
      const btn = document.createElement("button");
      btn.textContent = s;
      btn.onclick = () => {
        removeMenu();
        actions.replace(s);
      };
      menu.appendChild(btn);
    }
  } else {
    const none = document.createElement("button");
    none.textContent = "No suggestions";
    none.disabled = true;
    menu.appendChild(none);
  }
  const sep = document.createElement("div");
  sep.className = "sm-sep";
  menu.appendChild(sep);
  const learn = document.createElement("button");
  learn.textContent = `Add “${word}” to dictionary`;
  learn.onclick = () => {
    removeMenu();
    actions.learn();
  };
  menu.appendChild(learn);
  document.body.appendChild(ctx.own(menu));
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 10) + "px";
  menu.style.top = Math.min(y + 4, window.innerHeight - r.height - 10) + "px";
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    removeMenu();

  };
  stopOutside = ctx.listen(document, "mousedown", close, true);
}

function reset() {
  epoch++; scans.clear();
  for (const timer of Object.values(saveTimers)) clearTimeout(timer);
  spellScanned.clear(); spellRanges.clear(); spellCache.clear();
  CSS.highlights.delete("neo-spell");
  closeCurrentMenu();
}
return {
  command(type, value) {
    if (type === "spellcheck") toggleSpellcheck();
    if (type === "spellLanguage") changeSpellLanguage(value);
  },
  changed(key, el) { if (spellOn) scheduleSpellRescan(key, el); },
  selection() { if (spellOn) scanSpellingHere(); },
  bookClosed() { reset(); spellOn = false; },
  dispose() { languageRequest++; reset(); spellOn = false; ctx.spell.stop(); }
};
});
