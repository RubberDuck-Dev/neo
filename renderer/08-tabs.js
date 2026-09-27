"use strict";

/* ================================================================== */
/*  TABS — Manuscript / Notes / Outline / Darlings                     */
/* ================================================================== */

$$(".tab").forEach((tab) => {
  tab.addEventListener("dblclick", async () => {
    const kind = tab.dataset.tab;
    if (kind !== "notes" && kind !== "outline") return;
    const name = await askInput(
      "Rename tab",
      "New tab name",
      book.tabNames[kind],
    );
    if (!name) return;
    book.tabNames[kind] = name;
    tab.textContent = name;
    saveMeta();
    // Renamed tabs become the default for future books
    library.tabDefaults = library.tabDefaults || {};
    library.tabDefaults[kind] = name;
    window.neo.writeLibrary(library);
  });
});

// Plugin tabs are added after startup, so they use a small delegated route.
$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest('.tab[data-tab]');
  if (tab && !tab.hidden) switchTab(tab.dataset.tab);
});

// Darlings tab is a drop target for selected text
const darlingsTab = $(".tab.darlings");
// The selection usually collapses by the time a drag lands on the Darlings
// tab, so the range is remembered at dragstart and the cut is made by NEO
// itself (dropEffect 'copy' keeps Chromium from moving the text on its own).
let draggedRange = null;
document.addEventListener("dragstart", (e) => {
  // any text drag inside the manuscript lights up the bottom bar
  if (
    currentTab === "manuscript" &&
    e.target.closest &&
    e.target.closest(".chapter-body")
  ) {
    $("#bottombar").classList.add("attn");
    const sel = window.getSelection();
    draggedRange =
      sel.rangeCount && !sel.isCollapsed
        ? sel.getRangeAt(0).cloneRange()
        : null;
  }
});
document.addEventListener("dragend", () => {
  $("#bottombar").classList.remove("attn");
  draggedRange = null;
});

darlingsTab.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  darlingsTab.classList.add("drag-over");
});
darlingsTab.addEventListener("dragleave", () =>
  darlingsTab.classList.remove("drag-over"),
);
darlingsTab.addEventListener("drop", async (e) => {
  e.preventDefault();
  darlingsTab.classList.remove("drag-over");
  const html = e.dataTransfer.getData("text/html");
  const text = e.dataTransfer.getData("text/plain");
  await moveSelectionToDarlings(html, text);
});

// ---- text-position helpers: darlings remember home by their surrounding
// text, so nothing foreign is left inside the manuscript ----

function bodyPlainText(body) {
  let t = "";
  const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) t += n.textContent;
  return t;
}

function textPosToRange(body, pos) {
  const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let n,
    acc = 0;
  while ((n = w.nextNode())) {
    const len = n.textContent.length;
    if (acc + len >= pos) {
      const r = document.createRange();
      r.setStart(n, pos - acc);
      r.collapse(true);
      return r;
    }
    acc += len;
  }
  return null;
}

// Where in the chapter does this darling belong?
function findDarlingPosition(body, d) {
  if (d.anchorPrefix == null && d.anchorSuffix == null) return -1;
  const text = bodyPlainText(body);
  const pre = d.anchorPrefix || "";
  const suf = d.anchorSuffix || "";
  let idx = pre + suf ? text.indexOf(pre + suf) : -1;
  if (idx !== -1) return idx + pre.length;
  if (pre) {
    idx = text.indexOf(pre);
    if (idx !== -1) return idx + pre.length;
  }
  if (suf) {
    idx = text.indexOf(suf);
    if (idx !== -1) return idx;
  }
  return -1;
}

// The one move shared by drag-to-tab and ⌘⇧D: the cut point is remembered by its surroundings —
// no markers in the WIP itself.
async function moveSelectionToDarlings(html, text) {
  if (!text || !text.trim() || !book) return;
  const sel = window.getSelection();
  // the live selection if it survived the drag, else the one saved at dragstart
  const live = sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
  const range = live || draggedRange;
  draggedRange = null;
  const srcChapter = range
    ? range.startContainer.parentElement?.closest?.(".chapter")
    : null;
  const chId = srcChapter ? srcChapter.dataset.id : currentChapterId;
  const chIdx = book.chapterOrder.indexOf(chId);
  const did = "d-" + Date.now().toString(36);

  snapshotStructure("darling");

  let anchorPrefix = null;
  let anchorSuffix = null;
  if (range) {
    const startNode =
      range.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement
        : range.startContainer;
    const startBlock =
      startNode && startNode.closest ? startNode.closest("p") : null;
    range.deleteContents();
    // a whole paragraph dragged away leaves its empty shell behind: remove it
    // and park the caret at the end of the paragraph before (or start of after)
    if (
      startBlock &&
      !startBlock.textContent.trim() &&
      !startBlock.querySelector("span") &&
      startBlock.parentElement &&
      startBlock.parentElement.children.length > 1
    ) {
      const prev = startBlock.previousElementSibling;
      const next = startBlock.nextElementSibling;
      startBlock.remove();
      if (prev) {
        range.selectNodeContents(prev);
        range.collapse(false);
      } else if (next) {
        range.selectNodeContents(next);
        range.collapse(true);
      }
    }
    sel.removeAllRanges();
    sel.addRange(range);
    const r = range;
    const body = r.startContainer.parentElement?.closest?.(".chapter-body");
    if (body) {
      const pre = document.createRange();
      pre.selectNodeContents(body);
      pre.setEnd(r.startContainer, r.startOffset);
      anchorPrefix = pre.toString().slice(-60);
      const post = document.createRange();
      post.selectNodeContents(body);
      post.setStart(r.startContainer, r.startOffset);
      anchorSuffix = post.toString().slice(0, 60);
    }
  }
  if (chId) {
    const body = document.querySelector(
      `.chapter[data-id="${chId}"] .chapter-body`,
    );
    if (body) {
      chapterHTML[chId] = captureBody(body);
      wordCache[chId] = null;
      scheduleChapterSave(chId);
    }
  }

  // Chromium's drag html carries inline font/colour/background styles;
  // keep only the prose (paragraphs when the drag spanned more than one)
  let cleanHtml = null;
  if (html) {
    const cleaned = cleanPasteHtml(html);
    cleanHtml =
      /\n/.test(text.trim()) && !/<p[\s>]/i.test(cleaned)
        ? "<p>" + cleaned + "</p>"
        : cleaned;
  }
  darlings.unshift({
    id: did,
    html: cleanHtml,
    text: text,
    chapterId: chId || null,
    chapterLabel: chIdx >= 0 ? "Chapter " + (chIdx + 1) : "Manuscript",
    anchorPrefix,
    anchorSuffix,
    date: new Date().toISOString(),
  });
  await window.neo.writeJSON(book.id, "darlings", darlings);
  updateCounters();
  toast(`Saved to Darlings — kill without remorse (${KZ} to undo)`);
}

// Older versions of NEO planted invisible marker spans at darling cut points,
// which interfered with Chromium's delete handling. On open, convert each one
// into a remembered-context position and remove it:
async function migrateDarlingAnchors() {
  const spans = [...document.querySelectorAll(".darling-anchor")];
  if (!spans.length) return;
  let changed = false;
  for (const span of spans) {
    const body = span.closest(".chapter-body");
    const d = darlings.find((x) => x.id === span.dataset.did);
    if (body && d && d.anchorPrefix == null) {
      const pre = document.createRange();
      pre.selectNodeContents(body);
      pre.setEndBefore(span);
      d.anchorPrefix = pre.toString().slice(-60);
      const post = document.createRange();
      post.selectNodeContents(body);
      post.setStartAfter(span);
      d.anchorSuffix = post.toString().slice(0, 60);
      changed = true;
    }
    const chapter = span.closest(".chapter");
    span.remove();
    if (body && chapter) {
      chapterHTML[chapter.dataset.id] = captureBody(body);
      wordCache[chapter.dataset.id] = null;
      scheduleChapterSave(chapter.dataset.id);
    }
  }
  if (changed) await window.neo.writeJSON(book.id, "darlings", darlings);
}

// keyboard route: select a passage, ⌘⇧D to move to Darlings
function darlingFromKeyboard() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) {
    toast(`Select the passage first, then ${KDA} sends it to Darlings`);
    return;
  }
  let el = sel.anchorNode;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  if (!el || !el.closest || !el.closest(".chapter-body")) return;
  const holder = document.createElement("div");
  holder.appendChild(sel.getRangeAt(0).cloneContents());
  moveSelectionToDarlings(holder.innerHTML, sel.toString());
}

// Every tab shares one scroller, so leaving a tab used to lose its place.
// Each tab now remembers where it was — the manuscript keeps its caret as
// well — for as long as the book is open.
let tabPlaces = {};

function switchTab(name) {
  const scroller = $("#paper-scroll");
  if (book && currentTab && currentTab !== name) {
    tabPlaces[currentTab] =
      currentTab === "manuscript"
        ? { caret: captureCaret(), scroll: scroller.scrollTop }
        : { scroll: scroller.scrollTop };
  }
  currentTab = name;
  $$(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name),
  );
  setTimeout(() => NeoPlugins.notify("selection"), 0);
  if (revisionOn && name !== "manuscript") toggleRevisionPass(false);
  if (name !== "manuscript") stopReadAloud(true);
  const paper = $("#paper");
  const aux = $("#aux-paper");
  const auxEditor = $("#aux-editor");
  const dList = $("#darlings-list");
  const oList = $("#outline-list");
  const back = tabPlaces[name];
  const returnTo = () => {
    if (back && typeof back.scroll === "number")
      scroller.scrollTop = back.scroll;
  };

  // stash whatever aux content was open
  flushAux();

  if (name === "manuscript") {
    paper.hidden = false;
    aux.hidden = true;
    if (back && back.caret)
      restoreCaret(back.caret); // brings the scroll along
    else returnTo();
    return;
  }
  paper.hidden = true;
  aux.hidden = false;
  auxEditor.hidden = true;
  dList.hidden = true;
  document.querySelectorAll("[data-plugin-panel]").forEach((panel) => panel.hidden = true);
  oList.hidden = true;

  if (name === "darlings") {
    $("#aux-title").textContent = "Darlings";
    dList.hidden = false;
    renderDarlings();
    returnTo();
  } else if (NeoPlugins.render("tab", name)) {
    returnTo();
  } else if (name === "outline") {
    $("#aux-title").textContent = book.tabNames.outline;
    oList.hidden = false;
    if (book.chapterOrder.length === 0) createChapterAt(0);
    renderOutline();
    returnTo();
  } else {
    $("#aux-title").textContent = book.tabNames[name] || name;
    auxEditor.hidden = false;
    auxEditor.dataset.kind = name;
    window.neo.readAux(book.id, name).then((html) => {
      auxEditor.innerHTML = html || "";
      auxEditor.focus({ preventScroll: true });
      returnTo();
    });
  }
}
