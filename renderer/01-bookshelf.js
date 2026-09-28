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
  await NeoPlugins.reconcile();
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
    const shelfMenu = () => openShelfMenu(shelf);
    label.addEventListener("contextmenu", (event) => { event.preventDefault(); shelfMenu(); });
    const menuButton = document.createElement("button");
    menuButton.className = "shelf-menu btn-quiet";
    menuButton.textContent = "⋯";
    menuButton.title = `Manage shelf ${shelf.name}`;
    menuButton.setAttribute("aria-label", menuButton.title);
    menuButton.onclick = shelfMenu;
    sec.appendChild(menuButton);
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

// Preserve previously generated covers as ordinary saved images. New covers
// come from the seeded abstract or an image chosen by the writer.
const artCache = new Map(); // bookId/file -> decoded image

async function paintedArt(meta) {
  const art = meta.coverArt;
  if (!art || art.status !== "done" || !art.file) return null;
  const key = meta.id + "/" + art.file;
  if (artCache.has(key)) return artCache.get(key);
  try {
    const data = await window.neo.readCover(meta.id, art.file);
    if (!data) {
      window.neo.logError("saved cover missing on disk: " + key);
      return null;
    }
    const entry = await NeoCovers.fitImage(
      key,
      `data:${data.mime};base64,${data.base64}`,
    );
    if (!entry) {
      window.neo.logError("saved cover would not decode: " + key);
      return null;
    }
    artCache.set(key, entry);
    return entry;
  } catch (err) {
    window.neo.logError("saved cover: " + ((err && err.stack) || err));
    return null;
  }
}

// Keep existing saved covers available when switching between them, a
// writer-supplied image, and the abstract.
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
  const token = (el._dressToken = (el._dressToken || 0) + 1);
  // A saved image already decoded is drawn straight away; otherwise the
  // abstract shows instantly and the saved image replaces it once read.
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
    <div class="b-progress" hidden><div></div></div>`;
  el.querySelector(".b-author").textContent = meta.author || "";
  dressTile(el, meta);
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
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-neo-book', meta.id);
    // the ghost that rides under the cursor is a faded, smaller cover, held
    // by its top-left corner so it never sits on top of a drop target's label
    el.style.opacity = '0.45';
    el.style.transform = 'scale(0.7)';
    e.dataTransfer.setDragImage(el, 12, 12);
    setTimeout(() => { el.style.opacity = ''; el.style.transform = ''; el.classList.add('dragging'); }, 0);
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
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
        label: "Move to another author…",
        desc: "Move this book to another pen name and update its author.",
        value: "move-author",
      },
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
    if (choice === "move-author") {
      await chooseBookAuthor(meta.id);
    } else if (choice === "cover") {
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

// The ↻ on a tile switches saved covers or re-rolls the abstract and type.
async function refreshCover(meta, el) {
  const mode = coverMode(meta);
  const options = [];
  if (meta.coverImage && mode !== "image")
    options.push({
      label: "Show your cover art",
      desc: "The image you gave this book.",
      value: "image",
    });
  if (hasPainting(meta) && mode !== "painted")
    options.push({
      label: "Show saved cover",
      desc: "An image already saved with this book.",
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
  // a plain abstract with nothing else to offer just re-rolls
  const choice =
    options.length === 1
      ? "reroll"
      : await optionModal(
          `Cover for \u201c${escHtml(meta.title)}\u201d`,
          null,
          options,
        );
  if (!choice) return;
  const live = book && book.id === meta.id ? book : meta;
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
  meta.language = NeoLanguage.defaultManuscriptLanguage(library);
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


let lastShelfMove = null;

// Shelf membership is the single source of book ownership. No files move.
async function moveBookToAuthor(bookId, authorId, shelfId) {
  const author = library.authors.find((item) => item.id === authorId);
  if (!author) throw new Error("Author no longer exists");
  let destination = shelfId ? shelvesFor(authorId).find((item) => item.id === shelfId) : shelvesFor(authorId)[0];
  if (shelfId && !destination) throw new Error("Destination shelf no longer exists");
  const meta = await window.neo.readBookMeta(bookId);
  if (!meta) throw new Error("Book no longer exists");
  const previous = structuredClone(library.shelves);
  const from = library.shelves.find(s => s.bookIds.includes(bookId));
  const move = { bookId, title: meta.title, author: meta.author, shelfId: from?.id || null, index: from ? from.bookIds.indexOf(bookId) : 0, authorId: ownerOfBook(bookId)?.id || currentAuthor().id, at: Date.now() };
  if (!destination) {
    destination = { id: "shelf-" + crypto.randomUUID(), name: "Works in Progress", authorId, bookIds: [] };
    library.shelves.push(destination);
  }
  for (const shelf of library.shelves) shelf.bookIds = shelf.bookIds.filter((id) => id !== bookId);
  destination.bookIds.unshift(bookId);
  try { await window.neo.writeLibrary(library); }
  catch (err) { library.shelves = previous; throw err; }
  // Persist ownership first; startup can repair the display name if this write fails.
  meta.author = author.name;
  await window.neo.writeBookMeta(bookId, meta);
  await renderShelves();
  lastShelfMove = move;
  toast(`Moved “${meta.title}” to ${author.name} — Esc puts it back`, 6000);
}

async function chooseBookAuthor(bookId) {
  const owner = ownerOfBook(bookId);
  const authors = library.authors.filter((a) => a.id !== owner?.id);
  if (!authors.length) { toast("Add another pen name from the author menu first"); return; }
  const authorId = await optionModal("Move book to author", null, authors.map((a) => ({ label: escHtml(a.name), value: a.id })));
  if (!authorId) return;
  const shelves = shelvesFor(authorId);
  let shelfId = shelves[0]?.id;
  if (shelves.length > 1) {
    shelfId = await optionModal("Choose destination shelf", null, shelves.map((s) => ({ label: escHtml(s.name), value: s.id })));
    if (!shelfId) return;
  }
  try { await moveBookToAuthor(bookId, authorId, shelfId); }
  catch (err) { toast(`Could not finish moving the book: ${err.message}`); }
}

async function deleteShelf(shelfId, destinationId) {
  const shelf = library.shelves.find((item) => item.id === shelfId);
  if (!shelf) return;
  const ownerId = shelf.authorId || library.authors[0].id;
  const previous = structuredClone(library.shelves);
  let destination = shelvesFor(ownerId).find((item) => item.id !== shelfId && item.id === destinationId);
  if (destinationId && !destination) throw new Error("Destination shelf no longer exists");
  if (shelf.bookIds.length && !destination) {
    destination = { id: "shelf-" + crypto.randomUUID(), name: "Unsorted", authorId: ownerId, bookIds: [] };
    library.shelves.push(destination);
  }
  if (destination) for (const id of shelf.bookIds) if (!destination.bookIds.includes(id)) destination.bookIds.push(id);
  library.shelves = library.shelves.filter((item) => item.id !== shelfId);
  try { await window.neo.writeLibrary(library); }
  catch (err) { library.shelves = previous; throw err; }
  await renderShelves();
  toast(destination ? `Shelf deleted. Books moved to “${destination.name}”.` : "Empty shelf deleted");
}

async function openShelfMenu(shelf) {
  const choice = await optionModal(`Shelf “${escHtml(shelf.name)}”`, null, [
    { label: "Export shelf as anthology…", value: "anthology" },
    { label: "Delete shelf", desc: "Keep all books. Choose another shelf, or move them to Unsorted.", value: "delete" }
  ]);
  if (choice === "anthology") { await exportShelfAnthology(shelf); return; }
  if (choice !== "delete") return;
  let destinationId;
  if (shelf.bookIds.length) {
    const others = shelvesFor(shelf.authorId || library.authors[0].id).filter((item) => item.id !== shelf.id);
    destinationId = await optionModal("Keep these books on…", null, [
      ...others.map((item) => ({ label: escHtml(item.name), value: item.id })),
      { label: "A new Unsorted shelf", value: "__new__" }
    ]);
    if (!destinationId) return;
  }
  try { await deleteShelf(shelf.id, destinationId === "__new__" ? undefined : destinationId); }
  catch (err) { toast(`Could not delete the shelf: ${err.message}`); }
}

// Drag a book up to your name: if you write under other names too, a little
// rack of shelves unfolds beneath it, one per pen name, and the book can be
// dropped onto one. It lands on that name's top shelf and takes the name.
// With a single author there is nothing to unfold, so nothing happens.
(() => {
  const chip = $('#author-chip');
  let rack = null;
  let hideTimer = null;
  const otherAuthors = () => (library.authors || []).filter((a) => a.id !== currentAuthor().id);
  const isBookDrag = (e) => e.dataTransfer && e.dataTransfer.types.includes('application/x-neo-book');

  function showRack() {
    if (rack) return;
    const others = otherAuthors();
    if (!others.length) return;
    rack = document.createElement('div');
    rack.id = 'pen-rack';
    for (const a of others) {
      const slot = document.createElement('div');
      slot.className = 'pen-slot';
      slot.textContent = a.name;
      slot.dataset.authorId = a.id;
      slot.addEventListener('dragover', (e) => {
        if (!isBookDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        slot.classList.add('over');
        clearTimeout(hideTimer);
      });
      slot.addEventListener('dragleave', () => slot.classList.remove('over'));
      slot.addEventListener('drop', async (e) => {
        if (!isBookDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const bookId = e.dataTransfer.getData('application/x-neo-book');
        hideRack();
        await moveBookToAuthor(bookId, a.id);
      });
      rack.appendChild(slot);
    }
    const r = chip.getBoundingClientRect();
    rack.style.top = (r.bottom + 8) + 'px';
    // the rack hangs from the name and reaches leftward, so the names on its
    // planks sit well clear of the cover riding under the cursor
    rack.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
    document.body.appendChild(rack);
    requestAnimationFrame(() => rack.classList.add('open'));
  }
  function hideRack() {
    clearTimeout(hideTimer);
    if (rack) { rack.remove(); rack = null; }
  }
  const armHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hideRack, 400); };

  chip.addEventListener('dragenter', (e) => { if (isBookDrag(e)) { e.preventDefault(); showRack(); } });
  chip.addEventListener('dragover', (e) => { if (isBookDrag(e)) { e.preventDefault(); clearTimeout(hideTimer); } });
  chip.addEventListener('dragleave', armHide);
  document.addEventListener('dragover', (e) => {
    // leaving both the chip and the rack lets the rack fold away
    if (rack && !rack.contains(e.target) && e.target !== chip) armHide();
  });
  document.addEventListener('dragend', hideRack);
  document.addEventListener('drop', hideRack);
})();


async function undoShelfMove() {
  const m = lastShelfMove;
  if (!m || Date.now() - m.at > 15000) return false;
  lastShelfMove = null;
  const home = library.shelves.find((s) => s.id === m.shelfId) || shelvesFor(m.authorId)[0] || library.shelves[0];
  for (const s of library.shelves) s.bookIds = s.bookIds.filter((b) => b !== m.bookId);
  home.bookIds.splice(Math.min(m.index, home.bookIds.length), 0, m.bookId);
  const meta = await window.neo.readBookMeta(m.bookId);
  if (meta) { meta.author = m.author; await window.neo.writeBookMeta(m.bookId, meta); }
  await window.neo.writeLibrary(library);
  renderShelves();
  toast(`“${m.title}” is back where it was`);
  return true;
}
document.addEventListener('keydown', (e) => {
  if (!$('#editor-view').hidden || !lastShelfMove) return;
  const undoKey = e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z');
  if (!undoKey) return;
  if (document.querySelector('.modal-backdrop:not([hidden])')) return;
  e.preventDefault();
  e.stopPropagation();
  undoShelfMove();
}, true);

// File → Reshelve a Book…: a book taken off the shelves is still on disk;
// this puts it back, on the current name's first shelf
async function reshelveBook() {
  const all = await window.neo.listBooks();
  const shelved = new Set(library.shelves.flatMap((s) => s.bookIds));
  const loose = all.filter((b) => !shelved.has(b.id)).sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  if (!loose.length) { toast('Every book in your library is already on a shelf'); return; }
  const pick = await optionModal('Books in your library that aren’t on a shelf', null,
    loose.map((b) => ({ label: escHtml(b.title), desc: b.author ? 'by ' + escHtml(b.author) : '', value: b.id })));
  if (!pick) return;
  const shelf = shelvesFor(currentAuthor().id)[0] || library.shelves[0];
  shelf.bookIds.push(pick);
  await window.neo.writeLibrary(library);
  renderShelves();
  toast(`“${loose.find((b) => b.id === pick).title}” is back on the shelf`);
}
