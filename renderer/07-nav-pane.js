"use strict";

/* ================================================================== */
/*  NAV PANE                                                           */
/* ================================================================== */

function renderNav() {
  const list = $("#nav-list");
  list.innerHTML = "";
  book.chapterNotes = book.chapterNotes || {};
  book.chapterOrder.forEach((chId, i) => {
    const words = chapterWords(chId);
    const flagged = stickies.some((s) => s.chapterId === chId && !s.resolved);
    const chTitle = (book.chapterTitles || {})[chId];
    const status = CHAPTER_STATUS[(book.chapterStatus || {})[chId]];
    const item = document.createElement("div");
    item.className = "nav-item" + (chId === currentChapterId ? " current" : "");
    item.dataset.id = chId;
    item.innerHTML = `<div class="n-row" title="Drag to reorder chapters"><span class="n-label"></span>
      <span style="display:flex;align-items:center">${status ? `<span class="n-status n-status-${status.key}" title="${status.label} · right-click to change">${status.mark}</span>` : ""}<span class="n-words">${words.toLocaleString()}</span>${flagged ? '<span class="n-flag" title="Unresolved placeholder"></span>' : ""}</span></div>`;
    item.querySelector(".n-label").textContent =
      book.chapterOrder.length === 1
        ? book.title || "The story"
        : chTitle
          ? `${i + 1} · ${chTitle}`
          : `Chapter ${i + 1}`;

    // the row is the drag handle, so the note below stays freely editable
    const rowEl = item.querySelector(".n-row");
    rowEl.draggable = true;
    rowEl.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-neo-chapter", chId);
      item.classList.add("dragging");
    });
    rowEl.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      const ind = document.querySelector(".nav-drop-ind");
      if (ind) ind.remove();
    });

    // outline your whole book from this panel:
    const note = document.createElement("div");
    note.className = "nav-note";
    note.contentEditable = "true";
    note.spellcheck = false;
    note.textContent = book.chapterNotes[chId] || "";
    note.addEventListener("click", (e) => e.stopPropagation());
    note.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        note.blur();
      }
      e.stopPropagation();
    });
    note.addEventListener("blur", () => {
      book.chapterNotes[chId] = note.textContent.trim();
      scheduleMetaSave();
    });
    item.appendChild(note);

    item.onclick = () => {
      switchTab("manuscript");
      focusChapter(chId);
    };
    item.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".nav-note")) return; // the note is text: its own menu
      e.preventDefault();
      chapterStatusMenu(chId, e.clientX, e.clientY);
    });
    list.appendChild(item);
  });
  renderNavProgress();
}

/* ---------- Chapter status: Draft · Revised · Done ---------- */
// A quiet mark in the chapter list, set from a right-click. Nothing in the
// manuscript changes; it's a map of where the revision stands.
const CHAPTER_STATUS = {
  draft: { key: "draft", label: "Draft", mark: "○" },
  revised: { key: "revised", label: "Revised", mark: "◐" },
  done: { key: "done", label: "Done", mark: "●" },
};

function setChapterStatus(chId, value) {
  book.chapterStatus = book.chapterStatus || {};
  if (value) book.chapterStatus[chId] = value;
  else delete book.chapterStatus[chId];
  scheduleMetaSave();
  renderNav();
}

function renderNavProgress() {
  const head = $("#nav-head > span");
  if (!head) return;
  const statuses = book.chapterOrder.map((id) => (book.chapterStatus || {})[id]).filter(Boolean);
  const done = statuses.filter((v) => v === "done").length;
  head.textContent = statuses.length ? `Chapters · ${done} of ${book.chapterOrder.length} done` : "Chapters";
}

function chapterStatusMenu(chId, x, y) {
  document.querySelector(".spell-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "spell-menu status-menu";
  const current = (book.chapterStatus || {})[chId];
  for (const st of Object.values(CHAPTER_STATUS)) {
    const b = document.createElement("button");
    b.innerHTML = `<span class="n-status n-status-${st.key}">${st.mark}</span> ${st.label}${current === st.key ? " ✓" : ""}`;
    b.onclick = () => { menu.remove(); setChapterStatus(chId, st.key); };
    menu.appendChild(b);
  }
  if (current) {
    const sep = document.createElement("div");
    sep.className = "sm-sep";
    menu.appendChild(sep);
    const clear = document.createElement("button");
    clear.textContent = "Clear status";
    clear.onclick = () => { menu.remove(); setChapterStatus(chId, null); };
    menu.appendChild(clear);
  }
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

$("#nav-add").onclick = () => {
  switchTab("manuscript");
  currentChapterId = book.chapterOrder[book.chapterOrder.length - 1] || null;
  newChapter();
};

// drop target for chapter reordering, with a gold line showing the landing spot
const navList = $("#nav-list");
function navDropInd() {
  let ind = document.querySelector(".nav-drop-ind");
  if (!ind) {
    ind = document.createElement("div");
    ind.className = "nav-drop-ind";
  }
  return ind;
}
navList.addEventListener("dragover", (e) => {
  if (!e.dataTransfer.types.includes("application/x-neo-chapter")) return;
  e.preventDefault();
  const ind = navDropInd();
  const items = [...navList.querySelectorAll(".nav-item:not(.dragging)")];
  let placed = false;
  for (const it of items) {
    const r = it.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) {
      navList.insertBefore(ind, it);
      placed = true;
      break;
    }
  }
  if (!placed) navList.appendChild(ind);
});
navList.addEventListener("dragleave", (e) => {
  if (navList.contains(e.relatedTarget)) return;
  const ind = document.querySelector(".nav-drop-ind");
  if (ind) ind.remove();
});
navList.addEventListener("drop", async (e) => {
  const chId = e.dataTransfer.getData("application/x-neo-chapter");
  if (!chId) return;
  e.preventDefault();
  const ind = document.querySelector(".nav-drop-ind");
  let index = book.chapterOrder.filter((c) => c !== chId).length;
  if (ind) {
    index = 0;
    for (const c of navList.children) {
      if (c === ind) break;
      if (c.classList.contains("nav-item") && !c.classList.contains("dragging"))
        index++;
    }
    ind.remove();
  }
  const from = book.chapterOrder.indexOf(chId);
  if (from === -1) return;
  snapshotStructure("chapter reorder");
  book.chapterOrder = book.chapterOrder.filter((c) => c !== chId);
  book.chapterOrder.splice(index, 0, chId);
  await saveMeta();
  renderChapters(); // renumbers heads and rebuilds the nav
  if (currentTab === "outline") renderOutline();
});

function highlightNav() {
  $$(".nav-item").forEach((el) =>
    el.classList.toggle("current", el.dataset.id === currentChapterId),
  );
}

function scheduleNavRefresh() {
  clearTimeout(saveTimers.nav);
  saveTimers.nav = setTimeout(renderNav, 1200);
}

// Hover behavior for both side panes:
function wireHoverPane(hotzone, pane, isPinnable) {
  const pinned = () => isPinnable && pane.dataset.pinned === "1";
  hotzone.addEventListener("mouseenter", (e) => {
    if (e.buttons) return; // dragging something — stand down
    pane.classList.add("open");
  });
  hotzone.addEventListener("mouseleave", (e) => {
    if (pinned()) return;
    if (e.relatedTarget && pane.contains(e.relatedTarget)) return;
    pane.classList.remove("open");
  });
  pane.addEventListener("mouseleave", () => {
    if (pinned()) return;
    pane.classList.remove("open");
  });
}
wireHoverPane($("#nav-hotzone"), $("#nav-pane"), true);
wireHoverPane($("#side-hotzone"), $("#side-pane"), true);

// leaving the window closes unpinned panes (they used to stick open)
function closeUnpinnedPanes() {
  if ($("#nav-pane").dataset.pinned !== "1")
    $("#nav-pane").classList.remove("open");
  if ($("#side-pane").dataset.pinned !== "1")
    $("#side-pane").classList.remove("open");
}
document.documentElement.addEventListener("mouseleave", closeUnpinnedPanes);
window.addEventListener("blur", closeUnpinnedPanes);

// the wheel scrolls the manuscript even when the pointer floats over the
// dark margins beside the (narrower) page column
$("#editor-view").addEventListener(
  "wheel",
  (e) => {
    const scroller = $("#paper-scroll");
    if (e.ctrlKey) return; // pinch-zoom gesture, not a scroll
    if (scroller.contains(e.target)) return; // native scrolling handles it
    if ($("#nav-pane").contains(e.target) || $("#side-pane").contains(e.target))
      return;
    scroller.scrollTop += e.deltaY;
  },
  { passive: true },
);

$("#side-pin").onclick = () => {
  const pane = $("#side-pane");
  const pinned = pane.dataset.pinned === "1";
  pane.dataset.pinned = pinned ? "0" : "1";
  $("#side-pin").classList.toggle("pinned", !pinned);
  $("#editor-view").classList.toggle("side-pinned", !pinned);
  if (!pinned) pane.classList.add("open");
};

$("#side-filter").onclick = () => {
  const list = $("#sticky-list");
  const showAll = list.dataset.showAll !== "1";
  list.dataset.showAll = showAll ? "1" : "0";
  $("#side-filter").textContent = showAll ? "All" : "Pending";
  $("#side-filter").title = showAll
    ? "Show pending notes only"
    : "Show resolved notes too";
  $("#side-filter").classList.toggle("showing-all", showAll);
  renderStickies();
};

$("#nav-pin").onclick = () => {
  const pane = $("#nav-pane");
  const pinned = pane.dataset.pinned === "1";
  pane.dataset.pinned = pinned ? "0" : "1";
  $("#nav-pin").classList.toggle("pinned", !pinned);
  $("#editor-view").classList.toggle("nav-pinned", !pinned);
  if (!pinned) pane.classList.add("open");
};
