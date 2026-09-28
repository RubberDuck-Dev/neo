"use strict";

/* ================================================================== */
/*  EDITOR — open / render                                             */
/* ================================================================== */

async function openBook(bookId) {
  await NeoPlugins.closeBook();
  tabPlaces = {}; // a fresh book starts with fresh places
  dirtyChapters = new Set();
  metaSavePending = false;
  book = await window.neo.readBookMeta(bookId);
  if (!book) return;
  currentChapterId = null; // never carry a chapter reference across books
  undoStack = [];
  chapterHTML = {};
  savedHTML = {};
  for (const chId of book.chapterOrder) {
    chapterHTML[chId] = await window.neo.readChapter(bookId, chId);
    savedHTML[chId] = chapterHTML[chId];
  }
  savedMetaSig = metaSig(book);
  stickies = await window.neo.readJSON(bookId, "stickies", []);
  darlings = await window.neo.readJSON(bookId, "darlings", []);

  $("#bookshelf-view").hidden = true;
  $("#editor-view").hidden = false;
  document.execCommand("defaultParagraphSeparator", false, "p");

  $("#tp-title").textContent = book.title === "Untitled" ? "" : book.title;
  $("#tp-subtitle").textContent = book.subtitle || "";
  const owner = ownerOfBook(book.id);
  if (owner && book.author !== owner.name) {
    book.author = owner.name;
    metaSavePending = true;
    setTimeout(() => saveMeta(false), 0);
  }
  $("#tp-author").textContent = book.author || "Anonymous";
  $$('.tab[data-tab="notes"]')[0].textContent = book.tabNames.notes;
  $$('.tab[data-tab="outline"]')[0].textContent = book.tabNames.outline;
  await NeoPlugins.reconcile();

  const migratedSummaries = migrateOutlineSummaries();
  renderChapters();
  migratedSummaries.forEach(syncGhosts);
  renderStickies();
  migrateDarlingAnchors(); // sweep legacy invisible markers out of the prose
  reconcileMarks(); // re-adopt any note marks orphaned by cut/paste
  updateCounters();

  // Plotters land in the outline for a brand-new book
  const isNew = book.chapterOrder.length === 0;
  if (isNew && library.writingStyle === "plotter") {
    switchTab("outline");
  } else {
    switchTab("manuscript");
    if (isNew) {
      $("#tp-title").focus();
    } else if (
      book.lastPosition &&
      book.chapterOrder.includes(book.lastPosition.chapterId)
    ) {
      // pick up right where you left off
      currentChapterId = book.lastPosition.chapterId;
      const scroll = book.lastPosition.scroll || 0;
      requestAnimationFrame(() => {
        $("#paper-scroll").scrollTop = scroll;
        highlightNav();
        updateCounters();
      });
    }
  }

  // the Enter hint shows once per library, ever
  if (!library.hintShown) {
    library.hintShown = true;
    window.neo.writeLibrary(library);
    setTimeout(
      () =>
        toast(
          `Enter twice = section break · three times = new chapter · ${KHELP} shows everything else`,
          7000,
        ),
      800,
    );
  }
}

function renderChapters() {
  const wrap = $("#chapters");
  wrap.innerHTML = "";
  wordCache = {};
  book.chapterTitles = book.chapterTitles || {};
  // a lone chapter is just "the story" — no heading until a second one exists,
  // at which point both appear, numbered in retrospect
  const solo = book.chapterOrder.length === 1;
  book.chapterOrder.forEach((chId, i) => {
    const sec = document.createElement("section");
    sec.className = "chapter sheet" + (solo ? " solo" : "");
    sec.dataset.id = chId;
    const head = document.createElement("div");
    head.className = "chapter-head";
    head.title =
      "Right-click for chapter options · click after the number to add a title";
    const num = document.createElement("span");
    num.className = "ch-num";
    num.textContent = "Chapter " + (i + 1);
    const sep = document.createElement("span");
    sep.className = "ch-sep";
    sep.textContent = "—";
    const titleSpan = document.createElement("span");
    titleSpan.className = "ch-title";
    titleSpan.contentEditable = "true";
    titleSpan.spellcheck = false;
    titleSpan.textContent = book.chapterTitles[chId] || "";
    if (titleSpan.textContent) head.classList.add("has-title");
    titleSpan.addEventListener("input", () => {
      head.classList.toggle("has-title", titleSpan.textContent.trim() !== "");
    });
    titleSpan.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        titleSpan.blur();
        poetryUnderHeading(sec.querySelector('.chapter-body'), chId);
      } else if (e.key === 'Enter') { e.preventDefault(); titleSpan.blur(); }
      e.stopPropagation();
    });
    titleSpan.addEventListener("blur", () => {
      book.chapterTitles[chId] = titleSpan.textContent.trim();
      scheduleMetaSave();
      renderNav();
    });
    head.appendChild(num);
    head.appendChild(sep);
    head.appendChild(titleSpan);
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      chapterMenu(chId, i);
    });
    const body = document.createElement("div");
    body.className = "chapter-body";
    body.contentEditable = "true";
    body.spellcheck = false; // NEO runs its own spellcheck pass
    body.innerHTML = chapterHTML[chId] || "<p><br></p>";
    // older marks used a "?" that read as a broken image — normalize to the flag
    body.querySelectorAll(".ph-mark").forEach((m) => {
      m.textContent = "⚑";
      // A short-lived version kept resolved anchors invisibly in the text.
      // Remove those legacy anchors now: a resolved note is a record, not a
      // fragile promise to put a marker back after the prose has moved on.
      const sticky = stickies.find((s) => s.id === m.dataset.sid);
      if (sticky && sticky.resolved) m.remove();
    });
    // heal the engine's style-junk spans left by past merges and splits
    stripJunkSpans(body);
    // heal prose that got merged into a scene-break's styled paragraph:
    // real breaks contain only ***, anything else is a stained paragraph
    body.querySelectorAll("p.scene-break").forEach((p) => {
      if (p.textContent.trim() !== "***") {
        p.classList.remove("scene-break");
        p.removeAttribute("style");
      }
    });
    // heal no-break spaces planted in prose by the old engine repair pass
    const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = tw.nextNode())) {
      if (tn.data.includes("\u00a0")) tn.data = tn.data.replace(/\u00a0/g, " ");
    }
    refreshChapterOpening(body);
    wireChapterBody(body, chId);
    sec.appendChild(head);
    sec.appendChild(body);
    wrap.appendChild(sec);
  });
  renderNav();
}

// The first paragraph is not always the chapter opening: an empty paragraph,
// outline ghost, or section break can come first. Mark the first real prose
// paragraph explicitly so the drop cap survives reloads and structural edits.
function refreshChapterOpening(body) {
  for (const p of body.querySelectorAll("p.chapter-opening")) {
    p.classList.remove("chapter-opening");
    p.classList.remove("has-leading-quote");
    p.querySelectorAll("span.dropcap-letter, span.opening-quote").forEach(
      (span) => {
        span.replaceWith(...span.childNodes);
      },
    );
  }
  const opening = [...body.children].find(
    (el) =>
      el.tagName === "P" &&
      !el.classList.contains("scene-break") &&
      !el.classList.contains("ghost") &&
      !el.classList.contains("poetry") &&
      /\S/.test(el.textContent),
  );
  if (!opening) return;
  opening.classList.add("chapter-opening");

  // CSS ::first-letter includes leading punctuation. When prose begins with a
  // quotation mark, give the following letter its own drop-cap element so the
  // quote stays small and aligned with the line of text.
  const quotes = new Set(['"', "“", "”", "‘", "’", "«", "»", "‹", "›"]);
  const textNodes = [];
  const walker = document.createTreeWalker(opening, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);
  const leadingQuotes = [];
  let target = null;
  for (const textNode of textNodes) {
    let offset = 0;
    for (const char of textNode.data) {
      if (/\s/.test(char)) {
        offset += char.length;
        continue;
      }
      if (!target && quotes.has(char)) {
        leadingQuotes.push({ node: textNode, offset, char });
        offset += char.length;
        continue;
      }
      target = { node: textNode, offset, char };
      break;
    }
    if (target) break;
  }
  if (!leadingQuotes.length || !target) return;

  // Float the quote and cap in document order. Leaving the quote as raw text
  // lets the following float slide in front of it.
  const markers = new Map();
  const addMarker = (marker, className) => {
    const list = markers.get(marker.node) || [];
    list.push({ ...marker, className });
    markers.set(marker.node, list);
  };
  leadingQuotes.forEach((quote) => addMarker(quote, "opening-quote"));
  addMarker(target, "dropcap-letter");
  for (const [textNode, nodeMarkers] of markers) {
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const marker of nodeMarkers.sort((a, b) => a.offset - b.offset)) {
      fragment.append(
        document.createTextNode(textNode.data.slice(cursor, marker.offset)),
      );
      const span = document.createElement("span");
      span.className = marker.className;
      span.textContent = marker.char;
      fragment.append(span);
      cursor = marker.offset + marker.char.length;
    }
    fragment.append(document.createTextNode(textNode.data.slice(cursor)));
    textNode.replaceWith(fragment);
  }
  opening.classList.add("has-leading-quote");
}

async function deleteChapterToDarlings(chId) {
  snapshotStructure("chapter delete");
  const index = book.chapterOrder.indexOf(chId);
  const text = chapterText(chId).trim();
  if (text) {
    const bodyEl = document.querySelector(
      `.chapter[data-id="${chId}"] .chapter-body`,
    );
    darlings.push({
      id: "d-" + Date.now().toString(36),
      html: bodyEl ? bodyEl.innerHTML : chapterHTML[chId],
      text: text.slice(0, 2000),
      chapterId: null,
      chapterLabel: `deleted Chapter ${index + 1}`,
      date: new Date().toISOString(),
    });
    await window.neo.writeJSON(book.id, "darlings", darlings);
  }
  if (currentChapterId === chId) currentChapterId = null;
  await deleteChapterQuiet(chId);
  if (text)
    toast(`Chapter removed — its words are in Darlings, or ${KZ} to undo`);
}

async function chapterMenu(chId, index) {
  const words = countWords(chapterText(chId));
  const choice = await optionModal(
    `Chapter ${index + 1}`,
    words ? `${words.toLocaleString()} words.` : "This chapter is empty.",
    [
      {
        label: "Delete chapter",
        desc: words
          ? "Its words move to Darlings, recoverable anytime."
          : "Nothing to save — it just goes.",
        danger: true,
        value: "delete",
      },
    ],
  );
  if (choice === "delete") await deleteChapterToDarlings(chId);
}
