"use strict";

/* ================================================================== */
/*  STRUCTURAL UNDO                                                    */
/*  Typing has the native ⌘Z. This covers the big moves — chapter      */
/*  deletes, replace-all, darlings — with snapshots of the whole       */
/*  structure.                                                         */
/* ================================================================== */

let undoStack = [];

// remember where the caret is — paragraph number plus offset within that
// paragraph, so even a caret in an EMPTY paragraph has an exact address
function captureCaret() {
  try {
    const sel = window.getSelection();
    if (!sel.rangeCount || currentTab !== "manuscript") return null;
    const r = sel.getRangeAt(0);
    let el = r.startContainer;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    const bodyEl = el && el.closest ? el.closest(".chapter-body") : null;
    if (!bodyEl) return null;
    const blk = el.closest("p");
    const ps = [...bodyEl.querySelectorAll("p")];
    let off = 0;
    if (blk) {
      const pre = document.createRange();
      pre.selectNodeContents(blk);
      pre.setEnd(r.startContainer, r.startOffset);
      off = pre.toString().length;
    }
    return {
      chId: bodyEl.closest(".chapter").dataset.id,
      pIdx: blk ? ps.indexOf(blk) : 0, // container-level caret: treat as chapter start
      off,
      scroll: $("#paper-scroll").scrollTop,
    };
  } catch {
    return null;
  }
}

function restoreCaret(caret) {
  if (!caret) return;
  const bodyEl = document.querySelector(
    `.chapter[data-id="${caret.chId}"] .chapter-body`,
  );
  if (!bodyEl) return;
  bodyEl.focus({ preventScroll: true });
  const sel = window.getSelection();
  const finish = () => {
    currentChapterId = caret.chId;
    if (typeof caret.scroll === "number")
      $("#paper-scroll").scrollTop = caret.scroll;
  };
  const ps = [...bodyEl.querySelectorAll("p")];
  const blk = ps[caret.pIdx] || ps[ps.length - 1];
  if (!blk) {
    finish();
    return;
  }
  const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
  let pos = 0,
    n;
  while ((n = w.nextNode())) {
    if (caret.off <= pos + n.data.length) {
      const r = document.createRange();
      r.setStart(n, caret.off - pos);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      finish();
      return;
    }
    pos += n.data.length;
  }
  // empty paragraph, or offset past its end
  const r = document.createRange();
  r.selectNodeContents(blk);
  r.collapse(caret.off === 0);
  sel.removeAllRanges();
  sel.addRange(r);
  finish();
}

// The engine's undo history must never replay against a document NEO has
// rearranged by hand — clear it whenever such a rearrangement happens.
function resetNativeUndo() {
  const caret = captureCaret();
  if (!caret) return;
  const bodyEl = document.querySelector(
    `.chapter[data-id="${caret.chId}"] .chapter-body`,
  );
  if (!bodyEl) return;
  bodyEl.contentEditable = "false";
  bodyEl.contentEditable = "true";
  restoreCaret(caret);
}

// Destructive operations get a version right away; routine structure
// (section breaks, poetry lines, splits) rides the normal timer so Enter
// doesn't turn into a full copy and a GitHub push.
const IMMEDIATE_VERSION_LABELS = new Set(["chapter delete", "chapters merged", "replace all", "darling delete"]);

function snapshotStructure(label, opts) {
  if (!book) return;
  if (IMMEDIATE_VERSION_LABELS.has(label)) checkpointNow(label, book.id);
  else scheduleCheckpoint("writing");
  undoStack.push({
    label,
    legacyCardsImported: book.legacyCardsImported,
    rejoin: !!(opts && opts.rejoin),
    caret: captureCaret(),
    chapterOrder: [...book.chapterOrder],
    chapterHTML: { ...chapterHTML },
    chapterTitles: { ...(book.chapterTitles || {}) },
    chapterNotes: { ...(book.chapterNotes || {}) },
    sectionNotes: JSON.parse(JSON.stringify(book.sectionNotes || {})),
    darlings: JSON.parse(JSON.stringify(darlings)),
    stickies: JSON.parse(JSON.stringify(stickies)),
  });
  if (undoStack.length > 10) undoStack.shift();
}

async function structuralUndo() {
  const snap = undoStack.pop();
  if (!snap || !book) return;
  book.legacyCardsImported = snap.legacyCardsImported;
  book.chapterOrder = snap.chapterOrder;
  chapterHTML = snap.chapterHTML;
  book.chapterTitles = snap.chapterTitles;
  book.chapterNotes = snap.chapterNotes;
  book.sectionNotes = snap.sectionNotes;
  darlings = snap.darlings;
  stickies = snap.stickies;
  // resurrect any chapter files the action may have deleted
  for (const chId of book.chapterOrder) {
    await persistChapter(chId, chapterHTML[chId] || "<p><br></p>");
  }
  await window.neo.writeJSON(book.id, "darlings", darlings);
  await window.neo.writeJSON(book.id, "stickies", stickies);
  await saveMeta();
  currentChapterId = book.chapterOrder.includes(currentChapterId)
    ? currentChapterId
    : null;
  renderChapters();
  renderStickies();
  if (currentTab === "darlings") renderDarlings();
  if (currentTab === "outline") renderOutline();
  updateCounters();
  restoreCaret(snap.caret); // back to work, no announcement
  if (snap.rejoin) rejoinAtCaret();
  resetNativeUndo();
}

// after undoing a double-Enter break, close the split the gesture made:
// the caret's paragraph flows back into the one above it
function rejoinAtCaret() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  let el = sel.anchorNode;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  const blk = el && el.closest ? el.closest("p") : null;
  const body = blk && blk.closest(".chapter-body");
  if (!blk || !body) return;
  const prev = blk.previousElementSibling;
  if (!prev || prev.tagName !== 'P') return;
  if (prev.classList.contains('scene-break') || blk.classList.contains('scene-break')) return;
  if (prev.classList.contains('poetry') !== blk.classList.contains('poetry')) return;
  const chId = body.closest('.chapter').dataset.id;
  const at = prev.textContent.length;
  if (blk.textContent.trim() === "") {
    blk.remove();
  } else {
    for (const junk of blk.querySelectorAll("br")) junk.remove();
    for (const junk of prev.querySelectorAll("br")) junk.remove(); // an empty line's placeholder must not survive the merge
    while (blk.firstChild) prev.appendChild(blk.firstChild);
    blk.remove();
    try {
      prev.normalize();
    } catch {
      /* fine */
    }
  }
  // caret lands at the healed seam
  const w = document.createTreeWalker(prev, NodeFilter.SHOW_TEXT);
  let pos = 0,
    n,
    placed = false;
  while ((n = w.nextNode())) {
    if (at <= pos + n.data.length) {
      const r = document.createRange();
      r.setStart(n, at - pos);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      placed = true;
      break;
    }
    pos += n.data.length;
  }
  if (!placed) {
    const r = document.createRange();
    r.selectNodeContents(prev);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  syncChapter(body, chId);
}

document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== "z")
    return;
  if ($("#editor-view").hidden || !book || !undoStack.length) return;
  const ae = document.activeElement;
  // inside text, ⌘Z belongs to typing; outside it, it belongs to structure
  if (
    ae &&
    (ae.isContentEditable ||
      ae.tagName === "INPUT" ||
      ae.tagName === "TEXTAREA")
  )
    return;
  e.preventDefault();
  structuralUndo();
});
