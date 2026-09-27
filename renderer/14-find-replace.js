"use strict";

/* ================================================================== */
/*  FIND & REPLACE                                                     */
/* ================================================================== */

let searchState = { matches: [], idx: -1, query: "" };

function openSearch() {
  if ($("#editor-view").hidden || !book) {
    openLibrarySearch(); // on the shelf, Find searches every book
    return;
  }
  switchTab("manuscript");
  const sel = window.getSelection();
  const preset =
    sel && !sel.isCollapsed ? sel.toString().slice(0, 80).trim() : "";
  $("#searchbar").hidden = false;
  const inp = $("#search-input");
  if (preset) inp.value = preset;
  inp.focus();
  inp.select();
  runSearch();
}

function closeSearch() {
  $("#searchbar").hidden = true;
  searchState = { matches: [], idx: -1, query: "" };
  if (window.CSS && CSS.highlights) {
    CSS.highlights.delete("neo-search");
    CSS.highlights.delete("neo-search-current");
  }
}

function paintHighlights() {
  if (!window.Highlight || !window.CSS || !CSS.highlights) return;
  const all = new Highlight();
  const cur = new Highlight();
  searchState.matches.forEach((m, i) => {
    (i === searchState.idx ? cur : all).add(m.range);
  });
  CSS.highlights.set("neo-search", all);
  CSS.highlights.set("neo-search-current", cur);
}

// Scan the WHOLE book, first chapter to last, every time.
// Matches are highlighted, not selected.
function runSearch() {
  const q = $("#search-input").value;
  searchState = { matches: [], idx: -1, query: q };
  if (!q) {
    $("#search-count").textContent = "";
    paintHighlights();
    return;
  }
  const ql = q.toLowerCase();
  for (const chId of book.chapterOrder) {
    const body = document.querySelector(
      `.chapter[data-id="${chId}"] .chapter-body`,
    );
    if (!body) continue;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const tl = node.textContent.toLowerCase();
      let pos = 0;
      while ((pos = tl.indexOf(ql, pos)) !== -1) {
        const range = document.createRange();
        range.setStart(node, pos);
        range.setEnd(node, pos + q.length);
        searchState.matches.push({ range });
        pos += q.length;
      }
    }
  }
  const n = searchState.matches.length;
  $("#search-count").textContent = n ? `${n} found` : "none";
  paintHighlights();
}

// only runs when the user asks (Enter / arrows)
function gotoMatch(i) {
  const m = searchState.matches;
  if (!m.length) return;
  searchState.idx = ((i % m.length) + m.length) % m.length;
  paintHighlights();
  try {
    const rect = m[searchState.idx].range.getBoundingClientRect();
    $("#paper-scroll").scrollTop += rect.top - window.innerHeight * 0.45;
  } catch {
    /* range collapsed by an edit; next search rebuilds */
  }
  $("#search-count").textContent = `${searchState.idx + 1} of ${m.length}`;
}

function freshSearchIfStale() {
  if (searchState.query !== $("#search-input").value) runSearch();
}

function replaceCurrent() {
  freshSearchIfStale();
  if (!searchState.matches.length) {
    toast("No matches");
    return;
  }
  if (searchState.idx < 0) searchState.idx = 0; // start from the very first match
  const m = searchState.matches[searchState.idx];
  const rep = $("#replace-input").value;
  let chapter = null;
  try {
    chapter = m.range.startContainer.parentElement.closest(".chapter");
    m.range.deleteContents();
    if (rep) m.range.insertNode(document.createTextNode(rep));
  } catch {
    runSearch();
    return;
  }
  if (chapter)
    syncChapter(chapter.querySelector(".chapter-body"), chapter.dataset.id);
  const oldIdx = searchState.idx;
  runSearch();
  if (searchState.matches.length)
    gotoMatch(Math.min(oldIdx, searchState.matches.length - 1));
}

// Every chapter, front to back
function replaceAllMatches() {
  const q = $("#search-input").value;
  if (!q) return;
  snapshotStructure("replace all");
  const rep = $("#replace-input").value;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let n = 0;
  for (const chId of book.chapterOrder) {
    const body = document.querySelector(
      `.chapter[data-id="${chId}"] .chapter-body`,
    );
    if (!body) continue;
    const nodes = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    let touched = false;
    for (const nd of nodes) {
      if (nd.textContent.toLowerCase().includes(q.toLowerCase())) {
        nd.textContent = nd.textContent.replace(re, () => {
          n++;
          return rep;
        });
        touched = true;
      }
    }
    if (touched) syncChapter(body, chId);
  }
  if (n === 0) undoStack.pop(); // nothing changed, nothing to undo
  toast(
    n ? `${n} replaced across the whole book — ${KZ} to undo` : "0 replaced",
  );
  runSearch();
}

$("#search-input").addEventListener("input", () => {
  clearTimeout(saveTimers.search);
  saveTimers.search = setTimeout(runSearch, 250);
});
$("#search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    freshSearchIfStale();
    gotoMatch(searchState.idx + (e.shiftKey ? -1 : 1));
  }
  if (e.key === "Escape") {
    e.stopPropagation();
    closeSearch();
  }
  if (e.key === "Tab" && !e.shiftKey) {
    const m = searchState.matches[Math.max(0, searchState.idx)];
    if (m) {
      e.preventDefault();
      const sel = window.getSelection();
      const r = m.range.cloneRange();
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
      const body =
        m.range.startContainer.parentElement.closest(".chapter-body");
      if (body) body.focus();
    }
  }
});
$("#replace-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    replaceCurrent();
  }
  if (e.key === "Escape") {
    e.stopPropagation();
    closeSearch();
  }
});
$("#search-next").onclick = () => {
  freshSearchIfStale();
  gotoMatch(searchState.idx + 1);
};
$("#search-prev").onclick = () => {
  freshSearchIfStale();
  gotoMatch(searchState.idx - 1);
};
$("#replace-one").onclick = replaceCurrent;
$("#replace-all").onclick = replaceAllMatches;
$("#search-close").onclick = closeSearch;
