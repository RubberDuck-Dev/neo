"use strict";

/* ================================================================== */
/*  EDITOR — typing                                                    */
/* ================================================================== */

function wireChapterBody(body, chId) {
  body.addEventListener("focus", () => {
    currentChapterId = chId;
    updateCounters();
    highlightNav();
  });

  body.addEventListener("input", () => {
    breakRun = 0; // fresh typing: ⌘Z belongs to the engine again
    refreshChapterOpening(body);
    // The temporary pre-edit guard is no longer needed once Chromium has
    // applied the edit; show the cap again immediately.
    body.classList.remove("cap-off");
    chapterHTML[chId] = captureBody(body);
    wordCache[chId] = null;
    scheduleChapterSave(chId);
    scheduleCheckpoint("writing");
    if (spellOn) scheduleSpellRescan(chId, body);
    if (revisionOn) scheduleRevisionRescan(chId, body);
    updateCounters();
    scheduleNavRefresh();
  });
  // paste without formatting
  body.addEventListener("paste", (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (html) {
      document.execCommand("insertHTML", false, cleanPasteHtml(html));
      reconcileMarks();
    } else if (text) {
      const parts = text
        .replace(/\r/g, "")
        .split(/\n+/)
        .filter((p) => p.trim());
      parts.forEach((p, i) => {
        if (i > 0) document.execCommand("insertParagraph");
        document.execCommand("insertText", false, p.trim());
      });
    }
  });
  // While macOS composes input, shortcuts stand down completely.
  let composing = false;
  body.addEventListener("compositionstart", () => {
    composing = true;
  });
  body.addEventListener("compositionend", () => {
    composing = false;
  });
  body.addEventListener("keydown", (e) => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    // count consecutive Enters — the double/triple rhythm works mid-sentence
    if (e.key === "Enter" && !e.shiftKey) enterRun++;
    else enterRun = 0;
    // ⌘Z right after a break operation undoes the break via the structural
    // stack — the engine's own undo never saw it and would corrupt the page
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      e.code === "KeyZ" &&
      breakRun > 0 &&
      undoStack.length
    ) {
      e.preventDefault();
      breakRun--;
      structuralUndo();
      return;
    }
    // Chromium's selection-delete can duplicate a neighboring character when
    // the selection spans fragmented text nodes. Merging the fragments right
    // before any destructive keystroke.
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      const s = window.getSelection();
      const destructive =
        e.key === "Backspace" ||
        e.key === "Delete" ||
        (s && !s.isCollapsed && (e.key.length === 1 || e.key === "Enter"));
      if (destructive) healSelectionSeams(body);
    }
    if (styleKeepScroll(e)) return;
    if (handlePoetry(e, body, chId)) return;
    if (poetryBackspace(e, body, chId)) return;
    if (sceneBreakDelete(e, body, chId)) return;
    if (spaceSafeDelete(e, body, chId)) return;
    if (emptyChapterBackspace(e, body, chId)) return;
    if (chapterStartBackspace(e, body, chId)) return;
    if (guardMarkerDelete(e, body, chId)) return;
    if (handleEnter(e, body, chId)) return;
    if (handleTabSpacing(e)) return;
    smartKeys(e, body);
  });
  // when the whole chapter loses focus, merge every fragmented text node
  body.addEventListener("blur", () => {
    try {
      body.normalize();
    } catch {
      /* nothing to merge */
    }
  });
  body.addEventListener("mousedown", () => {
    enterRun = 0;
  });
  body.addEventListener("click", (e) => {
    const mark = e.target.closest(".ph-mark");
    if (mark) focusSticky(mark.dataset.sid);
    // clicking a ghost outline note selects it, ready to be replaced with prose
    const ghost = e.target.closest("p.ghost");
    if (ghost) {
      const r = document.createRange();
      r.selectNodeContents(ghost);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
  });
  // the moment writing hits a ghost, it becomes prose
  // (it keeps its data-sec-id so the outline knows it's been written)
  body.addEventListener("beforeinput", () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    let el = sel.anchorNode;
    if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    const ghost = el && el.closest ? el.closest("p.ghost") : null;
    if (ghost && body.contains(ghost)) {
      ghost.classList.remove("ghost");
    }
    // ::first-letter and contenteditable can interfere while Chromium is
    // changing the opening paragraph. Disable it only for this edit, then
    // restore it in the input handler above.
    const paragraph = el && el.closest ? el.closest("p.chapter-opening") : null;
    body.classList.toggle("cap-off", !!(paragraph && body.contains(paragraph)));
  });
}

function focusChapterStart(chId) {
  const nb = document.querySelector(
    `.chapter[data-id="${chId}"] .chapter-body`,
  );
  if (!nb) return;
  nb.focus({ preventScroll: true });
  const nr = document.createRange();
  const first = nb.querySelector("p");
  if (first)
    nr.setStart(first, 0); // inside the first paragraph, not the container
  else nr.selectNodeContents(nb);
  nr.collapse(true);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(nr);
  currentChapterId = chId;
  highlightNav();
}

// Backspace in an empty chapter deletes it:
function emptyChapterBackspace(e, body, chId) {
  if (e.key !== "Backspace" || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (body.innerText.trim() !== "") return false; // ghosts count as content
  const idx = book.chapterOrder.indexOf(chId);
  if (idx < 0 || book.chapterOrder.length < 2) return false;
  e.preventDefault();
  snapshotStructure("empty chapter removed");
  breakRun++;
  if (idx > 0) {
    const prev = book.chapterOrder[idx - 1];
    deleteChapterQuiet(chId).then(() => {
      focusChapter(prev);
      resetNativeUndo();
    });
  } else {
    // an empty chapter 1 dissolves too — the caret lands at the top of
    // what just became the new chapter 1
    const next = book.chapterOrder[1];
    deleteChapterQuiet(chId).then(() => {
      focusChapterStart(next);
      resetNativeUndo();
    });
  }
  return true;
}

// ⌘B / ⌘I applied by hand: the engine's native handling scrolls the
// selection "into view" and mis-measures NEO's transformed page column,
// throwing the reader to the top of the screen. Style, don't scroll.
function styleKeepScroll(e) {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return false;
  if (e.code !== "KeyB" && e.code !== "KeyI") return false;
  e.preventDefault();
  const sc = $("#paper-scroll");
  const keep = sc.scrollTop;
  document.execCommand(e.code === "KeyB" ? "bold" : "italic");
  sc.scrollTop = keep;
  requestAnimationFrame(() => {
    sc.scrollTop = keep;
  });
  return true;
}

// Backspace at the very start of a chapter swallows an empty chapter above it
function chapterStartBackspace(e, body, chId) {
  if (e.key !== "Backspace" || e.metaKey || e.ctrlKey || e.altKey) return false;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(body);
  try {
    pre.setEnd(r.startContainer, r.startOffset);
  } catch {
    return false;
  }
  if (pre.toString().length !== 0) return false; // caret isn't at the chapter's first character
  const idx = book.chapterOrder.indexOf(chId);
  if (idx <= 0) return false;
  const prevId = book.chapterOrder[idx - 1];
  const prevBody = document.querySelector(
    `.chapter[data-id="${prevId}"] .chapter-body`,
  );
  if (!prevBody) return false;
  e.preventDefault();
  if (prevBody.innerText.trim() === "") {
    // empty chapter above: swallow it
    snapshotStructure("empty chapter removed");
    breakRun++;
    deleteChapterQuiet(prevId).then(() => {
      focusChapterStart(chId);
      resetNativeUndo();
    });
    return true;
  }
  // chapter with words above: merge this chapter up into it — the inverse
  // of a triple-Enter split, and ⌘Z restores the split
  snapshotStructure("chapters merged");
  const prevCount = prevBody.querySelectorAll("p").length;
  const keepScroll = $("#paper-scroll").scrollTop;
  chapterHTML[prevId] = captureBody(prevBody) + captureBody(body);
  window.neo.writeChapter(book.id, prevId, chapterHTML[prevId]);
  for (const s of stickies) if (s.chapterId === chId) s.chapterId = prevId;
  window.neo.writeJSON(book.id, "stickies", stickies);
  for (const d of darlings) if (d.chapterId === chId) d.chapterId = prevId;
  window.neo.writeJSON(book.id, "darlings", darlings);
  if (book.sectionNotes && book.sectionNotes[chId]) {
    book.sectionNotes[prevId] = [
      ...(book.sectionNotes[prevId] || []),
      ...book.sectionNotes[chId],
    ];
    delete book.sectionNotes[chId];
  }
  if (book.chapterTitles) delete book.chapterTitles[chId];
  if (book.chapterNotes) delete book.chapterNotes[chId];
  if (book.chapterStatus) delete book.chapterStatus[chId];
  book.chapterOrder = book.chapterOrder.filter((c) => c !== chId);
  delete chapterHTML[chId];
  window.neo.deleteChapter(book.id, chId);
  saveMeta();
  renderChapters();
  renderStickies();
  restoreCaret({ chId: prevId, pIdx: prevCount, off: 0, scroll: keepScroll });
  resetNativeUndo();
  breakRun++;
  return true;
}

// Tab for spacing:
function handleTabSpacing(e) {
  if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return false;
  e.preventDefault();
  if (!e.shiftKey) {
    document.execCommand("insertText", false, "  ");
    return true;
  }
  // Shift+Tab: remove up to two preceding em spaces
  const sel = window.getSelection();
  if (sel.rangeCount && sel.isCollapsed) {
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      let n = 0;
      while (
        n < 2 &&
        r.startOffset - n > 0 &&
        node.textContent[r.startOffset - n - 1] === " "
      )
        n++;
      if (n > 0) {
        const del = document.createRange();
        del.setStart(node, r.startOffset - n);
        del.setEnd(node, r.startOffset);
        del.deleteContents();
      }
    }
  }
  return true;
}

function flatOffset(p, container, offset) {
  // flatten any (container, offset) pair to a character offset in p.textContent
  let n;
  if (container.nodeType !== Node.TEXT_NODE) {
    if (!p.contains(container) && container !== p) return -99;
    let acc = 0;
    for (let i = 0; i < offset && i < container.childNodes.length; i++) {
      acc += container.childNodes[i].textContent.length;
    }
    let before = 0;
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    while ((n = w.nextNode())) {
      if (container === p || container.contains(n)) break;
      before += n.textContent.length;
    }
    return (container === p ? 0 : before) + acc;
  }
  let pos = 0;
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  while ((n = walker.nextNode())) {
    if (n === container) return pos + offset;
    pos += n.textContent.length;
  }
  return -1;
}

function flatPoint(p, off) {
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let pos = 0,
    n;
  while ((n = w.nextNode())) {
    const len = n.textContent.length;
    if (off <= pos + len) return [n, off - pos];
    pos += len;
  }
  return null;
}

// A delete that leaves two plain spaces touching triggers the engine's broken
// whitespace repair, which duplicates a neighboring character. When that exact
// hazard is about to happen, take the right-hand space along with the deletion,
// leaving one clean space. All other deletes stay native.
function spaceSafeDelete(e, body, chId) {
  if (e.key !== "Backspace" && e.key !== "Delete") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const r = sel.getRangeAt(0);
  const elOf = (n) => (n.nodeType === Node.TEXT_NODE ? n.parentElement : n);
  const pA = elOf(r.startContainer)?.closest?.("p");
  const pB = elOf(r.endContainer)?.closest?.("p");
  if (!pA || pA !== pB || !body.contains(pA)) return false;
  const t = pA.textContent;
  let from, to;
  if (sel.isCollapsed) {
    const at = flatOffset(pA, r.startContainer, r.startOffset);
    if (at < 0) return false;
    if (e.key === "Backspace") {
      from = at - 1;
      to = at;
    } else {
      from = at;
      to = at + 1;
    }
    if (from < 0 || to > t.length) return false;
  } else {
    from = flatOffset(pA, r.startContainer, r.startOffset);
    to = flatOffset(pA, r.endContainer, r.endOffset);
    if (from < 0 || to <= from) return false;
  }
  if (t[from - 1] !== " " || t[to] !== " ") return false;
  let end = to;
  while (t[end] === " ") end++;
  const a = flatPoint(pA, from),
    b = flatPoint(pA, end);
  if (!a || !b) return false;
  e.preventDefault();
  const nr = document.createRange();
  nr.setStart(a[0], a[1]);
  nr.setEnd(b[0], b[1]);
  sel.removeAllRanges();
  sel.addRange(nr);
  document.execCommand("insertText", false, "");
  return true;
}

// Merge fragmented text nodes in the paragraph(s) the selection touches,
// so native editing operates on whole text instead of seams.
function healSelectionSeams(body) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const paraOf = (n) => {
    if (n && n.nodeType === Node.TEXT_NODE) n = n.parentElement;
    return n && n.closest ? n.closest("p") : null;
  };
  const a = paraOf(r.startContainer);
  const b = paraOf(r.endContainer);
  try {
    if (a && body.contains(a)) a.normalize();
  } catch {
    /* fine */
  }
  try {
    if (b && b !== a && body.contains(b)) b.normalize();
  } catch {
    /* fine */
  }
}

// Chromium mangles Backspace/Delete beside non-editable inline elements:
function guardMarkerDelete(e, body, chId) {
  if (e.key !== "Backspace" && e.key !== "Delete") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  const node = r.startContainer;
  const back = e.key === "Backspace";
  const isMark = (n) =>
    n &&
    n.nodeType === Node.ELEMENT_NODE &&
    (n.classList.contains("ph-mark") || n.classList.contains("darling-anchor"));

  // Case 1: the deletion would cross INTO a marker (caret at a node boundary,
  // marker on the far side) — delete the marker itself, cleanly.
  let adjacent = null;
  if (node.nodeType === Node.TEXT_NODE) {
    if (back && r.startOffset === 0) adjacent = node.previousSibling;
    else if (!back && r.startOffset === node.textContent.length)
      adjacent = node.nextSibling;
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    adjacent = back
      ? node.childNodes[r.startOffset - 1]
      : node.childNodes[r.startOffset];
  }
  if (isMark(adjacent)) {
    e.preventDefault();
    if (adjacent.classList.contains("ph-mark") && adjacent.dataset.sid) {
      // Removing a marker while drafting means “come back later”, not “lose
      // the note”. Keep its anchor invisible so it can be reopened exactly here.
      setStickyResolved(adjacent.dataset.sid);
    } else {
      adjacent.remove();
      syncChapter(body, chId);
    }
    return true;
  }

  // Case 2: deleting a character inside a text node that TOUCHES a marker:
  if (node.nodeType !== Node.TEXT_NODE) return false;
  if (back ? r.startOffset === 0 : r.startOffset >= node.textContent.length)
    return false;
  if (!isMark(node.previousSibling) && !isMark(node.nextSibling)) return false;

  e.preventDefault();
  const targetOffset = back ? r.startOffset - 1 : r.startOffset;
  const del = document.createRange();
  del.setStart(node, targetOffset);
  del.setEnd(node, targetOffset + 1);
  del.deleteContents();
  const caret = document.createRange();
  caret.setStart(node, targetOffset);
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
  syncChapter(body, chId);
  return true;
}

// The engine wraps text in style-carrying spans during merges and splits
// ("<span style='text-indent...'>"). They corrupt later edits — unwrap them,
// keeping only NEO's own marks.
function stripJunkSpans(el) {
  for (const s of [...el.querySelectorAll("span:not(.ph-mark)")]) {
    while (s.firstChild) s.before(s.firstChild);
    s.remove();
  }
}

// Enter once: new paragraph. Enter twice: *** section break — wherever the
// caret is, even mid-sentence. Enter three times: the chapter splits here.
let enterRun = 0;
// break operations live outside the engine's undo history; while the most
// recent edits are breaks, ⌘Z routes to NEO's structural undo, one per press
let breakRun = 0;

function splitChapterAt(body, chId, block, sel) {
  const parts = [];
  let n = block;
  while (n) {
    const next = n.nextElementSibling;
    parts.push(n.outerHTML);
    n.remove();
    n = next;
  }
  if (!body.querySelector("p")) body.innerHTML = "<p><br></p>";
  syncChapter(body, chId);
  const idx = book.chapterOrder.indexOf(chId);
  const newId = createChapterAt(idx + 1);
  chapterHTML[newId] = parts.join("") || "<p><br></p>";
  window.neo.writeChapter(book.id, newId, chapterHTML[newId]);
  const keepScroll = $("#paper-scroll").scrollTop;
  renderChapters();
  focusChapterStart(newId);
  $("#paper-scroll").scrollTop = keepScroll; // the split point stays in view
  resetNativeUndo();
  breakRun++;
}

function handleEnter(e, body, chId) {
  if (e.key !== "Enter" || e.shiftKey) return false;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  let el = sel.anchorNode;
  if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  const block = el && el.closest ? el.closest("p") : null;
  if (!block || !body.contains(block)) return false;
  if (block.classList.contains('scene-break')) { e.preventDefault(); return true; } // Enter on a *** line: nothing
  // Enter in a poetry paragraph steps back into prose: an empty line becomes
  // an ordinary paragraph in place; otherwise the line splits and the new
  // paragraph is plain (⇧Enter is how the poem continues)
  if (block.classList.contains('poetry')) {
    e.preventDefault();
    enterRun = 0;
    if (block.textContent.trim() === '') {
      snapshotStructure('poetry paragraph to prose');
      block.classList.remove('poetry');
      romanize(block);
      placeCaret(block, 0);
      syncChapter(body, chId);
      resetNativeUndo();
      breakRun++;
      return true;
    }
    document.execCommand('insertParagraph');
    const cur = caretBlock(body);
    if (cur && cur !== block) {
      cur.classList.remove('poetry');
      romanize(cur);
      placeCaret(cur, 0);
    }
    syncChapter(body, chId);
    return true;
  }
  const prev = block.previousElementSibling;

  if (block.textContent.trim() !== "") {
    // caret inside a real paragraph — where is it?
    const r = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(block);
    try {
      pre.setEnd(r.startContainer, r.startOffset);
    } catch {
      return false;
    }
    const atStart = pre.toString().length === 0;

    // second/third Enter mid-flow: the caret sits at the start of the text
    // that the previous press pushed down
    if (atStart && enterRun >= 2 && prev) {
      if (prev.classList.contains("scene-break")) {
        // third Enter: everything from here becomes the next chapter
        e.preventDefault();
        snapshotStructure("chapter split");
        prev.remove();
        splitChapterAt(body, chId, block, sel);
        return true;
      }
      e.preventDefault();
      // a break made by the full double-Enter gesture un-splits on undo too
      snapshotStructure("section break", { rejoin: enterRun >= 2 });
      if (prev.textContent.trim() === "") {
        prev.classList.add("scene-break");
        prev.textContent = "***";
      } else {
        const brk = document.createElement("p");
        brk.className = "scene-break";
        brk.textContent = "***";
        block.before(brk);
      }
      const keep = document.createRange();
      keep.setStart(block, 0);
      keep.collapse(true);
      sel.removeAllRanges();
      sel.addRange(keep);
      syncChapter(body, chId);
      resetNativeUndo();
      breakRun++;
      return true;
    }

    // normal Enter — native split so ⌘Z keeps working; junk spans (which
    // make the engine clone whole paragraphs) are stripped first if present
    e.preventDefault();
    if (block.querySelector("span:not(.ph-mark)")) stripJunkSpans(block);
    document.execCommand("insertParagraph");
    syncChapter(body, chId);
    return true;
  }

  // Third Enter at end of flow: empty paragraph under a *** — chapter splits here
  if (prev && prev.classList.contains("scene-break")) {
    e.preventDefault();
    snapshotStructure("chapter split");
    prev.remove();
    splitChapterAt(body, chId, block, sel);
    return true;
  }

  // Second Enter at end of flow: the empty paragraph becomes a *** break
  if (prev) {
    e.preventDefault();
    snapshotStructure("section break", { rejoin: enterRun >= 2 });
    block.classList.add("scene-break");
    block.textContent = "***";
    const np = document.createElement("p");
    np.innerHTML = "<br>";
    block.after(np);
    const range = document.createRange();
    range.setStart(np, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    syncChapter(body, chId);
    resetNativeUndo();
    breakRun++;
    return true;
  }
  return false;
}
