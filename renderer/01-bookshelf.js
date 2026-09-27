"use strict";

/* ================================================================== */
/*  BOOKSHELF                                                          */
/* ================================================================== */

let libraryDirPath = "";

function coverUrl(meta) {
  // Pocket serves the library through a URL; desktop hands a plain path
  if (/^[a-z]+:\/\//.test(libraryDirPath)) {
    return (
      libraryDirPath +
      "/" +
      encodeURIComponent(meta.id) +
      "/" +
      encodeURIComponent(meta.coverImage)
    );
  }
  const p = (libraryDirPath + "/" + meta.id + "/" + meta.coverImage).replace(
    /\\/g,
    "/",
  );
  return encodeURI("file://" + (p.startsWith("/") ? "" : "/") + p);
}

async function loadLibrary() {
  libraryDirPath = await window.neo.libraryPath();
  library = await window.neo.readLibrary();
  if (!library.firstRunDone) {
    showFirstRun();
  }
  renderShelves();
  // bring older books (which could carry their own author) in line once
  if (library.firstRunDone && (await syncAllBookAuthors())) renderShelves();
}

function showFirstRun() {
  const fr = $("#firstrun");
  fr.hidden = false;
  let picked = { body: Object.keys(BODY_FONTS)[0] || 'Georgia', dropcap: 'literary' };

  // Step 1: who are you, and how do you write?
  $$(".fr-choice").forEach((btn) => {
    btn.onclick = () => {
      library.authorName = $("#fr-name").value.trim();
      const pen = $("#fr-pen").value.trim();
      library.penNames = pen ? [pen] : [];
      library.writingStyle = btn.dataset.style;
      $("#fr-step1").hidden = true;
      $("#fr-step2").hidden = false;
      buildFontStep();
    };
  });

  // Step 2: fonts, with a WYSIWYG sample
  function preview() {
    document.documentElement.style.setProperty(
      "--body-font",
      BODY_FONTS[picked.body],
    );
    document.documentElement.style.setProperty(
      "--dropcap-font",
      DROPCAP_FONTS[picked.dropcap],
    );
  }
  function buildFontStep() {
    const bodyRow = $("#fr-bodyfonts");
    bodyRow.innerHTML = "";
    for (const name of BODY_FONT_CHOICES) {
      const b = document.createElement("button");
      b.className = "fr-font" + (picked.body === name ? " sel" : "");
      b.textContent = name;
      b.style.fontFamily = BODY_FONTS[name];
      b.onmouseenter = () => {
        document.documentElement.style.setProperty(
          "--body-font",
          BODY_FONTS[name],
        );
      };
      b.onmouseleave = preview;
      b.onclick = () => {
        picked.body = name;
        buildFontStep();
        preview();
      };
      bodyRow.appendChild(b);
    }
    const capRow = $("#fr-dropcaps");
    capRow.innerHTML = "";
    const caps = { literary: "Literary", fantasy: "Fantasy", scifi: "Sci-Fi" };
    for (const key of Object.keys(caps)) {
      const b = document.createElement("button");
      b.className = "fr-font" + (picked.dropcap === key ? " sel" : "");
      b.innerHTML = `<span class="fr-cap" style="font-family:${DROPCAP_FONTS[key].replace(/"/g, "&quot;")}">A</span>${caps[key]}`;
      b.onmouseenter = () => {
        document.documentElement.style.setProperty(
          "--dropcap-font",
          DROPCAP_FONTS[key],
        );
      };
      b.onmouseleave = preview;
      b.onclick = () => {
        picked.dropcap = key;
        buildFontStep();
        preview();
      };
      capRow.appendChild(b);
    }
    preview();
  }

  $("#fr-done").onclick = async () => {
    library.fonts = { body: picked.body, dropcap: picked.dropcap };
    library.firstRunDone = true;
    // the shelf was drawn (and the author record seeded as Anonymous) before
    // the name was typed — carry the name across
    currentAuthor().name =
      library.authorName || (library.penNames || [])[0] || "Anonymous";
    await window.neo.writeLibrary(library);
    applyFonts();
    fr.hidden = true;
    renderShelves();
  };
}

// Pen names: each author owns a set of shelves. Books all live in the one
// NEO Library folder on disk regardless of name — switching or deleting a
// pen name never touches files.
function currentAuthor() {
  if (!library.authors || !library.authors.length) {
    library.authors = [
      {
        id: "a1",
        name:
          library.authorName ||
          (library.penNames && library.penNames[0]) ||
          "Anonymous",
      },
    ];
  }
  return (
    library.authors.find((a) => a.id === library.currentAuthorId) ||
    library.authors[0]
  );
}

function shelvesFor(authorId) {
  const homeId = library.authors[0].id;
  return library.shelves.filter((s) => (s.authorId || homeId) === authorId);
}

// The pen name a book belongs to: the owner of the shelf it sits on.
function ownerOfBook(bookId) {
  currentAuthor(); // make sure library.authors exists
  const homeId = library.authors[0].id;
  const shelf = library.shelves.find((s) => (s.bookIds || []).includes(bookId));
  if (!shelf) return null;
  return library.authors.find((a) => a.id === (shelf.authorId || homeId)) || library.authors[0];
}

// One name, everywhere: a book's title-page author is always the pen name
// of the shelf it's on. Rename the pen name (on the shelf or on a title
// page) and every one of its books follows, so covers and exports agree.
async function syncBookAuthors(author) {
  const homeId = library.authors[0].id;
  const ids = library.shelves.filter((s) => (s.authorId || homeId) === author.id).flatMap((s) => s.bookIds || []);
  let changed = 0;
  for (const id of ids) {
    if (book && book.id === id) {
      if (book.author !== author.name) {
        book.author = author.name;
        if (document.activeElement !== $("#tp-author")) $("#tp-author").textContent = author.name;
        scheduleMetaSave();
        changed++;
      }
      continue;
    }
    const meta = await window.neo.readBookMeta(id);
    if (meta && meta.author !== author.name) {
      meta.author = author.name;
      await window.neo.writeBookMeta(id, meta);
      changed++;
    }
  }
  return changed;
}

async function syncAllBookAuthors() {
  currentAuthor();
  let changed = 0;
  for (const a of library.authors) changed += await syncBookAuthors(a);
  return changed;
}

function displayAuthor() {
  return currentAuthor().name || "Anonymous";
}


async function renderShelves() {
  await NeoCovers.ready; // display faces, so titles measure true
  const view = $("#bookshelf-view");
  const keepScroll = view.scrollTop; // re-rendering must not move the page
  $("#author-chip").textContent = displayAuthor();
  applyPluginAppearance();
  const wrap = $("#shelves");
  // the new shelves are built off-screen and swapped in whole, so the page
  // never goes blank while books are read from disk — no flash on a drop
  const built = document.createDocumentFragment();
  // shelves drag by their grip to reorder, with a gold bar showing the drop spot
  if (!wrap.dataset.dndWired) {
    wrap.dataset.dndWired = "1";
    wrap.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-neo-shelf")) return;
      e.preventDefault();
      let ind = wrap.querySelector(".shelf-drop-ind");
      if (!ind) {
        ind = document.createElement("div");
        ind.className = "shelf-drop-ind";
      }
      let placed = false;
      for (const s of wrap.querySelectorAll(".shelf:not(.dragging)")) {
        const r = s.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
          wrap.insertBefore(ind, s);
          placed = true;
          break;
        }
      }
      if (!placed) wrap.appendChild(ind);
    });
    wrap.addEventListener("drop", async (e) => {
      const shelfId = e.dataTransfer.getData("application/x-neo-shelf");
      if (!shelfId) return;
      e.preventDefault();
      const ind = wrap.querySelector(".shelf-drop-ind");
      let index = library.shelves.length;
      if (ind) {
        index = 0;
        for (const c of wrap.children) {
          if (c === ind) break;
          if (
            c.classList.contains("shelf") &&
            !c.classList.contains("dragging")
          )
            index++;
        }
        ind.remove();
      }
      const moving = library.shelves.find((s) => s.id === shelfId);
      if (!moving) return;
      library.shelves = library.shelves.filter((s) => s.id !== shelfId);
      library.shelves.splice(index, 0, moving);
      await window.neo.writeLibrary(library);
      // move the shelf on screen rather than redrawing everything
      const secs = [...wrap.querySelectorAll(".shelf")];
      const movingSec = secs.find((el) => el.dataset.shelfId === shelfId);
      const others = secs.filter((el) => el !== movingSec);
      if (movingSec) wrap.insertBefore(movingSec, others[index] || null);
      else renderShelves();
    });
  }

  for (const shelf of shelvesFor(currentAuthor().id)) {
    const sec = document.createElement("section");
    sec.className = "shelf";
    sec.dataset.shelfId = shelf.id;

    const grip = document.createElement("span");
    grip.className = "shelf-grip";
    grip.textContent = "⠿";
    grip.title = "Drag to reorder shelves";
    grip.draggable = true;
    grip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-neo-shelf", shelf.id);
      sec.classList.add("dragging");
    });
    grip.addEventListener("dragend", () => {
      sec.classList.remove("dragging");
      const ind = document.querySelector(".shelf-drop-ind");
      if (ind) ind.remove();
    });
    sec.appendChild(grip);

    const label = document.createElement("span");
    label.className = "shelf-label";
    label.contentEditable = "true";
    label.spellcheck = false;
    label.textContent = shelf.name;
    label.title = "Click to rename · right-click to export or delete";
    label.addEventListener("blur", async () => {
      shelf.name = label.textContent.trim() || shelf.name;
      label.textContent = shelf.name;
      await window.neo.writeLibrary(library);
    });
    label.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        label.blur();
      }
    });
    // right-click a shelf label: publish it as one book, or delete it
    label.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      const choice = await optionModal(`Shelf “${shelf.name}”`, null, [
        {
          label: "Export shelf as anthology…",
          desc: `Collect ${shelf.bookIds.length ? "its " + shelf.bookIds.length : "the"} work${shelf.bookIds.length === 1 ? "" : "s"}, in shelf order, into a single book with a table of contents.`,
          value: "anthology",
        },
        {
          label: "Delete shelf",
          desc: "Books move to another shelf. Nothing is deleted from disk.",
          danger: true,
          value: "del",
        },
      ]);
      if (choice === "anthology") {
        await exportShelfAnthology(shelf);
      } else if (choice === "del") {
        const mine = shelvesFor(currentAuthor().id);
        if (mine.length === 1) {
          toast(
            "This is your only shelf — add another before deleting this one",
          );
          return;
        }
        const other = mine.find((s) => s.id !== shelf.id);
        for (const id of shelf.bookIds) {
          if (!other.bookIds.includes(id)) other.bookIds.push(id);
        }
        library.shelves = library.shelves.filter((s) => s.id !== shelf.id);
        await window.neo.writeLibrary(library);
        renderShelves();
      }
    });
    const row = document.createElement("div");
    row.className = "shelf-books";
    row.dataset.shelfId = shelf.id;

    // drag targets: reorder within a shelf, move between shelves, or drop
    // manuscript files straight from Finder
    row.addEventListener("dragover", (e) => {
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        row.classList.add("drag-over");
        return;
      }
      if (!e.dataTransfer.types.includes("application/x-neo-book")) return;
      e.preventDefault();
      row.classList.add("drag-over");
      const ind = dropIndicator();
      let placed = false;
      for (const t of row.querySelectorAll(".book:not(.dragging)")) {
        const r = t.getBoundingClientRect();
        // cursor above this book's row, or on its row and left of center
        if (
          e.clientY < r.top ||
          (e.clientY < r.bottom && e.clientX < r.left + r.width / 2)
        ) {
          row.insertBefore(ind, t);
          placed = true;
          break;
        }
      }
      if (!placed) row.insertBefore(ind, row.querySelector(".new-book"));
    });
    row.addEventListener("dragleave", (e) => {
      if (row.contains(e.relatedTarget)) return;
      row.classList.remove("drag-over");
      const ind = document.querySelector(".drop-indicator");
      if (ind && ind.parentElement === row) ind.remove();
    });
    row.addEventListener("drop", async (e) => {
      row.classList.remove("drag-over");
      // files from Finder → import them right onto this shelf
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        const paths = [...e.dataTransfer.files]
          .map((f) => {
            try {
              return window.neo.pathForFile(f);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        if (!paths.length) return;
        toast("Importing…");
        const results = await window.neo.importFiles(paths);
        if (!results.length) {
          toast("No .docx, .txt, or .md files in that drop");
          return;
        }
        await addImportedBooks(results, shelf);
        return;
      }
      const bookId = e.dataTransfer.getData("application/x-neo-book");
      if (!bookId) return;
      e.preventDefault();
      // insertion index = how many (non-dragged) books sit before the indicator
      const ind = document.querySelector(".drop-indicator");
      let index = shelf.bookIds.filter((b) => b !== bookId).length;
      if (ind && ind.parentElement === row) {
        index = 0;
        for (const c of row.children) {
          if (c === ind) break;
          if (c.classList.contains("book") && !c.classList.contains("dragging"))
            index++;
        }
      }
      if (ind) ind.remove();
      for (const s of library.shelves)
        s.bookIds = s.bookIds.filter((b) => b !== bookId);
      shelf.bookIds.splice(index, 0, bookId);
      await window.neo.writeLibrary(library);
      // slide the tile into place; the shelf itself is not redrawn
      const tile = document.querySelector(`.book[data-book-id="${bookId}"]`);
      if (tile) {
        const others = [...row.querySelectorAll(".book")].filter(
          (b) => b !== tile,
        );
        row.insertBefore(tile, others[index] || row.querySelector(".new-book"));
        tile.classList.remove("dragging");
      } else renderShelves();
    });

    for (const bookId of shelf.bookIds) {
      const meta = await window.neo.readBookMeta(bookId);
      if (!meta) continue;
      row.appendChild(bookTile(meta));
    }

    // the blank page — click to begin
    const blank = document.createElement("div");
    blank.className = "new-book";
    blank.textContent = "+";
    blank.title = "Start a new book";
    blank.onclick = () => createBookOnShelf(shelf);
    row.appendChild(blank);

    sec.appendChild(label);
    sec.appendChild(row);
    built.appendChild(sec);
  }
  wrap.replaceChildren(built);
  view.scrollTop = keepScroll;
}

// single shared drop-position indicator for shelf drags
let _dropInd = null;
function dropIndicator() {
  if (!_dropInd) {
    _dropInd = document.createElement("div");
    _dropInd.className = "drop-indicator";
  }
  return _dropInd;
}

// Covers are two layers the shelf composites live: art (a seeded abstract,
// an image the writer chose, or one NEO painted from the text) and type.
// See covers.js. Painted art is read once and downsampled to tile size so
// forty books on a shelf cost about as much as forty small PNGs.
const artCache = new Map(); // bookId/file -> { url, canvas }

async function paintedArt(meta) {
  const art = meta.coverArt;
  if (!art || art.status !== "done" || !art.file) return null;
  const key = meta.id + "/" + art.file;
  if (artCache.has(key)) return artCache.get(key);
  try {
    const data = await window.neo.readCover(meta.id, art.file);
    if (!data) {
      window.neo.logError("painted cover missing on disk: " + key);
      return null;
    }
    const entry = await NeoCovers.fitImage(
      key,
      `data:${data.mime};base64,${data.base64}`,
    );
    if (!entry) {
      window.neo.logError("painted cover would not decode: " + key);
      return null;
    }
    artCache.set(key, entry);
    return entry;
  } catch (err) {
    window.neo.logError("painted cover: " + ((err && err.stack) || err));
    return null;
  }
}

// Which layers a book has to show, and which one is showing. Nothing is
// ever thrown away by switching: the writer's image, NEO's painting, and the
// abstract all stay available, and coverMode just picks one.
const hasPainting = (meta) =>
  !!(meta.coverArt && meta.coverArt.status === "done" && meta.coverArt.file);
function coverMode(meta) {
  const m = meta.coverMode;
  if (m === "image" && meta.coverImage) return "image";
  if (m === "painted" && hasPainting(meta)) return "painted";
  if (m === "abstract") return "abstract";
  return meta.coverImage ? "image" : hasPainting(meta) ? "painted" : "abstract";
}

function dressTile(el, meta) {
  el.classList.remove("has-cover");
  const mode = coverMode(meta);
  if (mode === "image") {
    el.classList.add("has-cover");
    el.style.background = `#1d1d1d url("${coverUrl(meta)}") center / cover no-repeat`;
    return;
  }
  el.classList.toggle(
    "cv-painting",
    !!(meta.coverArt && meta.coverArt.status === "pending"),
  );
  const token = (el._dressToken = (el._dressToken || 0) + 1);
  // a painting already decoded is drawn straight away; otherwise the
  // abstract shows instantly and the painting replaces it once read.
  // The tile may not be on the page yet when the art arrives, so the only
  // staleness check is whether this tile has been dressed again since.
  const cached =
    mode === "painted" && artCache.get(meta.id + "/" + meta.coverArt.file);
  NeoCovers.dress(el, NeoCovers.plan(meta, cached || undefined));
  if (mode !== "painted" || cached) return;
  paintedArt(meta).then((art) => {
    if (art && el._dressToken === token)
      NeoCovers.dress(el, NeoCovers.plan(meta, art));
  });
}

function bookTile(meta) {
  const el = document.createElement("div");
  el.className = "book";
  el.dataset.bookId = meta.id;
  el.draggable = true;
  el.innerHTML = `
    <div class="b-text"><div class="b-title"></div><div class="b-author"></div></div>
    <span class="b-refresh" title="New cover">&#8635;</span>
    <div class="b-painting" hidden></div>
    <div class="b-progress" hidden><div></div></div>`;
  el.querySelector(".b-author").textContent = meta.author || "";
  dressTile(el, meta);
  el.querySelector(".b-painting").hidden = !(
    meta.coverArt && meta.coverArt.status === "pending"
  );
  el.querySelector(".b-refresh").onclick = async (e) => {
    e.stopPropagation();
    await refreshCover(meta, el);
  };
  if (meta.wordGoal > 0) {
    const bar = el.querySelector(".b-progress");
    bar.hidden = false;
    const pct = Math.min(
      100,
      Math.round(((meta.wordCount || 0) / meta.wordGoal) * 100),
    );
    bar.firstElementChild.style.width = pct + "%";
  }
  el.title = meta.wordGoal
    ? `${meta.title} — ${(meta.wordCount || 0).toLocaleString()} / ${meta.wordGoal.toLocaleString()} words`
    : meta.title;
  el.onclick = () => openBook(meta.id);
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-neo-book", meta.id);
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  // images dragged from Finder onto a book become its cover;
  // manuscripts dropped here import onto this book's shelf
  el.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  el.addEventListener("drop", async (e) => {
    if (!e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    let p = null;
    try {
      p = window.neo.pathForFile(e.dataTransfer.files[0]);
    } catch {
      /* no path */
    }
    if (!p) return;
    if (/\.(png|jpe?g|webp)$/i.test(p)) {
      const fname = await window.neo.setCover(meta.id, p);
      if (fname) {
        meta.coverImage = fname;
        meta.coverMode = "image";
        await window.neo.writeBookMeta(meta.id, meta);
        renderShelves();
      }
    } else if (/\.(docx|txt|md)$/i.test(p)) {
      const homeShelf =
        library.shelves.find((s) => s.bookIds.includes(meta.id)) ||
        library.shelves[0];
      const results = await window.neo.importFiles([p]);
      if (results.length) await addImportedBooks(results, homeShelf);
    }
  });

  el.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    const options = [
      {
        label: meta.coverImage ? "Replace cover art…" : "Set cover art…",
        desc: "Pick an image (2:3 works best). Or just drag one from Finder onto the book.",
        value: "cover",
      },
    ];
    if (meta.coverImage) {
      options.push({
        label: "Remove cover art",
        desc: "Deletes the image from the book folder. (To just hide it, use the \u21bb on the book.)",
        danger: true,
        value: "uncover",
      });
    }
    options.push(
      {
        label: "Set word goal…",
        desc: "Adds the subtle progress bar to the cover.",
        value: "goal",
      },
      {
        label: "Remove from bookshelf",
        desc: "Takes it off your shelves. The files stay safe in your NEO Library folder on disk.",
        value: "remove",
      },
      {
        label: navigator.platform.toLowerCase().includes("win")
          ? "Move to Recycle Bin"
          : "Move to Trash",
        desc: "Sends the book folder to your system trash, where you can recover it.",
        danger: true,
        value: "trash",
      },
    );
    const choice = await optionModal(`“${meta.title}”`, null, options);
    if (choice === "cover") {
      const src = await window.neo.pickCover();
      if (!src) return;
      const fname = await window.neo.setCover(meta.id, src);
      if (fname) {
        meta.coverImage = fname;
        meta.coverMode = "image";
        await window.neo.writeBookMeta(meta.id, meta);
        renderShelves();
      }
    } else if (choice === "uncover") {
      await window.neo.removeCover(meta.id);
      meta.coverImage = null;
      await window.neo.writeBookMeta(meta.id, meta);
      renderShelves();
    } else if (choice === "goal") {
      const goal = await askInput(
        `Word count goal for “${meta.title}”`,
        "e.g. 80000 — blank removes the goal",
        meta.wordGoal ? String(meta.wordGoal) : "",
      );
      if (goal === null) return;
      meta.wordGoal = parseInt(goal, 10) || 0;
      await window.neo.writeBookMeta(meta.id, meta);
      renderShelves();
    } else if (choice === "remove") {
      for (const s of library.shelves)
        s.bookIds = s.bookIds.filter((b) => b !== meta.id);
      await window.neo.writeLibrary(library);
      renderShelves();
      toast(
        `“${meta.title}” removed from the shelves — its files are still in your NEO Library`,
      );
    } else if (choice === "trash") {
      const ok = await window.neo.deleteBook(meta.id, meta.title);
      if (ok) {
        for (const s of library.shelves)
          s.bookIds = s.bookIds.filter((b) => b !== meta.id);
        await window.neo.writeLibrary(library);
        renderShelves();
      }
    }
  });
  return el;
}

/* ---- painted covers ----
   At a thousand words a story has a shape, so NEO reads it and paints an
   abstract cover to sit under the type. The writer's own cover (coverImage)
   always wins; the abstract is the fallback; painting never blocks typing. */

const PAINT_AT = 1000;
const STALE_PAINT_MS = 10 * 60 * 1000; // a job that never came back

function paintable(meta) {
  if (!meta || meta.coverImage) return false; // the writer's own art is never painted over
  if ((meta.wordCount || 0) < PAINT_AT) return false;
  const art = meta.coverArt;
  if (!art) return true;
  if (art.status === "pending")
    return Date.now() - Date.parse(art.at || 0) > STALE_PAINT_MS;
  return false; // done, shelved, or failed: the ↻ on the tile is the way back in
}

function bookPlainText() {
  return book.chapterOrder.map((id) => chapterText(id)).join("\n\n");
}

// Paint the open book, or a book on the shelf (text is read from disk then).
async function requestPaint(meta, text) {
  const provider = coverProvider();
  if (!(await window.neo.hasSecret(provider))) {
    if (!library.coverArtNudged) {
      library.coverArtNudged = true;
      await window.neo.writeLibrary(library);
      toast(
        "This story just passed 1,000 words \u2014 add an API key under File \u2192 Cover Art\u2026 and NEO will paint it a cover.",
        8000,
      );
    }
    return;
  }
  meta.coverArt = {
    status: "pending",
    at: new Date().toISOString(),
    words: meta.wordCount || 0,
  };
  if (book && book.id === meta.id) scheduleMetaSave();
  else await window.neo.writeBookMeta(meta.id, meta);
  markPainting(meta.id, true);
  if (text == null) {
    const m = await window.neo.readBookMeta(meta.id);
    const parts = [];
    for (const chId of (m && m.chapterOrder) || []) {
      const holder = document.createElement("div");
      holder.innerHTML = await window.neo.readChapter(meta.id, chId);
      holder
        .querySelectorAll(".darling-anchor, .ph-mark, .ghost")
        .forEach((n) => n.remove());
      parts.push(holder.innerText);
    }
    text = parts.join("\n\n");
  }
  const cs = coverSettings();
  const mine = (cs.models && cs.models[provider]) || {};
  let res = null;
  try {
    res = await window.neo.paintCover(meta.id, text, {
      provider,
      textModel: mine.text,
      imageModel: mine.image,
      quality: cs.quality,
    });
  } catch (err) {
    window.neo.logError("paint request: " + ((err && err.stack) || err));
    res = { error: String((err && err.message) || err) };
  }
  // the writer may have moved on — write to whichever copy of the meta is live
  const live =
    book && book.id === meta.id
      ? book
      : (await window.neo.readBookMeta(meta.id)) || meta;
  if (res && res.file) {
    live.coverArt = {
      status: "done",
      file: res.file,
      brief: res.brief,
      words: meta.wordCount || 0,
      at: new Date().toISOString(),
    };
    if (!live.coverImage) live.coverMode = "painted";
    artCache.delete(meta.id + "/" + res.file);
  } else {
    live.coverArt = {
      status: "failed",
      error: (res && res.error) || "unknown",
      at: new Date().toISOString(),
    };
    toast("NEO couldn\u2019t paint that cover: " + live.coverArt.error, 7000);
  }
  if (live === book) scheduleMetaSave();
  else await window.neo.writeBookMeta(meta.id, live);
  markPainting(meta.id, false);
  if (!$("#bookshelf-view").hidden) renderShelves();
}

// shimmer on the tile while its painting is in flight
function markPainting(bookId, on) {
  for (const el of $$(".book")) {
    if (el.dataset.bookId !== bookId) continue;
    el.classList.toggle("cv-painting", on);
    const sh = el.querySelector(".b-painting");
    if (sh) sh.hidden = !on;
  }
}

// the ↻ on a tile: switch between the covers a book has, re-roll the
// abstract, or paint a fresh one from the text
async function refreshCover(meta, el) {
  const mode = coverMode(meta);
  const enough = (meta.wordCount || 0) >= PAINT_AT;
  const hasKey = await window.neo.hasSecret(coverProvider());
  const options = [];
  if (meta.coverImage && mode !== "image")
    options.push({
      label: "Show your cover art",
      desc: "The image you gave this book.",
      value: "image",
    });
  if (hasPainting(meta) && mode !== "painted")
    options.push({
      label: "Show NEO\u2019s painting",
      desc: "The cover painted from the text.",
      value: "painted",
    });
  if (mode !== "abstract")
    options.push({
      label: "Show the abstract",
      desc: "The seeded cover every book starts with.",
      value: "abstract",
    });
  options.push({
    label: "New type & colours",
    desc:
      mode === "abstract"
        ? "A fresh abstract and a different title style."
        : "Re-sets the title in a different style over the same art.",
    value: "reroll",
  });
  if (hasKey) {
    options.push(
      enough
        ? {
            label: hasPainting(meta)
              ? "Paint it again"
              : "Paint a cover from the text",
            desc: "NEO reads the manuscript and paints a new cover. About a minute; a few cents.",
            value: "paint",
          }
        : {
            label: "Paint a cover from the text",
            desc: `Once the story passes ${PAINT_AT.toLocaleString()} words.`,
            value: "nope",
          },
    );
  }
  // a plain abstract with nothing else to offer just re-rolls
  const choice =
    options.length === 1
      ? "reroll"
      : await optionModal(
          `Cover for \u201c${escHtml(meta.title)}\u201d`,
          null,
          options,
        );
  if (!choice || choice === "nope") return;
  const live = book && book.id === meta.id ? book : meta;
  if (choice === "paint") {
    if (
      meta.coverArt &&
      meta.coverArt.status === "pending" &&
      !paintable(meta)
    ) {
      toast("Still painting\u2026");
      return;
    }
    live.coverMode = "painted";
    requestPaint(live, book && book.id === meta.id ? bookPlainText() : null);
    return;
  }
  if (choice === "reroll") {
    live.coverSeed =
      meta.id + ":" + (meta.wordCount || 0) + ":" + Date.now().toString(36);
    if (mode === "image") live.coverMode = "abstract";
  } else {
    live.coverMode = choice;
  }
  if (live === book) scheduleMetaSave();
  else await window.neo.writeBookMeta(meta.id, live);
  dressTile(el, live);
}

async function createBookOnShelf(shelf) {
  const meta = await window.neo.createBook({ author: displayAuthor() });
  meta.tabNames = {
    notes: (library.tabDefaults && library.tabDefaults.notes) || "Notes",
    outline: (library.tabDefaults && library.tabDefaults.outline) || "Outline",
  };
  await window.neo.writeBookMeta(meta.id, meta);
  shelf.bookIds.push(meta.id);
  await window.neo.writeLibrary(library);
  openBook(meta.id);
}

// While dragging a book or shelf, nearing the window's top or bottom edge
// scrolls the bookshelf — faster the deeper into the edge zone you push.
let shelfScrollDir = 0;
let shelfScrollRAF = null;
function shelfAutoScrollStep() {
  if (!shelfScrollDir) {
    shelfScrollRAF = null;
    return;
  }
  $("#bookshelf-view").scrollTop += shelfScrollDir;
  shelfScrollRAF = requestAnimationFrame(shelfAutoScrollStep);
}
{
  const view = $("#bookshelf-view");
  const EDGE = 90;
  view.addEventListener("dragover", (e) => {
    const h = window.innerHeight;
    if (e.clientY < EDGE) shelfScrollDir = -Math.ceil((EDGE - e.clientY) / 5);
    else if (e.clientY > h - EDGE)
      shelfScrollDir = Math.ceil((e.clientY - (h - EDGE)) / 5);
    else shelfScrollDir = 0;
    if (shelfScrollDir && !shelfScrollRAF)
      shelfScrollRAF = requestAnimationFrame(shelfAutoScrollStep);
  });
  view.addEventListener("drop", () => {
    shelfScrollDir = 0;
  });
  view.addEventListener("dragend", () => {
    shelfScrollDir = 0;
  });
  view.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) shelfScrollDir = 0;
  });
}

$("#add-shelf-btn").onclick = async () => {
  library.shelves.push({
    id: "shelf-" + Date.now().toString(36),
    name: "New Shelf",
    bookIds: [],
    authorId: currentAuthor().id,
  });
  await window.neo.writeLibrary(library);
  renderShelves();
};

$("#author-chip").onclick = async () => {
  const cur = currentAuthor();
  const opts = [];
  for (const a of library.authors) {
    if (a.id !== cur.id) {
      opts.push({
        label: "Write as " + a.name,
        desc: "Switch to this name’s shelves",
        value: "sw:" + a.id,
      });
    }
  }
  opts.push({ label: "Rename " + cur.name, value: "rename" });
  opts.push({
    label: "Add a pen name…",
    desc: "A separate set of shelves under another name",
    value: "add",
  });
  if (library.authors.length > 1) {
    opts.push({
      label: "Remove " + cur.name,
      desc: "These shelves and books move to your other name. Nothing is deleted from disk.",
      danger: true,
      value: "del",
    });
  }
  const pick = await optionModal("Writing as " + cur.name, null, opts);
  if (!pick) return;
  if (pick.startsWith("sw:")) {
    library.currentAuthorId = pick.slice(3);
  } else if (pick === "rename") {
    const name = await askInput(
      "Author name",
      "Shown on your title pages",
      cur.name,
    );
    if (name === null) return;
    cur.name = name || cur.name;
    library.authorName = library.authors[0].name; // legacy field follows the first name
    await window.neo.writeLibrary(library);
    const n = await syncBookAuthors(cur);
    if (n) toast(`Updated the author on ${n} book${n === 1 ? "" : "s"}`);
  } else if (pick === "add") {
    const name = await askInput(
      "New pen name",
      "Shown on that name’s title pages",
      "",
    );
    if (!name) return;
    const a = { id: "a-" + Date.now().toString(36), name };
    library.authors.push(a);
    library.currentAuthorId = a.id;
    library.shelves.push({
      id: "shelf-" + Date.now().toString(36),
      name: "Works in Progress",
      bookIds: [],
      authorId: a.id,
    });
  } else if (pick === "del") {
    const homeId = library.authors[0].id;
    const rest = library.authors.filter((a) => a.id !== cur.id);
    const target = rest[0];
    for (const s of library.shelves) {
      if ((s.authorId || homeId) === cur.id) s.authorId = target.id;
    }
    library.authors = rest;
    library.currentAuthorId = target.id;
    library.authorName = library.authors[0].name;
    await window.neo.writeLibrary(library);
    await syncBookAuthors(target); // those books now carry the name they moved to
  }
  await window.neo.writeLibrary(library);
  renderShelves();
};
