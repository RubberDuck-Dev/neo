"use strict";

/* ================================================================== */
/*  PLACEHOLDERS + STICKIES                                            */
/* ================================================================== */

function insertPlaceholder() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  // derive the chapter from where the caret actually is:
  let el = sel.anchorNode;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  const bodyEl = el && el.closest ? el.closest(".chapter-body") : null;
  if (!bodyEl) {
    toast(`Click into a chapter first, then ${KPH} drops a placeholder`);
    return;
  }
  currentChapterId = bodyEl.closest(".chapter").dataset.id;
  const sid = "s-" + Date.now().toString(36);
  const span = document.createElement("span");
  span.className = "ph-mark";
  span.dataset.sid = sid;
  span.contentEditable = "false";
  span.textContent = "⚑";
  const range = sel.getRangeAt(0);
  range.collapse(false);
  range.insertNode(span);
  // park the caret just past the mark and keep writing
  const after = document.createTextNode(" ");
  span.after(after);
  range.setStartAfter(after);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);

  stickies.push({
    id: sid,
    chapterId: currentChapterId,
    text: "",
    resolved: false,
  });
  window.neo.writeJSON(book.id, "stickies", stickies);
  chapterHTML[currentChapterId] = captureBody(
    document.querySelector(
      `.chapter[data-id="${currentChapterId}"] .chapter-body`,
    ),
  );
  scheduleChapterSave(currentChapterId);
  renderStickies();
  scheduleNavRefresh();
}

function renderStickies() {
  const wrap = $("#sticky-list");
  wrap.innerHTML = "";
  const showAll = wrap.dataset.showAll === "1";
  const visible = showAll ? stickies : stickies.filter((s) => !s.resolved);
  if (visible.length === 0) {
    wrap.innerHTML = `<div class="stickies-empty">${stickies.length ? "No pending notes.<br><br>Choose All to revisit resolved notes." : `No notes yet.<br><br>Hit ${KPH} while writing to drop a placeholder — a “come back to this” mark that never breaks your flow.`}</div>`;
    return;
  }
  const ordered = [...visible].sort(
    (a, b) => Number(a.resolved) - Number(b.resolved),
  );
  for (const s of ordered) {
    const chIdx = book.chapterOrder.indexOf(s.chapterId);
    const el = document.createElement("div");
    el.className = "sticky " + (s.resolved ? "resolved" : "unresolved");
    el.dataset.sid = s.id;
    el.innerHTML = `
      <div class="s-ch">${chIdx >= 0 ? "Chapter " + (chIdx + 1) : "Unplaced"}${s.resolved ? '<span class="s-state">resolved</span>' : ""}</div>
      <textarea placeholder="What needs doing here?" spellcheck="false"></textarea>
      <div class="s-actions">${s.resolved ? "" : '<button class="s-go">Go to</button> <button class="s-done">Resolve</button> '}<button class="s-delete">Delete</button></div>`;
    const ta = el.querySelector("textarea");
    ta.value = s.text;
    ta.addEventListener("input", () => {
      s.text = ta.value;
      clearTimeout(saveTimers.stickies);
      saveTimers.stickies = setTimeout(
        () => window.neo.writeJSON(book.id, "stickies", stickies),
        600,
      );
    });
    const go = el.querySelector(".s-go");
    if (go)
      go.onclick = () => {
        switchTab("manuscript");
        const mark = document.querySelector(`.ph-mark[data-sid="${s.id}"]`);
        if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
      };
    const done = el.querySelector(".s-done");
    if (done) done.onclick = () => setStickyResolved(s.id);
    el.querySelector(".s-delete").onclick = () => deleteSticky(s.id);
    wrap.appendChild(el);
  }
}

// Pair every mark in the manuscript with a note: pasted duplicates get their
// own copy of the note, marks that moved chapters update their red dot, and
// marks orphaned by older versions get a fresh (empty) note instead of dying.
function reconcileMarks() {
  if (!book) return;
  const seen = new Set();
  let changed = false;
  for (const m of document.querySelectorAll(".chapter-body .ph-mark")) {
    let sid = m.dataset.sid;
    if (!sid) continue;
    const chEl = m.closest(".chapter");
    const chId = chEl ? chEl.dataset.id : null;
    const existing = stickies.find((s) => s.id === sid);
    if (seen.has(sid)) {
      const nid =
        "s-" +
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2, 5);
      m.dataset.sid = nid;
      stickies.push({
        id: nid,
        chapterId: chId,
        text: existing ? existing.text : "",
        resolved: false,
      });
      seen.add(nid);
      changed = true;
      continue;
    }
    if (!existing) {
      stickies.push({ id: sid, chapterId: chId, text: "", resolved: false });
      changed = true;
    } else if (existing.chapterId !== chId) {
      existing.chapterId = chId;
      changed = true;
    }
    seen.add(sid);
  }
  if (changed) {
    window.neo.writeJSON(book.id, "stickies", stickies);
    renderStickies();
    renderNav();
  }
}

function setStickyResolved(sid) {
  const sticky = stickies.find((s) => s.id === sid);
  if (!sticky) return;
  sticky.resolved = true;
  const mark = document.querySelector(`.ph-mark[data-sid="${sid}"]`);
  if (mark) {
    const chId = mark.closest(".chapter").dataset.id;
    const next = mark.nextSibling;
    mark.remove();
    // The marker has its own spacer so it never joins two words. Once the
    // marker is gone, remove only that spacer — never a writer's own space.
    if (next && next.nodeType === Node.TEXT_NODE && /^ /.test(next.data))
      next.data = next.data.slice(1);
    const body = document.querySelector(
      `.chapter[data-id="${chId}"] .chapter-body`,
    );
    chapterHTML[chId] = captureBody(body);
    scheduleChapterSave(chId);
  }
  window.neo.writeJSON(book.id, "stickies", stickies);
  renderStickies();
  scheduleNavRefresh();
}

function deleteSticky(sid) {
  const mark = document.querySelector(`.ph-mark[data-sid="${sid}"]`);
  if (mark) {
    const chId = mark.closest(".chapter").dataset.id;
    const next = mark.nextSibling;
    mark.remove();
    if (next && next.nodeType === Node.TEXT_NODE && /^ /.test(next.data))
      next.data = next.data.slice(1);
    const body = document.querySelector(`.chapter[data-id="${chId}"] .chapter-body`);
    chapterHTML[chId] = captureBody(body);
    scheduleChapterSave(chId);
  }
  stickies = stickies.filter((s) => s.id !== sid);
  window.neo.writeJSON(book.id, "stickies", stickies);
  renderStickies();
  scheduleNavRefresh();
}

function focusSticky(sid) {
  $("#side-pane").classList.add("open");
  const el = document.querySelector(`.sticky[data-sid="${sid}"] textarea`);
  if (el) el.focus();
}
