"use strict";

/* ================================================================== */
/*  SEARCH THE LIBRARY (from the shelf)                                */
/*  Every book at once — for series continuity: what colour were her   */
/*  eyes in book one? Click a result to open the book right there.     */
/* ================================================================== */

function openLibrarySearch(preset = "") {
  document.querySelector(".lsearch-backdrop")?.remove();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop lsearch-backdrop";
  bd.innerHTML = `
    <div class="modal lsearch-modal">
      <div class="stats-modal-head"><h2 style="font-size:17px">Search the library</h2><button class="m-cancel btn-quiet" title="Close">×</button></div>
      <input id="lsearch-input" type="text" placeholder="A name, a phrase, a detail…" autocomplete="off" spellcheck="false"/>
      <div class="lsearch-summary"></div>
      <div class="lsearch-results"></div>
    </div>`;
  document.body.appendChild(bd);
  const input = bd.querySelector("#lsearch-input");
  const list = bd.querySelector(".lsearch-results");
  const summary = bd.querySelector(".lsearch-summary");
  const close = () => bd.remove();
  let timer = null;
  let seq = 0;
  const run = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < 2) {
      summary.textContent = q ? "Type at least two letters." : "";
      list.innerHTML = "";
      return;
    }
    summary.textContent = "Searching…";
    const results = await window.neo.searchLibrary(q);
    if (mine !== seq || !bd.isConnected) return; // a newer search is on its way
    const total = results.reduce((n, r) => n + r.count, 0);
    summary.textContent = total
      ? `${total} match${total === 1 ? "" : "es"} in ${results.length} book${results.length === 1 ? "" : "s"}`
      : "No matches in any book.";
    list.innerHTML = results.map((r) => `
      <div class="lsearch-book"><span>${escHtml(r.title)}</span><small>${r.count} match${r.count === 1 ? "" : "es"}</small></div>
      ${r.hits.map((h) => `<button class="lsearch-hit" data-book="${escHtml(r.bookId)}" data-ch="${escHtml(h.chapterId)}" data-ord="${h.ordinal}">
        <span class="where">Chapter ${h.chapterIndex + 1}${h.chapterTitle ? ": " + escHtml(h.chapterTitle) : ""}</span>${escHtml(h.before)}<mark>${escHtml(h.match)}</mark>${escHtml(h.after)}</button>`).join("")}
      ${r.count > r.hits.length ? `<div class="lsearch-more">…and ${r.count - r.hits.length} more in this book. Open it and use Find to see them all.</div>` : ""}`).join("");
    list.querySelectorAll(".lsearch-hit").forEach((btn) => {
      btn.onclick = () => {
        close();
        jumpToLibraryHit(btn.dataset.book, btn.dataset.ch, Number(btn.dataset.ord), q);
      };
    });
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  bd.querySelector(".m-cancel").onclick = close;
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    if (e.key === "Enter" && e.target === input) { clearTimeout(timer); run(); }
    if (e.key === "ArrowDown" && e.target === input) { e.preventDefault(); list.querySelector(".lsearch-hit")?.focus(); }
  });
  input.value = preset;
  input.focus();
  if (preset) run();
}

// Open the book, then use the editor's own Find so the writer lands on the
// match with Find already set up for the next one.
async function jumpToLibraryHit(bookId, chId, ordinal, query) {
  if (book && book.id !== bookId) await backToShelf();
  if (!book) await openBook(bookId);
  if (!book || !book.chapterOrder.includes(chId)) return;
  switchTab("manuscript");
  openSearch();
  $("#search-input").value = query;
  runSearch();
  const inChapter = searchState.matches
    .map((m, i) => ({ i, ch: m.range.startContainer.parentElement?.closest(".chapter")?.dataset.id }))
    .filter((m) => m.ch === chId);
  if (!inChapter.length) return;
  const target = inChapter[Math.min(ordinal, inChapter.length - 1)].i;
  requestAnimationFrame(() => gotoMatch(target));
}

$("#library-search-btn").onclick = () => openLibrarySearch();
