"use strict";

/* ================================================================== */
/*  SPELLCHECK PASS + TYPEWRITER SCROLLING                             */
/* ================================================================== */

/* NEO's own spellcheck pass: a bundled dictionary (via the main process),
   squiggles painted with the CSS Highlight API — the same machinery as
   search — and a right-click menu for suggestions. Chapters scan lazily
   as the caret reaches them. */
let spellOn = false;
let spellScanned = new Set();
let spellRanges = new Map(); // key → [Range]
const spellCache = new Map(); // word → correct?

const spellNorm = (w) => w.replace(/’/g, "'").replace(/^'+|'+$/g, "");

function spellElFor(key) {
  return key.startsWith("aux-")
    ? $("#aux-editor")
    : document.querySelector(`.chapter[data-id="${key}"] .chapter-body`);
}

async function spellScanEl(el, key) {
  if (!el || !spellOn) return;
  spellScanned.add(key);
  const occurrences = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  // letters of any alphabet, with their accents, so French and German
  // words reach the dictionary whole
  const re = /[\p{L}\p{M}'’]+/gu;
  let n;
  while ((n = walker.nextNode())) {
    const p = n.parentElement;
    if (p && p.closest(".scene-break, .ghost, .ph-mark")) continue;
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
    const res = await window.neo.spellCheckWords(unknown);
    for (const w of unknown) spellCache.set(w, res[w] !== false);
  }
  if (!spellOn) return; // toggled off while we were checking
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
  if (currentTab === "manuscript") {
    const body = currentChapterId && spellElFor(currentChapterId);
    if (body) scanSpellingIn(body, currentChapterId);
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
  spellOn = !spellOn;
  if (spellOn) {
    spellScanned = new Set();
    spellRanges = new Map();
    scanSpellingHere();
  } else {
    CSS.highlights.delete("neo-spell");
    spellRanges = new Map();
    document.querySelector(".spell-menu")?.remove();
  }
  toast(spellOn ? "Spellcheck on" : "Spellcheck off");
}

// Edit → Spellcheck Language: swap the dictionary, remember the choice with
// the library, and re-check whatever is on screen
const SPELL_LANGUAGE_NAMES = {
  'en-US': 'US English', 'en-GB': 'UK English', 'en-CA': 'Canadian English',
  'en-AU': 'Australian English', fr: 'French', es: 'Spanish', de: 'German'
};
async function changeSpellLanguage(code) {
  const ok = await window.neo.setSpellLanguage(code);
  if (!ok) { toast('That dictionary would not load'); return; }
  library.spellLanguage = code;
  await window.neo.writeLibrary(library);
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
document.addEventListener("contextmenu", async (e) => {
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
  const sugg = await window.neo.spellSuggest(word);
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
      library.customWords = library.customWords || [];
      if (!library.customWords.includes(word)) library.customWords.push(word);
      await window.neo.writeLibrary(library);
      await window.neo.spellLearn(word);
      spellCache.set(word, true);
      for (const k of [...spellScanned]) spellScanEl(spellElFor(k), k);
    },
  });
});

function showSpellMenu(x, y, word, suggestions, actions) {
  document.querySelector(".spell-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "spell-menu";
  if (suggestions.length) {
    for (const s of suggestions) {
      const btn = document.createElement("button");
      btn.textContent = s;
      btn.onclick = () => {
        menu.remove();
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
    menu.remove();
    actions.learn();
  };
  menu.appendChild(learn);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 10) + "px";
  menu.style.top = Math.min(y + 4, window.innerHeight - r.height - 10) + "px";
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener("mousedown", close, true);
  };
  document.addEventListener("mousedown", close, true);
}
