/* =============================== NEO =============================== */

"use strict";

// ---------- state ----------
let library = null; // library.json
let book = null; // current book.json
let chapterHTML = {}; // chapterId -> html (loaded at open)
let stickies = []; // [{id, chapterId, text, resolved}]
let darlings = []; // [{id, html, text, chapterId, chapterLabel, date}]
let noteCards = []; // per-book cards supplied by the Note Cards plugin
let currentTab = "manuscript";
let currentChapterId = null; // chapter the caret/scroll is in
let wordMode = "book"; // 'book' | 'chapter'
let saveTimers = {};
let dirtyChapters = new Set();
let metaSavePending = false;
let lastSavedAt = null;
let lastCheckpointAt = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Platform-aware key labels: Macs read ⌘⇧X, everyone else reads Ctrl+Shift+X
const IS_MAC = navigator.platform.toLowerCase().includes("mac");
const K = (mac, pc) => (IS_MAC ? mac : pc);
const KZ = K("⌘Z", "Ctrl+Z");
const KPH = K("⌘⇧X", "Ctrl+Shift+X");
const KDA = K("⌘⇧D", "Ctrl+Shift+D");
const KHELP = K("⌘/", "Ctrl+/");

// Scrollbars stay invisible until you scroll, then fade away again —
// chrome only when needed.
document.addEventListener(
  "scroll",
  (e) => {
    const el = e.target;
    if (!el || !el.classList) return;
    el.classList.add("show-scrollbar");
    clearTimeout(el._neoSbHide);
    el._neoSbHide = setTimeout(
      () => el.classList.remove("show-scrollbar"),
      750,
    );
  },
  true,
);

function askInput(title, placeholder, value = "") {
  return new Promise((resolve) => {
    const bd = document.createElement("div");
    bd.className = "modal-backdrop";
    bd.innerHTML = `
      <div class="modal" style="width:380px">
        <h2 style="font-size:16px">${title}</h2>
        <input type="text" spellcheck="false" placeholder="${placeholder}" />
        <div style="text-align:right;margin-top:14px">
          <button class="m-cancel btn-quiet" style="margin-right:10px">Cancel</button>
          <button class="m-ok btn-gold">OK</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    const input = bd.querySelector("input");
    input.value = value;
    input.focus();
    input.select();
    const done = (val) => {
      bd.remove();
      resolve(val);
    };
    bd.querySelector(".m-ok").onclick = () => done(input.value.trim());
    bd.querySelector(".m-cancel").onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") done(input.value.trim());
      if (e.key === "Escape") done(null);
    };
  });
}

// A list of choices, null on cancel.
function optionModal(title, message, options) {
  return new Promise((resolve) => {
    const bd = document.createElement("div");
    bd.className = "modal-backdrop";
    const buttons = options
      .map(
        (o, i) =>
          `<button class="fr-choice" data-i="${i}" style="width:100%;margin-bottom:8px;${o.danger ? "border-color:#6b3a34" : ""}">
        <strong${o.danger ? ' style="color:#d97b6c"' : ""}>${o.label}</strong>
        ${o.desc ? `<span>${o.desc}</span>` : ""}
      </button>`,
      )
      .join("");
    bd.innerHTML = `
      <div class="modal" style="width:420px">
        <h2 style="font-size:16px">${title}</h2>
        ${message ? `<p>${message}</p>` : ""}
        ${buttons}
        <div style="text-align:right;margin-top:6px">
          <button class="m-cancel btn-quiet">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    const done = (val) => {
      bd.remove();
      resolve(val);
    };
    bd.querySelectorAll(".fr-choice").forEach((b) => {
      b.onclick = () => done(options[+b.dataset.i].value);
    });
    bd.querySelector(".m-cancel").onclick = () => done(null);
    bd.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      }
    });
  });
}

function toast(msg, ms = 4000) {
  const h = $("#hint");
  h.textContent = msg;
  h.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    h.hidden = true;
  }, ms);
}

// Words, the way each script counts them: Chinese and Japanese characters
// count one each (those scripts don't put spaces between words); everything
// else counts by whitespace-separated runs, as before.
// (CJK counting adapted from hughhowey/neo#27 by jqlong17.)
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const countWords = (text) => {
  const s = String(text || "");
  const cjk = s.match(CJK_CHAR);
  if (!cjk) return (s.trim().match(/\S+/g) || []).length;
  const rest = s.replace(CJK_CHAR, " ").replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
  return cjk.length + (rest ? rest.split(" ").length : 0);
};

function cleanChapterEl(id) {
  const el = document.querySelector(`.chapter[data-id="${id}"] .chapter-body`);
  const holder = document.createElement("div");
  holder.innerHTML = el ? el.innerHTML : chapterHTML[id] || "";
  holder
    .querySelectorAll(".darling-anchor, .ph-mark, .ghost")
    .forEach((n) => n.remove());
  return holder;
}
const chapterText = (id) => cleanChapterEl(id).innerText;

// Word counts are cached per chapter and only recomputed for the chapter being edited.
let wordCache = {};
function chapterWords(chId) {
  if (wordCache[chId] == null) wordCache[chId] = countWords(chapterText(chId));
  return wordCache[chId];
}

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

// Plugins belong to an author, rather than to a computer or an individual
// book. A writer can keep a spare pen name deliberately uncluttered, while
// every book under an enabled pen name gets the same tools.
const PLUGINS = {
  palette: { name: "Palette themes", icon: "◐", kind: "Personalization", description: "Give this author a distinct writing-room palette.", status: "Ready" },
  storyMap: { name: "Story Map", icon: "↗", kind: "Planning", description: "Map each chapter’s act, story beat, thread, and progress beside the working outline.", status: "Ready" },
  sprints: { name: "Writing Sprints", icon: "⚡", kind: "Writing tool", description: "Race a timer or a word count, NaNoWriMo-style. Start one from Progress & Settings; the word counter becomes the countdown.", status: "Ready" },
  noteCards: { name: "Note cards", icon: "▤", kind: "Writing tool", description: "Keep research, character, and scene cards with each book.", status: "Ready" },
  github: { name: "GitHub backup", icon: "⌘", kind: "Backup", description: "Keep an automatic, private backup of your entire NEO Library on GitHub.", status: "Ready" }
};
const PALETTE_PRESETS = {
  classic: { name: "Classic gold", bg: "#191919", bgSoft: "#222222", pane: "#202020", paper: "#fbfaf7", ink: "#1c1c1c", accent: "#c9a86a", muted: "#8a8a8a", paperMuted: "#665f54", paperFaint: "#b9b4a8", uiText: "#dddddd", uiTextSoft: "#aaaaaa", line: "#3a3a3a", lineStrong: "#4a4a4a", surface: "#222222", surfaceRaised: "#2a2a26", danger: "#c0392b", dangerMuted: "#9d4d42", resolved: "#625d52", onAccent: "#191919", nightPaper: "#232221", nightInk: "#d6d2c6", nightMuted: "#918b7d", nightFaint: "#5f5b52" },
  ink: { name: "Ink blue", bg: "#151d29", bgSoft: "#1d2838", pane: "#172230", paper: "#eef4fa", ink: "#17263a", accent: "#4e8bc5", muted: "#9aafc5", paperMuted: "#52677d", paperFaint: "#aab9c8", uiText: "#e7eff8", uiTextSoft: "#b8c7d7", line: "#34485f", lineStrong: "#47627f", surface: "#1d2838", surfaceRaised: "#26364a", danger: "#d66d6b", dangerMuted: "#a95a62", resolved: "#667789", onAccent: "#ffffff", nightPaper: "#172331", nightInk: "#d9e7f4", nightMuted: "#91acc6", nightFaint: "#59718a" },
  moss: { name: "Moss green", bg: "#19201b", bgSoft: "#222b23", pane: "#1c261e", paper: "#f4f5ed", ink: "#263127", accent: "#819b4e", muted: "#a2ad94", paperMuted: "#5d6b57", paperFaint: "#b4baaa", uiText: "#e8eee3", uiTextSoft: "#bdc7b5", line: "#3c4b3d", lineStrong: "#536653", surface: "#222b23", surfaceRaised: "#2b372d", danger: "#c46c5f", dangerMuted: "#99544c", resolved: "#697463", onAccent: "#172013", nightPaper: "#202a21", nightInk: "#e0e7d8", nightMuted: "#a6b69b", nightFaint: "#64735f" }
};
const PALETTE_KEYS = ["bg", "bgSoft", "pane", "paper", "ink", "accent", "muted", "paperMuted", "paperFaint", "uiText", "uiTextSoft", "line", "lineStrong", "surface", "surfaceRaised", "danger", "dangerMuted", "resolved", "onAccent", "nightPaper", "nightInk", "nightMuted", "nightFaint"];
const PALETTE_CSS_VARS = { bg: "--bg", bgSoft: "--bg-soft", pane: "--pane", paper: "--paper", ink: "--ink", accent: "--accent", muted: "--muted", paperMuted: "--paper-muted", paperFaint: "--paper-faint", uiText: "--ui-text", uiTextSoft: "--ui-text-soft", line: "--line", lineStrong: "--line-strong", surface: "--surface", surfaceRaised: "--surface-raised", danger: "--danger", dangerMuted: "--danger-muted", resolved: "--resolved", onAccent: "--on-accent", nightPaper: "--night-paper", nightInk: "--night-ink", nightMuted: "--night-muted", nightFaint: "--night-faint" };
function paletteFor(author) {
  const selected = author.pluginPalette || "classic";
  return PALETTE_PRESETS[selected] || (author.customPalettes || []).find((p) => p.id === selected) || PALETTE_PRESETS.classic;
}
function paletteMatches(a, b) {
  return PALETTE_KEYS.every((key) => (a[key] || PALETTE_PRESETS.classic[key]) === (b[key] || PALETTE_PRESETS.classic[key]));
}
function paletteWidget(author) {
  return `<div class="palette-widget"><button data-open-palette-studio class="palette-studio-link">Open Palette Studio →</button></div>`;
}
function paletteStudioGroup(title, description, keys, colors) {
  const labels = { bg: "Window background", bgSoft: "Dialog background", pane: "Side panes", surface: "Raised surfaces", surfaceRaised: "Active surfaces", uiText: "Primary interface text", uiTextSoft: "Secondary interface text", line: "Borders", lineStrong: "Strong borders", paper: "Page", ink: "Manuscript ink", paperMuted: "Page details", paperFaint: "Page placeholders", accent: "Primary action", onAccent: "Text on primary action", danger: "Flags & alerts", dangerMuted: "Alert hover", resolved: "Resolved notes", muted: "Quiet interface text", nightPaper: "Night page", nightInk: "Night manuscript ink", nightMuted: "Night page details", nightFaint: "Night placeholders" };
  return `<section class="palette-group"><div><h3>${title}</h3><p>${description}</p></div><div class="palette-color-grid">${keys.map((key) => `<label class="palette-swatch"><input type="color" data-palette-color="${key}" value="${colors[key] || PALETTE_PRESETS.classic[key]}"><span class="palette-swatch-dot" style="background:${colors[key] || PALETTE_PRESETS.classic[key]}"></span><span>${labels[key]}</span></label>`).join("")}</div></section>`;
}
function openPaletteStudio() {
  const author = currentAuthor();
  const colors = paletteFor(author);
  const selected = author.pluginPalette || "classic";
  const customOptions = (author.customPalettes || []).map((p) => `<option value="${p.id}" ${selected === p.id ? "selected" : ""}>${escHtml(p.name)}</option>`).join("");
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `<div class="modal palette-studio-screen"><div class="palette-studio-top"><button class="palette-back btn-quiet">← Plugin Library</button><button class="m-cancel btn-quiet" title="Close">×</button></div><div class="palette-studio-title"><h2>Palette Studio</h2><p>Every swatch has a job. Edit the writing room live, then save this combination as a custom palette.</p></div><div class="palette-studio-controls"><label><span>Active palette</span><select data-studio-palette><option value="classic" ${selected === "classic" ? "selected" : ""}>Classic gold</option><option value="ink" ${selected === "ink" ? "selected" : ""}>Ink blue</option><option value="moss" ${selected === "moss" ? "selected" : ""}>Moss green</option>${customOptions}</select></label><div class="palette-studio-actions"><button data-studio-reset class="palette-reset">Restore default palette</button><button data-delete-palette class="palette-delete" hidden>Delete custom palette</button></div></div><div class="palette-preview"><div class="palette-preview-chrome"><span>NEO</span><span class="preview-flag">● Flag</span></div><div class="palette-preview-pane">Chapters<br><strong>Chapter one</strong></div><div class="palette-preview-page"><small>CHAPTER ONE</small><h3>A page that feels like yours</h3><p>Manuscript ink, quiet details, and placeholders all respond to their own palette roles.</p><em>Write freely…</em><button>Primary action</button></div></div>${paletteStudioGroup("Writing page", "These colors control the paper itself in the normal page view.", ["paper", "ink", "paperMuted", "paperFaint"], colors)}${paletteStudioGroup("Night page", "These replace the page colors when View → Page → Night is active.", ["nightPaper", "nightInk", "nightMuted", "nightFaint"], colors)}${paletteStudioGroup("Writing room", "These paint the window, panes, dialogs, borders, and interface text.", ["bg", "bgSoft", "pane", "surface", "surfaceRaised", "uiText", "uiTextSoft", "muted", "line", "lineStrong"], colors)}${paletteStudioGroup("Signals & actions", "Shared colors for buttons, selection, flags, alerts, and resolved notes.", ["accent", "onAccent", "danger", "dangerMuted", "resolved"], colors)}<div class="palette-studio-save"><input data-palette-name placeholder="Name this custom palette" maxlength="36"><button data-save-palette class="btn-gold">Save custom palette</button></div></div>`;
  document.body.appendChild(bd);
  const close = () => { applyPluginAppearance(); bd.remove(); };
  bd.querySelector(".m-cancel").onclick = close;
  bd.querySelector(".palette-back").onclick = () => { close(); openPlugins(); };
  const preview = bd.querySelector(".palette-preview");
  let draftPalette = false;
  const picker = bd.querySelector("[data-studio-palette]");
  const markDraftPalette = () => {
    if (draftPalette || !["classic", "ink", "moss"].includes(picker.value)) return;
    picker.insertAdjacentHTML("beforeend", `<option value="__draft__">Custom (unsaved)</option>`);
    picker.value = "__draft__";
    draftPalette = true;
  };
  const deleteButton = bd.querySelector("[data-delete-palette]");
  const syncDeleteButton = () => {
    deleteButton.hidden = !picker.value.startsWith("custom-");
  };
  const previewVars = () => {
    const get = (key) => bd.querySelector(`[data-palette-color="${key}"]`).value;
    preview.style.setProperty("--preview-bg", get("bg")); preview.style.setProperty("--preview-pane", get("pane")); preview.style.setProperty("--preview-paper", get("paper")); preview.style.setProperty("--preview-ink", get("ink")); preview.style.setProperty("--preview-muted", get("paperMuted")); preview.style.setProperty("--preview-faint", get("paperFaint")); preview.style.setProperty("--preview-accent", get("accent")); preview.style.setProperty("--preview-on-accent", get("onAccent")); preview.style.setProperty("--preview-danger", get("danger"));
  };
  bd.querySelectorAll("[data-palette-color]").forEach((input) => {
    input.oninput = () => {
      markDraftPalette();
      const key = input.dataset.paletteColor;
      document.body.style.setProperty(PALETTE_CSS_VARS[key], input.value);
      const nightTarget = { nightPaper: "--paper", nightInk: "--ink", nightMuted: "--paper-muted", nightFaint: "--paper-faint" }[key];
      if (nightTarget && library.pageTheme === "night") document.body.style.setProperty(nightTarget, input.value);
      input.nextElementSibling.style.background = input.value;
      previewVars();
    };
  });
  previewVars();
  const syncStudioColors = (next) => {
    bd.querySelectorAll("[data-palette-color]").forEach((input) => {
      input.value = next[input.dataset.paletteColor] || PALETTE_PRESETS.classic[input.dataset.paletteColor];
      input.nextElementSibling.style.background = input.value;
    });
    previewVars();
  };
  picker.onchange = async (e) => {
    draftPalette = false;
    picker.querySelector('[value="__draft__"]')?.remove();
    author.pluginPalette = e.target.value;
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    syncStudioColors(paletteFor(author));
    syncDeleteButton();
  };
  bd.querySelector("[data-studio-reset]").onclick = async () => {
    author.pluginPalette = "classic";
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    draftPalette = false;
    picker.querySelector('[value="__draft__"]')?.remove();
    picker.value = "classic";
    syncStudioColors(PALETTE_PRESETS.classic);
    syncDeleteButton();
    toast("Returned to NEO’s default colors");
  };
  deleteButton.onclick = async () => {
    const id = picker.value;
    const removed = (author.customPalettes || []).find((p) => p.id === id);
    if (!removed) return;
    author.customPalettes = author.customPalettes.filter((p) => p.id !== id);
    author.pluginPalette = "classic";
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    picker.querySelector(`[value="${id}"]`)?.remove();
    picker.value = "classic";
    syncStudioColors(PALETTE_PRESETS.classic);
    syncDeleteButton();
    toast(`Deleted “${removed.name || "custom palette"}”`);
  };
  syncDeleteButton();
  bd.querySelector("[data-save-palette]").onclick = async () => {
    const name = bd.querySelector("[data-palette-name]").value.trim() || "Custom palette";
    const saved = {};
    bd.querySelectorAll("[data-palette-color]").forEach((input) => { saved[input.dataset.paletteColor] = input.value; });
    const id = "custom-" + Date.now().toString(36);
    const builtInMatch = Object.entries(PALETTE_PRESETS).find(([, preset]) => paletteMatches(saved, preset));
    const customMatch = (author.customPalettes || []).find((preset) => paletteMatches(saved, preset));
    const matchingId = builtInMatch ? builtInMatch[0] : customMatch?.id;
    if (matchingId) {
      author.pluginPalette = matchingId;
      await window.neo.writeLibrary(library);
      applyPluginAppearance();
      draftPalette = false;
      picker.querySelector('[value="__draft__"]')?.remove();
      picker.value = matchingId;
      syncStudioColors(paletteFor(author));
      syncDeleteButton();
      bd.querySelector("[data-palette-name]").value = "";
      toast("That palette already exists — kept the existing palette");
      return;
    }
    author.customPalettes = [...(author.customPalettes || []), { id, name, ...saved }];
    author.pluginPalette = id;
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    draftPalette = false;
    picker.querySelector('[value="__draft__"]')?.remove();
    picker.insertAdjacentHTML("beforeend", `<option value="${id}" selected>${escHtml(name)}</option>`);
    picker.value = id;
    syncDeleteButton();
    bd.querySelector("[data-palette-name]").value = "";
    toast(`Saved “${name}” for ${displayAuthor()}`);
  };
  bd.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
}
function authorPlugins() {
  const author = currentAuthor();
  author.plugins = Array.isArray(author.plugins) ? author.plugins : [];
  return author.plugins;
}
function pluginEnabled(id) { return authorPlugins().includes(id); }
function applyPluginAppearance() {
  const author = currentAuthor();
  const hasPalette = pluginEnabled("palette");
  const colors = hasPalette ? paletteFor(author) : PALETTE_PRESETS.classic;
  document.body.dataset.palette = hasPalette ? (author.pluginPalette || "classic") : "classic";
  PALETTE_KEYS.forEach((key) => {
    if (hasPalette) document.body.style.setProperty(PALETTE_CSS_VARS[key], colors[key] || PALETTE_PRESETS.classic[key]);
    else document.body.style.removeProperty(PALETTE_CSS_VARS[key]);
  });
  if (hasPalette && library.pageTheme === "night") {
    document.body.style.setProperty("--paper", colors.nightPaper || colors.pane);
    document.body.style.setProperty("--ink", colors.nightInk || colors.uiText);
    document.body.style.setProperty("--paper-muted", colors.nightMuted || colors.muted);
    document.body.style.setProperty("--paper-faint", colors.nightFaint || colors.lineStrong);
  }
  if (sprint && !pluginEnabled("sprints")) { endSprintQuietly(); if (book) updateCounters(); }
  const cardsTab = $('.tab[data-tab="cards"]');
  if (cardsTab) cardsTab.hidden = !pluginEnabled("noteCards");
  if (currentTab === "cards" && !pluginEnabled("noteCards")) switchTab("manuscript");
}
function openPlugins() {
  const author = currentAuthor();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `<div class="modal plugin-modal"><div class="plugin-modal-head"><div><h2>Plugin Library</h2><p>Tools installed for <strong>${escHtml(author.name || "Anonymous")}</strong>. They travel with this author, not just this device.</p></div><button class="m-cancel btn-quiet" title="Close">×</button></div><div class="plugin-grid">${Object.entries(PLUGINS).map(([id, p]) => `<section class="plugin-card ${pluginEnabled(id) ? "installed" : ""}"><div class="plugin-icon">${p.icon}</div><div class="plugin-copy"><div class="plugin-kicker">${p.kind} · ${p.status}</div><h3>${p.name}</h3><p>${p.description}</p>${id === "palette" && pluginEnabled(id) ? paletteWidget(author) : ""}</div>${p.status === "Ready" ? (id === "github" && pluginEnabled(id) ? `<div class="plugin-actions"><button data-github-settings class="btn-gold">Open Sync Settings</button><button data-plugin="${id}" class="btn-quiet">Uninstall</button></div>` : `<button data-plugin="${id}" class="${pluginEnabled(id) ? "btn-quiet" : "btn-gold"}">${pluginEnabled(id) ? "Uninstall" : "Install"}</button>`) : `<span class="plugin-soon">Coming soon</span>`}</section>`).join("")}</div><p class="plugin-foot">A plugin can add a page, format, or workflow without changing your manuscript files.</p></div>`;
  document.body.appendChild(bd);
  const close = () => { applyPluginAppearance(); bd.remove(); };
  bd.querySelector(".m-cancel").onclick = close;
  bd.querySelectorAll("[data-plugin]").forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.plugin;
    const installed = authorPlugins();
    const wasInstalled = installed.includes(id);
    if (wasInstalled) author.plugins = installed.filter((p) => p !== id);
    else installed.push(id);
    // Git backup covers the whole library, so removing the plugin must
    // actually stop it rather than just hiding the button.
    if (id === "github" && wasInstalled && library.history && library.history.git) {
      library.history.git = { ...library.history.git, enabled: false, autoPush: false };
    }
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    if (id === "storyMap" && currentTab === "outline") renderOutline();
    if (wasInstalled) {
      const card = btn.closest(".plugin-card");
      card.classList.remove("installed");
      card.querySelector(".palette-widget")?.remove();
      btn.textContent = "Install";
      btn.className = "btn-gold";
      toast(`${PLUGINS[id].name} removed for ${displayAuthor()}`);
      return;
    }
    close();
    if (id === "github") openSyncSettings();
    toast(`${PLUGINS[id].name} installed for ${displayAuthor()}`);
  });
  bd.querySelector("[data-github-settings]")?.addEventListener("click", () => {
    close();
    openSyncSettings();
  });
  const picker = bd.querySelector("[data-palette]");
  if (picker) picker.onchange = async () => {
    author.pluginPalette = picker.value;
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    const colors = paletteFor(author);
    bd.querySelectorAll("[data-palette-color]").forEach((input) => {
      input.value = colors[input.dataset.paletteColor] || PALETTE_PRESETS.classic[input.dataset.paletteColor];
    });
  };
  bd.querySelector("[data-reset-palette]")?.addEventListener("click", async () => {
    author.pluginPalette = "classic";
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    picker.value = "classic";
    const colors = PALETTE_PRESETS.classic;
    bd.querySelectorAll("[data-palette-color]").forEach((input) => {
      input.value = colors[input.dataset.paletteColor];
    });
    toast("Returned to NEO’s default colors");
  });
  bd.querySelector("[data-open-palette-studio]")?.addEventListener("click", () => {
    close();
    openPaletteStudio();
  });
  bd.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
}
$("#plugins-btn").onclick = openPlugins;

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

/* ================================================================== */
/*  EDITOR — open / render                                             */
/* ================================================================== */

async function openBook(bookId) {
  tabPlaces = {}; // a fresh book starts with fresh places
  dirtyChapters = new Set();
  metaSavePending = false;
  book = await window.neo.readBookMeta(bookId);
  if (!book) return;
  currentChapterId = null; // never carry a chapter reference across books
  undoStack = [];
  chapterHTML = {};
  for (const chId of book.chapterOrder) {
    chapterHTML[chId] = await window.neo.readChapter(bookId, chId);
  }
  stickies = await window.neo.readJSON(bookId, "stickies", []);
  darlings = await window.neo.readJSON(bookId, "darlings", []);
  noteCards = await window.neo.readJSON(bookId, "note-cards", []);

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
  applyPluginAppearance();

  renderChapters();
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

/* ================================================================== */
/*  POETRY PARAGRAPHS — ⇧Enter                                         */
/*  A paragraph pulled in from the margins, italic: a stanza of verse,  */
/*  a quote, a POV name under the chapter heading. One class, one key.  */
/* ================================================================== */

// the paragraph holding the caret, if it belongs to this chapter body
function caretBlock(body) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let el = sel.anchorNode;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  const block = el && el.closest ? el.closest('p') : null;
  return block && body.contains(block) ? block : null;
}

// A poetry paragraph is born italic — real <i> markup, so ⌘I can take it
// off a word — and sheds that default italic when it returns to prose.
function italicize(p) {
  if (p.textContent.trim() === '') { p.innerHTML = '<i><br></i>'; return; }
  const kids = [...p.childNodes].filter((n) => !(n.nodeType === Node.TEXT_NODE && !n.textContent.trim()));
  if (kids.length === 1 && kids[0].nodeType === Node.ELEMENT_NODE && kids[0].tagName === 'I') return;
  const i = document.createElement('i');
  while (p.firstChild) i.appendChild(p.firstChild);
  p.appendChild(i);
}
function romanize(p) {
  const kids = [...p.childNodes].filter((n) => !(n.nodeType === Node.TEXT_NODE && !n.textContent.trim()));
  if (kids.length !== 1 || kids[0].nodeType !== Node.ELEMENT_NODE || kids[0].tagName !== 'I') return;
  const i = kids[0];
  while (i.firstChild) i.before(i.firstChild);
  i.remove();
  if (p.textContent.trim() === '' && !p.querySelector('br')) p.innerHTML = '<br>';
}
// caret at the start of a paragraph's text — inside its italic when it has one
function caretIntoStart(p) {
  const i = p.firstElementChild && p.firstElementChild.tagName === 'I' ? p.firstElementChild : p;
  placeCaret(i, 0);
}

function placeCaret(node, offset) {
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// ⇧Enter. At the end of a paragraph: a new poetry paragraph beneath it.
// Mid-paragraph: the text after the caret becomes one. Inside a poetry
// paragraph: another line of it, so verse flows. On a *** line: nothing.
function handlePoetry(e, body, chId) {
  if (e.key !== 'Enter' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const block = caretBlock(body);
  if (!block) return false;
  e.preventDefault();
  if (block.classList.contains('scene-break')) return true;

  if (block.classList.contains('poetry')) {
    // the engine's own split keeps the class on the new line, and ⌘Z sees it
    if (block.querySelector('span:not(.ph-mark)')) stripJunkSpans(block);
    document.execCommand('insertParagraph');
    const cur = caretBlock(body);
    if (cur) {
      cur.classList.add('poetry');
      if (cur.textContent.trim() === '' && !cur.querySelector('i')) { italicize(cur); caretIntoStart(cur); }
    }
    syncChapter(body, chId);
    return true;
  }

  snapshotStructure('poetry paragraph');
  const r = sel.getRangeAt(0);
  const tail = document.createRange();
  tail.selectNodeContents(block);
  try { tail.setStart(r.startContainer, r.startOffset); } catch { return true; }
  const after = tail.toString();
  const empty = block.textContent.trim() === '';
  const atStart = after.length === block.textContent.length;
  if (empty || atStart) {
    // an empty paragraph, or the caret at its very start: the whole paragraph turns to poetry
    block.classList.add('poetry');
    italicize(block);
    caretIntoStart(block);
  } else {
    const line = document.createElement('p');
    line.className = 'poetry';
    if (after.trim() !== '') {
      line.appendChild(tail.extractContents());
      for (const junk of line.querySelectorAll('br')) junk.remove();
      if (!block.textContent.trim()) block.innerHTML = '<br>';
    }
    italicize(line);
    block.after(line);
    caretIntoStart(line);
  }
  syncChapter(body, chId);
  resetNativeUndo();
  breakRun++;
  return true;
}

// Backspace at the very start of a poetry paragraph makes it prose again —
// the second Backspace then merges it upward like any paragraph
function poetryBackspace(e, body, chId) {
  if (e.key !== 'Backspace' || e.metaKey || e.ctrlKey || e.altKey) return false;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const block = caretBlock(body);
  if (!block || !block.classList.contains('poetry')) return false;
  const r = sel.getRangeAt(0);
  const head = document.createRange();
  head.selectNodeContents(block);
  try { head.setEnd(r.startContainer, r.startOffset); } catch { return false; }
  if (head.toString().length !== 0) return false;
  e.preventDefault();
  snapshotStructure('poetry paragraph to prose');
  block.classList.remove('poetry');
  romanize(block);
  placeCaret(block, 0);
  syncChapter(body, chId);
  resetNativeUndo();
  breakRun++;
  return true;
}

// Format → Poetry Paragraph: toggles every paragraph the selection touches
function togglePoetry() {
  const sel = window.getSelection();
  if (!sel.rangeCount) { toast('Click into a paragraph first'); return; }
  const r = sel.getRangeAt(0);
  let el = r.startContainer;
  if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  const body = el && el.closest ? el.closest('.chapter-body') : null;
  if (!body) { toast('Click into a paragraph first'); return; }
  const chId = body.closest('.chapter').dataset.id;
  const ps = [...body.querySelectorAll('p')].filter(
    (p) => r.intersectsNode(p) && !p.classList.contains('scene-break')
  );
  if (!ps.length) return;
  snapshotStructure('poetry paragraph');
  const on = !ps.every((p) => p.classList.contains('poetry'));
  for (const p of ps) {
    p.classList.toggle('poetry', on);
    if (on) italicize(p); else romanize(p);
  }
  caretIntoStart(ps[0]);
  syncChapter(body, chId);
  resetNativeUndo();
  breakRun++;
}

// ⇧Enter from the chapter title: a poetry paragraph above the opening one
function poetryUnderHeading(body, chId) {
  const line = document.createElement('p');
  line.className = 'poetry';
  italicize(line);
  snapshotStructure('poetry paragraph');
  body.prepend(line);
  body.focus();
  caretIntoStart(line);
  syncChapter(body, chId);
  resetNativeUndo();
  breakRun++;
}

// Backspace just below a *** (or Delete just above one) removes the break
// itself — prose never merges into the break's styled paragraph
function sceneBreakDelete(e, body, chId) {
  if (e.key !== "Backspace" && e.key !== "Delete") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  let el = r.startContainer;
  if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  const block = el && el.closest ? el.closest("p") : null;
  if (!block || !body.contains(block)) return false;
  const back = e.key === "Backspace";
  const edge = document.createRange();
  edge.selectNodeContents(block);
  try {
    if (back) edge.setEnd(r.startContainer, r.startOffset);
    else edge.setStart(r.startContainer, r.startOffset);
  } catch {
    return false;
  }
  if (edge.toString().length !== 0) return false; // caret isn't at the block's edge
  const target = back ? block.previousElementSibling : block.nextElementSibling;
  if (!target || !target.classList.contains("scene-break")) return false;
  e.preventDefault();
  snapshotStructure("section break removed");
  target.remove();
  syncChapter(body, chId);
  resetNativeUndo();
  breakRun++;
  return true;
}

// Read a body's HTML for saving:
function captureBody(body) {
  // chapter-opening and focus-current are rendering aids, not author content.
  const copy = body.cloneNode(true);
  copy.querySelectorAll("p.focus-current").forEach((p) => {
    p.classList.remove("focus-current");
    if (!p.classList.length) p.removeAttribute("class");
  });
  copy.querySelectorAll("p.chapter-opening").forEach((p) => {
    p.classList.remove("chapter-opening", "has-leading-quote");
    p.querySelectorAll("span.dropcap-letter, span.opening-quote").forEach(
      (span) => {
        span.replaceWith(...span.childNodes);
      },
    );
  });
  copy.querySelectorAll('p[class=""]').forEach((p) => p.removeAttribute("class"));
  return copy.innerHTML;
}

function syncChapter(body, chId) {
  refreshChapterOpening(body); // poetry toggles can move the chapter's opening paragraph
  chapterHTML[chId] = captureBody(body);
  wordCache[chId] = null;
  scheduleChapterSave(chId);
  updateCounters();
  scheduleNavRefresh();
}

// Heal text-node fragmentation in each paragraph as the caret leaves it:
let lastCaretPara = null;
let menuPoetryState = false;
document.addEventListener('selectionchange', () => {
  if (!book || currentTab !== 'manuscript') return;
  const sel = window.getSelection();
  let caretP = null;
  if (sel && sel.rangeCount) {
    let el = sel.anchorNode;
    if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    const p = el && el.closest ? el.closest("p") : null;
    if (
      p &&
      p.parentElement &&
      p.parentElement.classList.contains("chapter-body")
    )
      caretP = p;
  }
  if (caretP !== lastCaretPara) {
    if (lastCaretPara && lastCaretPara.isConnected) {
      try {
        lastCaretPara.normalize();
      } catch {
        /* fine */
      }
    }
    lastCaretPara = caretP;
  }
  // during a spellcheck pass, each chapter scans as the caret arrives
  if (revisionOn && caretP) revisionScanHere();
  if (spellOn && caretP) {
    const ch = caretP.closest('.chapter');
    if (ch) scanSpellingIn(ch.querySelector('.chapter-body'), ch.dataset.id);
  }
  if (focusModeOn) markFocusParagraph(caretP);
  // keep the Format menu's Poetry Paragraph check in step with the caret
  // (the drop cap's cap-off is handled per edit in the beforeinput handler)
  const inPoetry = !!(caretP && caretP.classList.contains('poetry'));
  if (inPoetry !== menuPoetryState && window.neo.poetryState) {
    menuPoetryState = inPoetry;
    window.neo.poetryState(inPoetry);
  }
});

// Reduce pasted HTML to what a manuscript is made of: paragraphs, bold,
// italic. Word, Apple Notes, Google Docs and browsers each dress a
// paragraph differently — <p>, <div>, a line break inside a block, styled
// spans — so every block boundary and <br> becomes a paragraph break, and
// styling that only lives in a style attribute is read as bold/italic.
function cleanPasteHtml(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  holder.querySelectorAll('script,style,meta,link,img,table,head,title').forEach((n) => n.remove());
  // Google Docs wraps the whole clipboard in <b style="font-weight:normal">
  holder.querySelectorAll('b, strong').forEach((b) => {
    const w = (b.style && b.style.fontWeight || '').toLowerCase();
    if (w === 'normal' || w === '400') { while (b.firstChild) b.before(b.firstChild); b.remove(); }
  });
  // styled spans: Word's italics and bold often live only in a style attribute
  holder.querySelectorAll('span[style], font[style]').forEach((sp) => {
    const st = sp.style;
    const fw = (st.fontWeight || '').toLowerCase();
    const bold = fw === 'bold' || fw === 'bolder' || parseInt(fw, 10) >= 600;
    const ital = (st.fontStyle || '').toLowerCase() === 'italic';
    if (bold) { const b = document.createElement('b'); while (sp.firstChild) b.appendChild(sp.firstChild); sp.appendChild(b); }
    if (ital) { const i = document.createElement('i'); while (sp.firstChild) i.appendChild(sp.firstChild); sp.appendChild(i); }
  });
  // a break marker at every block edge and every line break
  const BREAK = '\uE000';
  const blocks = 'p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre, section, article, header, footer, tr, dd, dt';
  holder.querySelectorAll(blocks).forEach((b) => {
    b.before(document.createTextNode(BREAK));
    b.after(document.createTextNode(BREAK));
  });
  holder.querySelectorAll('br').forEach((br) => br.replaceWith(document.createTextNode(BREAK)));

  const paras = [[]];
  for (const r of paraRuns(holder.innerHTML)) {
    if (r.mark !== undefined) { paras[paras.length - 1].push(r); continue; }
    const pieces = r.text.split(BREAK);
    pieces.forEach((text, i) => {
      if (i > 0) paras.push([]);
      if (text) paras[paras.length - 1].push({ text, b: r.b, i: r.i });
    });
  }
  const out = paras.map((runs) => {
    // whitespace collapses like HTML's, and each paragraph is trimmed
    runs = runs.map((r) => (r.mark !== undefined ? r : { ...r, text: r.text.replace(/\s+/g, ' ') }));
    const first = runs.find((r) => r.mark === undefined);
    if (first) first.text = first.text.replace(/^\s+/, '');
    const last = [...runs].reverse().find((r) => r.mark === undefined);
    if (last) last.text = last.text.replace(/\s+$/, '');
    const inner = runs.map((r) => {
      if (r.mark !== undefined) {
        // placeholder marks travel with their text; reconcileMarks pairs
        // each one back up with a note after the paste lands
        return r.mark
          ? `<span class="ph-mark" data-sid="${escHtml(r.mark)}" contenteditable="false">⚑</span>`
          : '';
      }
      if (!r.text) return '';
      let t = escHtml(r.text);
      if (r.i) t = '<i>' + t + '</i>';
      if (r.b) t = '<b>' + t + '</b>';
      return t;
    }).join('');
    return inner.replace(/<[^>]+>/g, '').trim() ? '<p>' + inner + '</p>' : '';
  }).filter(Boolean);
  // single block pastes inline (no forced new paragraph)
  if (out.length === 1) return out[0].slice(3, -4);
  return out.join("");
}

// Em dash, ellipsis, smart quotes:
function smartKeys(e, body) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.isComposing || e.keyCode === 229) return;

  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);

  const prevChars = (n) => {
    if (!range.collapsed) return "";
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return "";
    return node.textContent.slice(
      Math.max(0, range.startOffset - n),
      range.startOffset,
    );
  };

  if (e.key === "-" && prevChars(1) === "-") {
    e.preventDefault();
    document.execCommand("delete");
    document.execCommand("insertText", false, "—"); // —
    return;
  }
  if (e.key === "." && prevChars(2) === "..") {
    e.preventDefault();
    document.execCommand("delete");
    document.execCommand("delete");
    document.execCommand("insertText", false, "…"); // …
    return;
  }
  if (e.key === '"' || e.key === "'") {
    e.preventDefault();
    const before = prevChars(1);
    const opening = before === "" || /[\s\(\[\{—‘“>]/.test(before);
    const ch = e.key === '"' ? (opening ? "“" : "”") : opening ? "‘" : "’";
    document.execCommand("insertText", false, ch);
  }
}

// Title page: Enter drops you into Chapter One.
$("#tp-title").addEventListener("keydown", titleEnter);
$("#tp-subtitle").addEventListener("keydown", titleEnter);
function titleEnter(e) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (book.chapterOrder.length === 0) {
    newChapter();
  } else {
    focusChapter(book.chapterOrder[0]);
  }
}
$("#tp-title").addEventListener("input", () => {
  book.title = $("#tp-title").textContent.trim() || "Untitled";
  scheduleMetaSave();
});
$("#tp-subtitle").addEventListener("input", () => {
  book.subtitle = $("#tp-subtitle").textContent.trim();
  scheduleMetaSave();
});
// The title-page author is the book's pen name. Typing here renames that
// pen name when you leave the field, and every book under it follows.
$("#tp-author").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("#tp-author").blur(); }
});
$("#tp-author").addEventListener("blur", async () => {
  if (!book) return;
  const owner = ownerOfBook(book.id);
  const typed = $("#tp-author").textContent.trim();
  if (!owner) {
    book.author = typed || book.author;
    scheduleMetaSave();
    return;
  }
  if (!typed || typed === owner.name) {
    $("#tp-author").textContent = owner.name;
    return;
  }
  const others = library.shelves.filter((s) => (s.authorId || library.authors[0].id) === owner.id).flatMap((s) => s.bookIds || []).length - 1;
  owner.name = typed;
  library.authorName = library.authors[0].name;
  await window.neo.writeLibrary(library);
  await syncBookAuthors(owner);
  $("#author-chip").textContent = displayAuthor();
  toast(others > 0 ? `Pen name is now “${typed}” — its other ${others} book${others === 1 ? "" : "s"} updated too` : `Pen name is now “${typed}”`, 5000);
});

// Global editor shortcuts
function availableEditorTabs() {
  return Array.from(document.querySelectorAll("#tabs .tab[data-tab]"))
    .filter((tab) => !tab.hidden && getComputedStyle(tab).display !== "none")
    .map((tab) => tab.dataset.tab);
}

function cycleEditorTab(direction) {
  const tabs = availableEditorTabs();
  if (tabs.length < 2) return;
  const current = Math.max(0, tabs.indexOf(currentTab));
  const next = (current + direction + tabs.length) % tabs.length;
  switchTab(tabs[next]);
}

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if (e.key !== "PageUp" && e.key !== "PageDown") return;
  if ($("#editor-view").hidden || !book) return;
  if (document.querySelector(".modal-backdrop:not([hidden])")) return;
  e.preventDefault();
  e.stopPropagation();
  cycleEditorTab(e.key === "PageDown" ? 1 : -1);
});

document.addEventListener("keydown", (e) => {
  if ($("#editor-view").hidden) return;
  if (document.querySelector(".modal-backdrop:not([hidden])")) return; // visible modals own the keyboard
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.shiftKey && e.code === "KeyX") {
    e.preventDefault();
    if (currentTab === "manuscript") insertPlaceholder();
  }
  if (cmd && e.shiftKey && e.code === "KeyD") {
    e.preventDefault();
    if (currentTab === "manuscript") darlingFromKeyboard();
  }
  if (e.key === "Escape") {
    if (!$("#searchbar").hidden) closeSearch();
    else if (revisionOn) toggleRevisionPass(false);
    else
      window.neo.fullscreenEscape().then((exited) => {
        if (!exited) backToShelf();
      });
  }
});

// Escape also exits regular fullscreen from the bookshelf
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !$("#editor-view").hidden) return;
  if (document.querySelector(".modal-backdrop:not([hidden])")) return;
  window.neo.fullscreenEscape();
});

// ⌘Enter (Ctrl+Enter): toggle fullscreen from anywhere
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey)
    return;
  if (document.querySelector(".modal-backdrop:not([hidden])")) return;
  e.preventDefault();
  window.neo.fullscreenToggle();
});

function createChapterAt(idx) {
  const chId =
    "ch-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 6);
  book.chapterOrder.splice(idx, 0, chId);
  chapterHTML[chId] = "<p><br></p>";
  window.neo.writeChapter(book.id, chId, chapterHTML[chId]);
  saveMeta();
  renderChapters();
  return chId;
}

function newChapter() {
  // insert after the chapter you're in; at the end if you're not in one
  const idx = currentChapterId
    ? book.chapterOrder.indexOf(currentChapterId) + 1
    : book.chapterOrder.length;
  const chId = createChapterAt(idx);
  focusChapter(chId);
}

async function deleteChapterQuiet(chId) {
  book.chapterOrder = book.chapterOrder.filter((c) => c !== chId);
  delete chapterHTML[chId];
  delete wordCache[chId];
  if (book.sectionNotes) delete book.sectionNotes[chId];
  if (book.chapterNotes) delete book.chapterNotes[chId];
  if (book.chapterStatus) delete book.chapterStatus[chId];
  stickies = stickies.filter((s) => s.chapterId !== chId);
  window.neo.writeJSON(book.id, "stickies", stickies);
  window.neo.deleteChapter(book.id, chId);
  await saveMeta();
  renderChapters();
  renderStickies();
}

function focusChapter(chId) {
  const body = document.querySelector(
    `.chapter[data-id="${chId}"] .chapter-body`,
  );
  if (!body) return;
  body.focus();
  // caret at the very end
  const range = document.createRange();
  range.selectNodeContents(body);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  body
    .closest(".chapter")
    .scrollIntoView({ behavior: "smooth", block: "start" });
  currentChapterId = chId;
  highlightNav();
}

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

/* ================================================================== */
/*  TABS — Manuscript / Notes / Outline / Darlings                     */
/* ================================================================== */

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
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
  const tab = e.target.closest('.tab[data-tab="cards"]');
  if (tab && !tab.hidden) switchTab("cards");
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
  if (spellOn) setTimeout(scanSpellingHere, 0);
  if (revisionOn && name !== "manuscript") toggleRevisionPass(false);
  if (name !== "manuscript") stopReadAloud(true);
  const paper = $("#paper");
  const aux = $("#aux-paper");
  const auxEditor = $("#aux-editor");
  const dList = $("#darlings-list");
  const cardsList = $("#cards-list");
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
  cardsList.hidden = true;
  oList.hidden = true;

  if (name === "darlings") {
    $("#aux-title").textContent = "Darlings";
    dList.hidden = false;
    renderDarlings();
    returnTo();
  } else if (name === "cards") {
    $("#aux-title").textContent = "Note cards";
    cardsList.hidden = false;
    renderNoteCards();
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

/* ================================================================== */
/*  STRUCTURED OUTLINE                                                 */
/*  Chapter lines are the book's real chapters. Section notes become   */
/*  grayed "ghost" paragraphs in the manuscript                       */
/* ================================================================== */

const secLetter = (i) => String.fromCharCode(65 + (i % 26));

const STORY_BEATS = ["Unassigned", "Setup", "Inciting incident", "Rising action", "Midpoint", "Crisis", "Climax", "Resolution"];
const STORY_PROGRESS = ["Planned", "Drafting", "Revising", "Ready"];

function storyMapEntry(chId, index) {
  book.storyMap = book.storyMap || {};
  const existing = book.storyMap[chId] || {};
  const defaultAct = index < Math.ceil(book.chapterOrder.length / 3) ? "Act I" : index < Math.ceil(book.chapterOrder.length * 2 / 3) ? "Act II" : "Act III";
  book.storyMap[chId] = {
    act: existing.act || defaultAct,
    beat: existing.beat || "Unassigned",
    thread: existing.thread || "",
    progress: existing.progress || "Planned",
  };
  return book.storyMap[chId];
}

function renderStoryMap(wrap) {
  const map = document.createElement("section");
  map.className = "story-map-summary";
  map.innerHTML = `<div class="story-map-head"><div><strong>Story map</strong><span>Shape the book while you outline it.</span></div><span class="story-map-help">Edit any card · click its title to open the chapter</span></div>`;
  const board = document.createElement("div");
  board.className = "story-map-board";
  const groups = new Map();
  book.chapterOrder.forEach((chId, index) => {
    const entry = storyMapEntry(chId, index);
    const act = entry.act || "Unassigned";
    if (!groups.has(act)) groups.set(act, []);
    groups.get(act).push({ chId, index, entry });
  });
  for (const [act, chapters] of groups) {
    const lane = document.createElement("div");
    lane.className = "story-map-lane";
    lane.innerHTML = `<div class="story-map-lane-head"><strong>${escHtml(act)}</strong><span>${chapters.length} chapter${chapters.length === 1 ? "" : "s"}</span></div>`;
    const cards = document.createElement("div");
    cards.className = "story-map-cards";
    chapters.forEach(({ chId, index, entry }) => {
      const words = countWords(chapterText(chId));
      const scenes = (book.sectionNotes[chId] || []).length;
      const title = (book.chapterTitles || {})[chId] || `Chapter ${index + 1}`;
      const card = document.createElement("article");
      card.className = "story-map-card";
      card.dataset.chId = chId;
      card.innerHTML = `
        <div class="story-map-card-head"><button class="story-map-open" title="Open chapter">${escHtml(title)}</button><span>${words.toLocaleString()} words</span></div>
        <div class="story-map-fields">
          <label>Act <input data-story-field="act" value="${escHtml(entry.act)}" /></label>
          <label>Beat <select data-story-field="beat">${STORY_BEATS.map((beat) => `<option${entry.beat === beat ? " selected" : ""}>${escHtml(beat)}</option>`).join("")}</select></label>
          <label>Progress <select data-story-field="progress">${STORY_PROGRESS.map((progress) => `<option${entry.progress === progress ? " selected" : ""}>${progress}</option>`).join("")}</select></label>
          <label>Thread <input data-story-field="thread" value="${escHtml(entry.thread)}" placeholder="Character or question" /></label>
        </div>
        <div class="story-map-card-foot"><span>${scenes} scene${scenes === 1 ? "" : "s"}</span>${book.chapterNotes[chId] ? `<span title="Outline note">${escHtml(book.chapterNotes[chId].slice(0, 70))}${book.chapterNotes[chId].length > 70 ? "…" : ""}</span>` : "<span>add a chapter note below</span>"}</div>`;
      card.querySelector(".story-map-open").onclick = () => {
        switchTab("manuscript");
        focusChapter(chId);
      };
      card.querySelectorAll("[data-story-field]").forEach((field) => {
        const save = () => {
          entry[field.dataset.storyField] = field.value.trim();
          if (field.dataset.storyField === "beat" && !entry.beat) entry.beat = "Unassigned";
          if (field.dataset.storyField === "progress" && !entry.progress) entry.progress = "Planned";
          scheduleMetaSave();
          if (field.dataset.storyField === "act") renderOutline();
          else field.closest(".story-map-card")?.classList.add("saved");
        };
        field.addEventListener("change", save);
        field.addEventListener("blur", save);
        field.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); field.blur(); }
          event.stopPropagation();
        });
      });
      cards.appendChild(card);
    });
    lane.appendChild(cards);
    board.appendChild(lane);
  }
  if (!book.chapterOrder.length) board.innerHTML = '<p class="story-map-empty">Create a chapter below to start mapping the story.</p>';
  map.appendChild(board);
  wrap.appendChild(map);
}

function renderOutline(focusTarget) {
  book.sectionNotes = book.sectionNotes || {};
  book.chapterNotes = book.chapterNotes || {};
  const wrap = $("#outline-list");
  wrap.innerHTML = "";
  if (pluginEnabled("storyMap")) {
    renderStoryMap(wrap);
  }

  book.chapterOrder.forEach((chId, i) => {
    wrap.appendChild(
      outlineLine(
        "chapter",
        chId,
        null,
        i,
        String(i + 1),
        book.chapterNotes[chId] || "",
      ),
    );
    (book.sectionNotes[chId] || []).forEach((sec, j) => {
      wrap.appendChild(
        outlineLine("section", chId, sec.id, j, secLetter(j), sec.text),
      );
    });
  });

  const hint = document.createElement("div");
  hint.className = "ol-hint";
  hint.textContent =
    "Enter — new chapter (or section, from a section line) · Tab — turn a fresh chapter line into a section · Shift+Tab — turn a section into a chapter · Backspace on an empty line removes it";
  wrap.appendChild(hint);

  if (focusTarget) {
    const el = wrap.querySelector(
      focusTarget.secId
        ? `.ol-line[data-sec-id="${focusTarget.secId}"] .ol-text`
        : `.ol-line.ol-chapter[data-ch-id="${focusTarget.chId}"] .ol-text`,
    );
    if (el) {
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
  }
}

function outlineLine(kind, chId, secId, index, label, text) {
  const line = document.createElement("div");
  line.className = "ol-line ol-" + kind;
  line.dataset.chId = chId;
  if (secId) line.dataset.secId = secId;
  const num = document.createElement("span");
  num.className = "ol-num";
  num.textContent = label;
  const txt = document.createElement("div");
  txt.className = "ol-text";
  txt.contentEditable = "true";
  txt.spellcheck = false;
  txt.textContent = text;

  const save = () => {
    const val = txt.textContent.trim();
    if (kind === "chapter") {
      book.chapterNotes[chId] = val;
    } else {
      const sec = (book.sectionNotes[chId] || []).find((s) => s.id === secId);
      if (sec) sec.text = val;
    }
    scheduleMetaSave();
  };

  txt.addEventListener("blur", () => {
    save();
    if (kind === "section") syncGhosts(chId);
    renderNav();
  });

  txt.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
      if (kind === "chapter") {
        const at = book.chapterOrder.indexOf(chId) + 1;
        const newId = createChapterAt(at);
        renderOutline({ chId: newId });
      } else {
        const list = book.sectionNotes[chId];
        const newSec = { id: "sec-" + Date.now().toString(36), text: "" };
        list.splice(index + 1, 0, newSec);
        scheduleMetaSave();
        syncGhosts(chId);
        renderOutline({ secId: newSec.id });
      }
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const lines = [...document.querySelectorAll(".ol-line .ol-text")];
      const next = lines[lines.indexOf(txt) + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        next.focus();
        const r = document.createRange();
        r.selectNodeContents(next);
        r.collapse(false);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
    }
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      if (kind !== "chapter") return;
      const pos = book.chapterOrder.indexOf(chId);
      if (pos === 0) {
        toast("The first line has to be a chapter");
        return;
      }
      if (countWords(chapterText(chId)) > 0) {
        toast(
          "This chapter already has words in it — only empty chapter lines can become sections",
        );
        return;
      }
      save();
      const prevCh = book.chapterOrder[pos - 1];
      book.sectionNotes[prevCh] = book.sectionNotes[prevCh] || [];
      const newSec = {
        id: "sec-" + Date.now().toString(36),
        text: txt.textContent.trim(),
      };
      book.sectionNotes[prevCh].push(newSec);
      deleteChapterQuiet(chId).then(() => {
        syncGhosts(prevCh);
        renderOutline({ secId: newSec.id });
      });
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      if (kind !== "section") return;
      save();
      const list = book.sectionNotes[chId];
      const sec = list.find((s) => s.id === secId);
      list.splice(list.indexOf(sec), 1);
      const at = book.chapterOrder.indexOf(chId) + 1;
      const newId = createChapterAt(at);
      book.chapterNotes[newId] = sec.text;
      scheduleMetaSave();
      syncGhosts(chId);
      renderOutline({ chId: newId });
    }
    if (e.key === "Backspace" && txt.textContent.trim() === "") {
      e.preventDefault();
      if (kind === "section") {
        const list = book.sectionNotes[chId];
        book.sectionNotes[chId] = list.filter((s) => s.id !== secId);
        scheduleMetaSave();
        syncGhosts(chId);
        renderOutline({ chId });
      } else if (
        book.chapterOrder.length > 1 &&
        countWords(chapterText(chId)) === 0
      ) {
        const pos = book.chapterOrder.indexOf(chId);
        const prevCh = book.chapterOrder[Math.max(0, pos - 1)];
        deleteChapterQuiet(chId).then(() => renderOutline({ chId: prevCh }));
      }
    }
    e.stopPropagation();
  });

  // right-click any outline line to delete it
  line.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    if (kind === "chapter") {
      const i = book.chapterOrder.indexOf(chId);
      const words = countWords(chapterText(chId));
      const choice = await optionModal(
        `Chapter ${i + 1}`,
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
      if (choice === "delete") {
        await deleteChapterToDarlings(chId);
        renderOutline();
      }
    } else {
      const choice = await optionModal("Delete this section?", null, [
        {
          label: "Delete section",
          desc: "Removes the outline line and its gray ghost from the manuscript. Written prose is never touched.",
          danger: true,
          value: "delete",
        },
      ]);
      if (choice === "delete") {
        book.sectionNotes[chId] = (book.sectionNotes[chId] || []).filter(
          (s) => s.id !== secId,
        );
        scheduleMetaSave();
        syncGhosts(chId);
        renderOutline({ chId });
      }
    }
  });

  line.appendChild(num);
  line.appendChild(txt);
  return line;
}

// Push section notes into the manuscript as gray ghost paragraphs,
// with real *** scene breaks between sections.
// Once a ghost has been written over, it goes away.
function syncGhosts(chId) {
  const body = document.querySelector(
    `.chapter[data-id="${chId}"] .chapter-body`,
  );
  if (!body) return;
  const list = (book.sectionNotes && book.sectionNotes[chId]) || [];
  const keep = new Set(list.map((s) => s.id));

  const breakFor = (secId) =>
    body.querySelector(`p.scene-break[data-sec-brk="${secId}"]`);

  // 1. Sections deleted from the outline: remove their ghost + its break
  //    (but never touch paragraphs that have been written over)
  body.querySelectorAll("p.ghost[data-sec-id]").forEach((p) => {
    if (!keep.has(p.dataset.secId)) {
      const brk = breakFor(p.dataset.secId);
      if (brk) brk.remove();
      p.remove();
    }
  });

  // 2. Pull all still-ghost paragraphs out, then re-append in outline order
  //    so the ghosts always mirror the outline's sequence
  for (const p of [...body.querySelectorAll("p.ghost[data-sec-id]")]) {
    const brk = breakFor(p.dataset.secId);
    if (brk) brk.remove();
    p.remove();
  }
  for (const sec of list) {
    // written over already? Leave it alone
    const written = body.querySelector(
      `p[data-sec-id="${sec.id}"]:not(.ghost)`,
    );
    if (written) continue;
    if (!sec.text) continue;
    // *** between this ghost and whatever comes before it
    const hasContent = body.innerText.trim() !== "";
    if (
      hasContent &&
      !(
        body.lastElementChild &&
        body.lastElementChild.classList.contains("scene-break")
      )
    ) {
      const brk = document.createElement("p");
      brk.className = "scene-break";
      brk.dataset.secBrk = sec.id;
      brk.textContent = "***";
      body.appendChild(brk);
    }
    const p = document.createElement("p");
    p.className = "ghost";
    p.dataset.secId = sec.id;
    p.textContent = sec.text;
    body.appendChild(p);
  }
  syncChapter(body, chId);
}

let auxDirty = false;
$("#aux-editor").addEventListener("keydown", (e) => {
  styleKeepScroll(e);
});
$("#aux-editor").addEventListener("input", () => {
  auxDirty = true;
  scheduleAuxSave();
  if (spellOn) {
    const key = "aux-" + ($("#aux-editor").dataset.kind || "notes");
    scheduleSpellRescan(key, $("#aux-editor"));
  }
});
// notes paste arrives clean, same as the manuscript
$("#aux-editor").addEventListener("paste", (e) => {
  e.preventDefault();
  const html = e.clipboardData.getData("text/html");
  const text = e.clipboardData.getData("text/plain");
  if (html) document.execCommand("insertHTML", false, cleanPasteHtml(html));
  else if (text)
    document.execCommand("insertText", false, text.replace(/\r/g, ""));
});
function scheduleAuxSave() {
  clearTimeout(saveTimers.aux);
  saveTimers.aux = setTimeout(flushAux, 800);
  scheduleCheckpoint("writing");
}
function flushAux() {
  if (!auxDirty || !book) return;
  const kind = $("#aux-editor").dataset.kind;
  if (kind) window.neo.writeAux(book.id, kind, $("#aux-editor").innerHTML);
  auxDirty = false;
}

function saveNoteCards() {
  if (book) window.neo.writeJSON(book.id, "note-cards", noteCards);
}
function renderNoteCards() {
  const wrap = $("#cards-list");
  wrap.innerHTML = "";
  const add = document.createElement("button");
  add.className = "add-card";
  add.textContent = "+ New card";
  add.onclick = () => {
    noteCards.unshift({ id: "card-" + Date.now().toString(36), title: "", body: "" });
    saveNoteCards();
    renderNoteCards();
    wrap.querySelector(".note-card-title")?.focus();
  };
  wrap.appendChild(add);
  if (!noteCards.length) {
    const empty = document.createElement("div");
    empty.className = "cards-empty";
    empty.textContent = "Make a card for a character, a bit of research, or the next scene. These stay with this book.";
    wrap.appendChild(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "cards-grid";
  let draggingId = null;
  noteCards.forEach((card) => {
    const el = document.createElement("article");
    el.className = "note-card";
    const grip = document.createElement("button");
    grip.className = "card-drag"; grip.textContent = "⠿"; grip.title = "Drag to rearrange"; grip.draggable = true;
    const title = document.createElement("div");
    title.className = "note-card-title"; title.contentEditable = "true"; title.spellcheck = false; title.dataset.ph = "Card title…"; title.textContent = card.title || "";
    const body = document.createElement("div");
    body.className = "note-card-body"; body.contentEditable = "true"; body.spellcheck = true; body.dataset.ph = "Write on this card…"; body.textContent = card.body || "";
    const remove = document.createElement("button");
    remove.className = "note-card-remove"; remove.textContent = "Remove";
    const save = () => { card.title = title.textContent.trim(); card.body = body.textContent; saveNoteCards(); };
    title.oninput = save; body.oninput = save;
    remove.onclick = () => { noteCards = noteCards.filter((c) => c.id !== card.id); saveNoteCards(); renderNoteCards(); };
    grip.addEventListener("dragstart", (e) => { draggingId = card.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", card.id); el.classList.add("dragging"); });
    grip.addEventListener("dragend", () => { draggingId = null; el.classList.remove("dragging"); grid.querySelectorAll(".drop-before").forEach((n) => n.classList.remove("drop-before")); });
    el.addEventListener("dragover", (e) => { if (!draggingId || draggingId === card.id) return; e.preventDefault(); el.classList.add("drop-before"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop-before"));
    el.addEventListener("drop", (e) => {
      if (!draggingId || draggingId === card.id) return;
      e.preventDefault();
      const from = noteCards.findIndex((c) => c.id === draggingId);
      const to = noteCards.findIndex((c) => c.id === card.id);
      if (from < 0 || to < 0) return;
      const [moved] = noteCards.splice(from, 1);
      noteCards.splice(to > from ? to - 1 : to, 0, moved);
      saveNoteCards(); renderNoteCards();
    });
    el.append(grip, title, body, remove); grid.appendChild(el);
  });
  wrap.appendChild(grid);
}

function renderDarlings() {
  const wrap = $("#darlings-list");
  wrap.innerHTML = "";
  if (darlings.length === 0) {
    wrap.innerHTML = `<div class="darlings-empty">When a beautiful paragraph is gumming up the works, select it and drag it onto the Darlings tab below.<br>It leaves your manuscript but it is never lost.</div>`;
    return;
  }
  for (const d of darlings) {
    const el = document.createElement("div");
    el.className = "darling";
    const content = document.createElement("div");
    if (d.html) content.innerHTML = d.html;
    else content.textContent = d.text;
    const meta = document.createElement("div");
    meta.className = "d-meta";
    const when = new Date(d.date).toLocaleDateString();
    meta.innerHTML = `<span>from ${d.chapterLabel} · ${when} · ${countWords(d.text).toLocaleString()} words</span>
      <span><button class="d-restore">Restore</button> <button class="d-del">Delete forever</button></span>`;
    meta.querySelector(".d-restore").onclick = () => restoreDarling(d.id);
    meta.querySelector(".d-del").onclick = async () => {
      snapshotStructure("darling delete");
      // tidy up the invisible anchor the darling left behind
      const anchor = document.querySelector(
        `.darling-anchor[data-did="${d.id}"]`,
      );
      if (anchor) {
        const body = anchor.closest(".chapter-body");
        const chId = anchor.closest(".chapter").dataset.id;
        anchor.remove();
        syncChapter(body, chId);
      }
      darlings = darlings.filter((x) => x.id !== d.id);
      await window.neo.writeJSON(book.id, "darlings", darlings);
      renderDarlings();
    };
    el.appendChild(content);
    el.appendChild(meta);
    wrap.appendChild(el);
  }
}

async function restoreDarling(id) {
  const d = darlings.find((x) => x.id === id);
  if (!d) return;
  snapshotStructure("darling restore");
  switchTab("manuscript");

  // Preferred: put it back in the exact spot it was cut from, located by
  // the remembered text surrounding the cut point
  if (d.chapterId && book.chapterOrder.includes(d.chapterId)) {
    const body = document.querySelector(
      `.chapter[data-id="${d.chapterId}"] .chapter-body`,
    );
    const pos = body ? findDarlingPosition(body, d) : -1;
    if (body && pos !== -1) {
      const at = textPosToRange(body, pos);
      if (at) {
        let scrollTo = at.startContainer.parentElement?.closest?.("p") || body;
        if (d.html && /<p[\s>]/i.test(d.html)) {
          // block content: paragraphs go back in after the host paragraph
          const holder = document.createElement("div");
          holder.innerHTML = d.html;
          let ref = scrollTo === body ? body.lastElementChild : scrollTo;
          scrollTo = holder.firstElementChild || scrollTo;
          for (const n of [...holder.childNodes]) {
            ref.after(n);
            ref = n;
          }
        } else {
          // inline content: slot it right where the caret was
          at.insertNode(
            document.createRange().createContextualFragment(d.html || d.text),
          );
        }
        syncChapter(body, d.chapterId);
        darlings = darlings.filter((x) => x.id !== id);
        await window.neo.writeJSON(book.id, "darlings", darlings);
        scrollTo.scrollIntoView({ behavior: "smooth", block: "center" });
        toast("Darling restored to its original spot");
        return;
      }
    }
  }

  // Fallback: the spot no longer exists — end of its chapter (or the last one)
  let chId =
    d.chapterId && book.chapterOrder.includes(d.chapterId)
      ? d.chapterId
      : book.chapterOrder[book.chapterOrder.length - 1];
  if (!chId) {
    newChapter();
    chId = book.chapterOrder[0];
  }
  const body = document.querySelector(
    `.chapter[data-id="${chId}"] .chapter-body`,
  );
  const frag = d.html
    ? d.html
    : "<p>" + d.text.replace(/\n+/g, "</p><p>") + "</p>";
  body.insertAdjacentHTML("beforeend", frag);
  chapterHTML[chId] = captureBody(body);
  scheduleChapterSave(chId);
  darlings = darlings.filter((x) => x.id !== id);
  await window.neo.writeJSON(book.id, "darlings", darlings);
  focusChapter(chId);
  toast(
    "Original spot is gone — restored to the end of " +
      (d.chapterLabel || "the manuscript"),
  );
}

/* ================================================================== */
/*  COUNTERS                                                           */
/* ================================================================== */

function bookWordCount() {
  return book.chapterOrder.reduce((sum, chId) => sum + chapterWords(chId), 0);
}

function updateCounters() {
  if (!book) return;
  const total = bookWordCount();
  const wc = $("#word-counter");
  if (wordMode === "book") {
    wc.textContent = total.toLocaleString() + " words";
  } else {
    const n = currentChapterId ? chapterWords(currentChapterId) : 0;
    const idx = book.chapterOrder.indexOf(currentChapterId);
    wc.textContent = `ch. ${idx + 1}: ${n.toLocaleString()} words`;
  }
  const pos = $("#pos-counter");
  const idx = book.chapterOrder.indexOf(currentChapterId);
  pos.textContent =
    book.chapterOrder.length <= 1
      ? "" // a chapterless story needs no chapter locator
      : idx >= 0
        ? `chapter ${idx + 1} of ${book.chapterOrder.length}`
        : `${book.chapterOrder.length} chapters`;
  // cache for the bookshelf progress bar
  if (book.wordCount !== total) {
    // only a true crossing earns a painting — a story that was already long
    // before NEO could paint keeps its abstract until the writer asks
    const before = typeof book.wordCount === "number" ? book.wordCount : total;
    book.wordCount = total;
    scheduleMetaSave();
    if (
      before < PAINT_AT &&
      total >= PAINT_AT &&
      !(library.coverArt && library.coverArt.auto === false) &&
      paintable(book)
    ) {
      requestPaint(book, bookPlainText());
    }
  }
  trackDailyWords(total);
}

// ---- daily word tracking + goal display ----
// The writing day follows the writer's own clock, and rolls over at
// library.dayEndsAt (0 = midnight) so a session that runs past midnight
// still counts toward the night it began.
function writingDay(d = new Date(), dayEndsAt = library.dayEndsAt || 0) {
  d = new Date(d);
  if (d.getHours() < dayEndsAt) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const todayStr = () => writingDay();

function setWritingDayEnd(hour) {
  if (!book) { library.dayEndsAt = hour; return; }
  const hasLedger = (book.wordHistory || []).length > 1;
  const oldDay = todayStr();
  library.dayEndsAt = hour;
  const newDay = todayStr();
  // Older books have no timestamps, so retain the old best-effort behavior.
  // New books derive every day from timestamped snapshots instead.
  if (!hasLedger && oldDay !== newDay && book.dailyCounts && book.dailyCounts[oldDay]) {
    book.dailyCounts[newDay] = book.dailyCounts[oldDay];
    delete book.dailyCounts[oldDay];
    scheduleMetaSave();
  }
}

function recordWordEvent(total) {
  const events = book.wordHistory || (book.wordHistory = []);
  const now = Date.now();
  const last = events[events.length - 1];
  if (!last) {
    events.push({ at: now, total });
  } else if (last.total !== total) {
    // One local checkpoint per minute keeps the file tiny while still making
    // cutoff changes accurate to the minute, across app restarts.
    if (now - last.at < 60000) {
      last.at = now;
      last.total = total;
    } else {
      events.push({ at: now, total });
    }
  } else return;
  scheduleMetaSave();
}

function dailyWordMap(dayEndsAt = library.dayEndsAt || 0) {
  const events = book.wordHistory || [];
  if (events.length > 1) {
    const words = {};
    for (let i = 1; i < events.length; i++) {
      const key = writingDay(events[i].at, dayEndsAt);
      words[key] = (words[key] || 0) + events[i].total - events[i - 1].total;
    }
    return words;
  }
  const legacy = book.dailyCounts || {};
  return Object.fromEntries(Object.entries(legacy).map(([day, count]) => [day, (count.end || 0) - (count.start || 0)]));
}

function dailyWords(day) {
  return dailyWordMap()[day] || 0;
}

function cumulativeWordSeries(days) {
  const events = book.wordHistory || [];
  if (events.length > 1) {
    const ends = {};
    for (const event of events) ends[writingDay(event.at)] = event.total;
    let total = events[0].total;
    return days.map((day) => {
      if (typeof ends[day] === "number") total = ends[day];
      return total;
    });
  }
  const counts = book.dailyCounts || {};
  let total = 0;
  const first = days.find((day) => counts[day]);
  if (first) total = counts[first].start || 0;
  return days.map((day) => {
    if (counts[day]) total = counts[day].end || total;
    return total;
  });
}

function trackDailyWords(total) {
  recordWordEvent(total);
  // Keep the legacy summary current for books that may be opened by an older
  // NEO build. The live footer/chart themselves use the timestamped ledger.
  book.dailyCounts = book.dailyCounts || {};
  const today = todayStr();
  if (!book.dailyCounts[today]) {
    book.dailyCounts[today] = { start: total, end: total };
    scheduleMetaSave();
  } else if (book.dailyCounts[today].end !== total) {
    book.dailyCounts[today].end = total;
  }
  const wordsToday = dailyWords(today);
  const gc = $("#goal-counter");
  if (!updateSprintCounter(total)) {
    const goal = effectiveDailyTarget(total);
    gc.textContent = goal
      ? `${wordsToday.toLocaleString()} / ${goal.toLocaleString()} today`
      : `${wordsToday.toLocaleString()} today`;
    gc.classList.toggle("goal-met", goal > 0 && wordsToday >= goal);
  }
}

$("#word-counter").onclick = () => {
  wordMode = wordMode === "book" ? "chapter" : "book";
  updateCounters();
};

// select a passage → the counter reports its size
document.addEventListener("selectionchange", () => {
  if (!book || currentTab !== "manuscript") return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    let el = sel.anchorNode;
    if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    if (el && el.closest && el.closest(".chapter-body")) {
      const n = countWords(sel.toString());
      if (n > 0) {
        $("#word-counter").textContent = n.toLocaleString() + " selected";
        return;
      }
    }
  }
  clearTimeout(saveTimers.selcount);
  saveTimers.selcount = setTimeout(() => {
    if (book) updateCounters();
  }, 150);
});

// track which chapter you're scrolled to
$("#paper-scroll").addEventListener("scroll", () => {
  clearTimeout(saveTimers.scroll);
  saveTimers.scroll = setTimeout(() => {
    const mid = window.innerHeight * 0.4;
    let best = null;
    for (const sec of $$(".chapter")) {
      if (sec.getBoundingClientRect().top < mid) best = sec.dataset.id;
    }
    if (best && best !== currentChapterId) {
      currentChapterId = best;
      highlightNav();
      updateCounters();
    }
  }, 120);
});

/* ================================================================== */
/*  SAVING                                                             */
/* ================================================================== */

let checkpointTimer = null;

function historySettings() {
  return library.history || {};
}

function checkpointInterval() {
  const minutes = Number(historySettings().intervalMinutes) || 5;
  return Math.min(60, Math.max(5, minutes)) * 60 * 1000;
}

// Versions feed both local history and the GitHub backup; either one being
// on is reason enough to make them.
function versionsWanted() {
  const settings = historySettings();
  return settings.enabled !== false || !!(settings.git && settings.git.enabled);
}

function checkpointNow(reason, bookId = book && book.id) {
  if (!book || !bookId || book.id !== bookId || !versionsWanted()) return;
  if (typeof window.neo.createCheckpoint !== "function") return; // NEO Pocket has no version history
  clearTimeout(checkpointTimer);
  checkpointTimer = null;
  // The main process queues these writes before the checkpoint request, so a
  // checkpoint always captures one coherent on-disk state.
  flushAllSaves();
  window.neo.createCheckpoint(bookId, reason).catch((err) => {
    window.neo.logError(`checkpoint: ${err && err.stack ? err.stack : err}`);
  }).then((result) => {
    if (result) lastCheckpointAt = new Date(result.createdAt);
  });
}

function scheduleCheckpoint(reason) {
  if (!book || !versionsWanted() || checkpointTimer) return;
  const bookId = book.id;
  checkpointTimer = setTimeout(() => {
    checkpointTimer = null;
    checkpointNow(reason, bookId);
  }, checkpointInterval());
}

// Leaving a book (or quitting) captures the writing since the last version
// instead of dropping it when the timer's book is gone.
function finishPendingCheckpoint(reason) {
  if (!checkpointTimer) return;
  checkpointNow(reason);
}

function scheduleChapterSave(chId) {
  dirtyChapters.add(chId);
  clearTimeout(saveTimers[chId]);
  saveTimers[chId] = setTimeout(() => saveChapterNow(chId), 800);
}

function saveChapterNow(chId) {
  if (!book || !dirtyChapters.has(chId)) return;
  const html = chapterHTML[chId] || "";
  window.neo.writeChapter(book.id, chId, html).then(() => {
    if (chapterHTML[chId] === html) dirtyChapters.delete(chId);
    lastSavedAt = new Date();
  }).catch((err) => window.neo.logError(`chapter save: ${err && err.stack ? err.stack : err}`));
}

function scheduleMetaSave() {
  metaSavePending = true;
  clearTimeout(saveTimers.meta);
  saveTimers.meta = setTimeout(() => saveMeta(false), 800);
  scheduleCheckpoint("writing");
}
async function saveMeta(force = true) {
  if (book && (force || metaSavePending)) {
    book.modified = new Date().toISOString();
    await window.neo.writeBookMeta(book.id, book);
    metaSavePending = false;
    lastSavedAt = new Date();
  }
}

function flushAllSaves() {
  if (!book) return;
  const position = {
    chapterId: currentChapterId,
    scroll: $("#paper-scroll").scrollTop,
  };
  if (!book.lastPosition || book.lastPosition.chapterId !== position.chapterId || book.lastPosition.scroll !== position.scroll) {
    book.lastPosition = position;
    metaSavePending = true;
  }
  for (const chId of dirtyChapters) saveChapterNow(chId);
  flushAux();
  saveMeta(false);
}

window.addEventListener("beforeunload", flushAllSaves);
// Focus loss preserves a changed caret/scroll position. The interval is only
// a safety net for an edit that still has a pending debounce; idle books do
// not write themselves to disk.
window.addEventListener("blur", () => {
  if (book) flushAllSaves();
});
setInterval(() => {
  if (book && (dirtyChapters.size || auxDirty || metaSavePending)) flushAllSaves();
}, 20000);

async function backToShelf() {
  if (revisionOn) toggleRevisionPass(false);
  stopReadAloud(true);
  flushAllSaves();
  finishPendingCheckpoint("closed book");
  tabPlaces = {};
  dirtyChapters = new Set();
  metaSavePending = false;
  book = null;
  currentChapterId = null;
  undoStack = [];
  $("#editor-view").hidden = true;
  $("#bookshelf-view").hidden = false;
  renderShelves();
}
$("#back-to-shelf").onclick = backToShelf;

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
  book.chapterOrder = snap.chapterOrder;
  chapterHTML = snap.chapterHTML;
  book.chapterTitles = snap.chapterTitles;
  book.chapterNotes = snap.chapterNotes;
  book.sectionNotes = snap.sectionNotes;
  darlings = snap.darlings;
  stickies = snap.stickies;
  // resurrect any chapter files the action may have deleted
  for (const chId of book.chapterOrder) {
    await window.neo.writeChapter(
      book.id,
      chId,
      chapterHTML[chId] || "<p><br></p>",
    );
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

/* ================================================================== */
/*  IMPORT                                                             */
/* ================================================================== */

const escHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Turn parsed manuscripts into books on a shelf — used by the file picker
// and by dropping files from Finder straight onto a shelf.
async function addImportedBooks(results, shelf) {
  shelf = shelf || shelvesFor(currentAuthor().id)[0] || library.shelves[0];
  let ok = 0;
  for (const r of results) {
    if (r.error) {
      toast(`Couldn't import ${r.name}: ${r.error}`, 6000);
      continue;
    }
    // title/byline harvested from the document beat the filename;
    // passing the title in gives the book folder a readable name too
    const meta = await window.neo.createBook({
      author: displayAuthor(), // a book takes its shelf’s pen name
      title: r.title || r.name,
    });
    meta.title = r.title || r.name;
    meta.tabNames = {
      notes: (library.tabDefaults && library.tabDefaults.notes) || "Notes",
      outline:
        (library.tabDefaults && library.tabDefaults.outline) || "Outline",
    };
    let words = 0;
    meta.chapterTitles = {};
    for (const ch of r.chapters) {
      const chId = 'ch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const html = ch.paras.map((p) => {
        if (p.scene) return '<p class="scene-break">***</p>';
        let text = escHtml(p.text || '');
        text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
                   .replace(/\*([^*]+)\*/g, '<i>$1</i>')
                   .replace(/_([^_]+)_/g, '<i>$1</i>');
        return `<p>${text}</p>`;
      }).join('') || '<p><br></p>';
      await window.neo.writeChapter(meta.id, chId, html);
      if (ch.title) meta.chapterTitles[chId] = ch.title;
      meta.chapterOrder.push(chId);
      for (const p of ch.paras) words += countWords(p.text || '');
    }
    meta.wordCount = words;
    await window.neo.writeBookMeta(meta.id, meta);
    shelf.bookIds.push(meta.id);
    ok++;
  }
  await window.neo.writeLibrary(library);
  if (!$("#bookshelf-view").hidden) renderShelves();
  if (ok)
    toast(
      `${ok} book${ok === 1 ? "" : "s"} imported onto “${shelf.name}” — chapters and scene breaks detected`,
      6000,
    );
}

async function importBooks() {
  const results = await window.neo.importPick();
  if (results.length)
    await addImportedBooks(
      results,
      shelvesFor(currentAuthor().id)[0] || library.shelves[0],
    );
}

$("#import-btn").onclick = importBooks;

/* ================================================================== */
/*  SPELLCHECK PASS + TYPEWRITER SCROLLING                             */
/* ================================================================== */

/* NEO's own spellcheck pass: a bundled dictionary (via the main process),
   squiggles painted with the CSS Highlight API — the same machinery as
   search — and a right-click menu for suggestions. Chapters scan lazily
   as the caret reaches them. */
let spellOn = false;
let spellScanned = new Set();
let spellRanges = new Map(); // key → [Range]
const spellCache = new Map(); // word → correct?

const spellNorm = (w) => w.replace(/’/g, "'").replace(/^'+|'+$/g, "");

function spellElFor(key) {
  return key.startsWith("aux-")
    ? $("#aux-editor")
    : document.querySelector(`.chapter[data-id="${key}"] .chapter-body`);
}

async function spellScanEl(el, key) {
  if (!el || !spellOn) return;
  spellScanned.add(key);
  const occurrences = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  // letters of any alphabet, with their accents, so French and German
  // words reach the dictionary whole
  const re = /[\p{L}\p{M}'’]+/gu;
  let n;
  while ((n = walker.nextNode())) {
    const p = n.parentElement;
    if (p && p.closest(".scene-break, .ghost, .ph-mark")) continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(n.data))) {
      const word = spellNorm(m[0]);
      if (word.length < 2) continue;
      if (/^[\p{Lu}'’]+$/u.test(m[0])) continue; // acronyms and shouting are legal
      occurrences.push({ node: n, start: m.index, end: m.index + m[0].length, word });
    }
  }
  const unknown = [...new Set(occurrences.map((o) => o.word))].filter(
    (w) => !spellCache.has(w),
  );
  if (unknown.length) {
    const res = await window.neo.spellCheckWords(unknown);
    for (const w of unknown) spellCache.set(w, res[w] !== false);
  }
  if (!spellOn) return; // toggled off while we were checking
  const ranges = [];
  for (const o of occurrences) {
    if (spellCache.get(o.word) || !o.node.isConnected) continue;
    try {
      const r = new Range();
      r.setStart(o.node, o.start);
      r.setEnd(o.node, o.end);
      ranges.push(r);
    } catch {
      /* node changed underneath us */
    }
  }
  spellRanges.set(key, ranges);
  rebuildSpellHighlight();
}

function rebuildSpellHighlight() {
  if (!spellOn) return;
  const hl = new Highlight();
  for (const list of spellRanges.values()) for (const r of list) hl.add(r);
  CSS.highlights.set("neo-spell", hl);
}

function scanSpellingIn(el, key) {
  if (!el || spellScanned.has(key)) return;
  spellScanEl(el, key);
}

// scan wherever the writer currently is
function scanSpellingHere() {
  if (currentTab === "manuscript") {
    const body = currentChapterId && spellElFor(currentChapterId);
    if (body) scanSpellingIn(body, currentChapterId);
  } else {
    scanSpellingIn(
      $("#aux-editor"),
      "aux-" + ($("#aux-editor").dataset.kind || "notes"),
    );
  }
}

function scheduleSpellRescan(key, el) {
  clearTimeout(saveTimers["sp-" + key]);
  saveTimers["sp-" + key] = setTimeout(() => {
    if (spellOn) spellScanEl(el, key);
  }, 600);
}

function toggleSpellcheck() {
  spellOn = !spellOn;
  if (spellOn) {
    spellScanned = new Set();
    spellRanges = new Map();
    scanSpellingHere();
  } else {
    CSS.highlights.delete("neo-spell");
    spellRanges = new Map();
    document.querySelector(".spell-menu")?.remove();
  }
  toast(spellOn ? "Spellcheck on" : "Spellcheck off");
}

// Edit → Spellcheck Language: swap the dictionary, remember the choice with
// the library, and re-check whatever is on screen
const SPELL_LANGUAGE_NAMES = {
  'en-US': 'US English', 'en-GB': 'UK English', 'en-CA': 'Canadian English',
  'en-AU': 'Australian English', fr: 'French', es: 'Spanish', de: 'German'
};
async function changeSpellLanguage(code) {
  const ok = await window.neo.setSpellLanguage(code);
  if (!ok) { toast('That dictionary would not load'); return; }
  library.spellLanguage = code;
  await window.neo.writeLibrary(library);
  spellCache.clear();
  if (spellOn) {
    spellScanned = new Set();
    spellRanges = new Map();
    CSS.highlights.delete('neo-spell');
    scanSpellingHere();
  }
  toast('Spellcheck: ' + (SPELL_LANGUAGE_NAMES[code] || code));
}

// right-click a flagged word for suggestions
document.addEventListener("contextmenu", async (e) => {
  if (!spellOn) return;
  const editor =
    e.target.closest && e.target.closest(".chapter-body, #aux-editor");
  if (!editor) return;
  const pos = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!pos || pos.startContainer.nodeType !== Node.TEXT_NODE) return;
  const node = pos.startContainer;
  const text = node.data;
  const isW = (c) => /[\p{L}\p{M}'’]/u.test(c);
  let a = pos.startOffset, b = pos.startOffset;
  while (a > 0 && isW(text[a - 1])) a--;
  while (b < text.length && isW(text[b])) b++;
  if (a === b) return;
  const word = spellNorm(text.slice(a, b));
  if (spellCache.get(word) !== false) return; // only flagged words get our menu
  e.preventDefault();
  const chEl = editor.closest ? editor.closest(".chapter") : null;
  const key =
    editor.id === "aux-editor"
      ? "aux-" + (editor.dataset.kind || "notes")
      : chEl
        ? chEl.dataset.id
        : null;
  const sugg = await window.neo.spellSuggest(word);
  showSpellMenu(e.clientX, e.clientY, word, sugg, {
    replace: (s) => {
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(node, a);
      r.setEnd(node, b);
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand("insertText", false, s);
      if (key) spellScanEl(spellElFor(key), key);
    },
    learn: async () => {
      library.customWords = library.customWords || [];
      if (!library.customWords.includes(word)) library.customWords.push(word);
      await window.neo.writeLibrary(library);
      await window.neo.spellLearn(word);
      spellCache.set(word, true);
      for (const k of [...spellScanned]) spellScanEl(spellElFor(k), k);
    },
  });
});

function showSpellMenu(x, y, word, suggestions, actions) {
  document.querySelector(".spell-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "spell-menu";
  if (suggestions.length) {
    for (const s of suggestions) {
      const btn = document.createElement("button");
      btn.textContent = s;
      btn.onclick = () => {
        menu.remove();
        actions.replace(s);
      };
      menu.appendChild(btn);
    }
  } else {
    const none = document.createElement("button");
    none.textContent = "No suggestions";
    none.disabled = true;
    menu.appendChild(none);
  }
  const sep = document.createElement("div");
  sep.className = "sm-sep";
  menu.appendChild(sep);
  const learn = document.createElement("button");
  learn.textContent = `Add “${word}” to dictionary`;
  learn.onclick = () => {
    menu.remove();
    actions.learn();
  };
  menu.appendChild(learn);
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

/* ================================================================== */
/*  REVISION PASS                                                      */
/*  An editing lens, never a nag: nothing shows until the writer asks  */
/*  (Edit → Revision Pass), and Esc puts it away. Offline, no AI.      */
/*  Echoes      — the same word again within a few lines               */
/*  Filler      — words that usually add nothing (just, really, …)    */
/*  -ly adverbs — worth a second look, not a rule                      */
/*  Names       — a rare spelling of a name used elsewhere in the book */
/*  Painted with the CSS Highlight API, like the spellcheck pass.      */
/* ================================================================== */

let revisionOn = false;
let revisionScanned = new Set();
let revisionFlags = new Map(); // chId → [{ range, kind, word, note }]
let revisionIgnored = new Set(); // lowercase words the writer waved off this session
let revisionNames = new Map(); // variant → { canon, variantCount, canonCount }

const REVISION_ECHO_WINDOW = 40; // words
const REVISION_STOP = new Set(("a about above after again against all almost also although always am an and another any " +
  "are around as at back be because been before being below between both but by came can come could did do does doing done down " +
  "during each even ever every few for from get got had has have having he her here hers herself him himself his how i if in into " +
  "is it its itself just know like made make many may me might more most much must my myself never no nor not now of off on once " +
  "one only or other our ours out over own said same say says see she should so some still such than that the their theirs them " +
  "themselves then there these they thing things this those though through to too under until up upon us very was way we well were " +
  "what when where which while who whom why will with would yes yet you your yours yourself back look looked away eyes going went " +
  "into onto").split(" "));
const REVISION_FILLER = ["just", "really", "very", "quite", "rather", "somewhat", "actually", "basically", "literally",
  "suddenly", "simply", "totally", "completely", "definitely", "certainly", "truly", "seemingly", "began to", "started to",
  "seemed to", "sort of", "kind of", "a bit", "a little", "in order to"];
const REVISION_NOT_ADVERB = new Set(("only family early reply apply supply fly belly bully jelly rally ally holy ugly lovely " +
  "lonely friendly lively likely unlikely daily weekly monthly yearly hourly nightly silly chilly hilly curly burly surly costly " +
  "deadly elderly orderly oily woolly wily jolly folly holly lily sly butterfly dragonfly assembly anomaly italy july rely comply " +
  "imply multiply homily doily melancholy dally sully tally gully july emily molly sally kelly billy reilly ally gangly ghastly " +
  "ghostly godly heavenly homely kindly leisurely manly motherly fatherly brotherly sisterly neighborly portly prickly queenly " +
  "saintly scholarly shapely sickly smelly stately timely ugly unruly wobbly wrinkly bubbly cuddly giggly grisly grizzly " +
  "measly miserly niggardly northerly southerly easterly westerly pearly poly rascally squiggly steely stingy scaly bodily").split(" "));

function revisionCanon(text) {
  return text.toLowerCase().replace(/’/g, "'").replace(/'s$/, "");
}

// Collect the prose text nodes of a chapter body, skipping outline ghosts,
// placeholders and scene breaks — the same exclusions the spell pass uses.
function revisionTextNodes(el) {
  const nodes = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const p = n.parentElement;
    if (p && p.closest(".scene-break, .ghost, .ph-mark")) continue;
    nodes.push(n);
  }
  return nodes;
}

// Capitalized words, noting which sit mid-sentence. A word counts as a name
// if it's ever capitalized mid-sentence, or never appears in lowercase.
function revisionNameTokens(text) {
  const out = [];
  const re = /[A-Z][a-z]+(?:[’'][a-z]+)?/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index).replace(/[\s"“”‘’'(—–-]+$/, "");
    out.push({ name: m[0].replace(/[’']s$/, ""), mid: !!before && !/[.!?…:]$/.test(before) });
  }
  return out;
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Across the whole book: a spelling used far less often than a near-identical
// one ("Katharine" 2×, "Katherine" 40×) is probably a slip.
function buildRevisionNames() {
  const counts = new Map();
  const midSentence = new Set();
  const lowercase = new Set();
  const holder = document.createElement("div");
  for (const chId of book.chapterOrder) {
    holder.innerHTML = chapterHTML[chId] || "";
    holder.querySelectorAll(".ghost, .ph-mark, .scene-break").forEach((n) => n.remove());
    for (const p of holder.querySelectorAll("p")) {
      const text = p.textContent;
      for (const w of text.match(/\b[a-z][a-z’']*/g) || []) lowercase.add(w);
      for (const { name, mid } of revisionNameTokens(text)) {
        counts.set(name, (counts.get(name) || 0) + 1);
        if (mid) midSentence.add(name);
      }
    }
  }
  const names = [...counts.keys()].filter((n) => n.length >= 4 && (midSentence.has(n) || !lowercase.has(n.toLowerCase())));
  revisionNames = new Map();
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (a[0] !== b[0]) continue;
      const limit = Math.min(a.length, b.length) >= 7 ? 2 : 1;
      if (editDistance(a, b) > limit) continue;
      if (a + "s" === b || b + "s" === a) continue; // plural or possessive, not a variant
      const [rare, common] = counts.get(a) <= counts.get(b) ? [a, b] : [b, a];
      if (counts.get(common) < 3 || counts.get(rare) * 3 > counts.get(common)) continue;
      revisionNames.set(rare, { canon: common, variantCount: counts.get(rare), canonCount: counts.get(common) });
    }
  }
}

function revisionScan(el, chId) {
  if (!el || !revisionOn) return;
  revisionScanned.add(chId);
  const flags = [];
  const addFlag = (node, start, end, kind, word, note) => {
    try {
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, end);
      flags.push({ range, kind, word, note });
    } catch { /* node changed underneath us */ }
  };

  const tokens = []; // every word in reading order, for echoes
  const capitalized = new Map();
  for (const node of revisionTextNodes(el)) {
    const text = node.data;
    const wordRe = /[A-Za-z][A-Za-z’']*/g;
    let m;
    while ((m = wordRe.exec(text))) {
      const word = m[0];
      const canon = revisionCanon(word);
      tokens.push({ node, start: m.index, end: m.index + word.length, word, canon });
      if (/^[A-Z]/.test(word)) capitalized.set(canon, (capitalized.get(canon) || 0) + 1);
      if (revisionIgnored.has(canon)) continue;
      if (/ly$/i.test(word) && word.length > 4 && !REVISION_NOT_ADVERB.has(canon) && !REVISION_FILLER.includes(canon)) {
        addFlag(node, m.index, m.index + word.length, "adverb", word, "An -ly adverb. Is there a stronger verb?");
      }
      const bare = word.replace(/[’']s$/, "");
      const variant = revisionNames.get(bare);
      if (variant && !revisionIgnored.has(bare.toLowerCase())) {
        addFlag(node, m.index, m.index + bare.length, "name", bare,
          `Used ${variant.variantCount}× in this book; “${variant.canon}” is used ${variant.canonCount}×.`);
      }
    }
    for (const phrase of REVISION_FILLER) {
      if (revisionIgnored.has(phrase)) continue;
      const re = new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "gi");
      while ((m = re.exec(text))) addFlag(node, m.index, m.index + m[0].length, "filler", m[0], "Often cuts cleanly.");
    }
  }

  // Echoes: a meaningful word (not a name) repeated within the window.
  const lastSeen = new Map();
  const echoed = new Set();
  const uses = new Map();
  for (const t of tokens) uses.set(t.canon, (uses.get(t.canon) || 0) + 1);
  tokens.forEach((t, i) => {
    if (t.canon.length < 4 || REVISION_STOP.has(t.canon) || revisionIgnored.has(t.canon)) return;
    const caps = capitalized.get(t.canon) || 0;
    if (caps > uses.get(t.canon) / 2) return; // mostly capitalized: a name or a title
    const prev = lastSeen.get(t.canon);
    if (prev !== undefined && i - prev <= REVISION_ECHO_WINDOW) {
      const gap = i - prev;
      for (const k of [prev, i]) {
        if (echoed.has(k)) continue;
        echoed.add(k);
        const e = tokens[k];
        addFlag(e.node, e.start, e.end, "echo", e.word, `“${t.word.toLowerCase()}” again within ${gap} words.`);
      }
    }
    lastSeen.set(t.canon, i);
  });

  revisionFlags.set(chId, flags);
  paintRevision();
}

const REVISION_KINDS = ["echo", "filler", "adverb", "name"];
function paintRevision() {
  if (!revisionOn) return;
  const lights = Object.fromEntries(REVISION_KINDS.map((k) => [k, new Highlight()]));
  for (const flags of revisionFlags.values()) {
    for (const f of flags) if (f.range.startContainer.isConnected) lights[f.kind].add(f.range);
  }
  for (const k of REVISION_KINDS) CSS.highlights.set("neo-rev-" + k, lights[k]);
}

function revisionCounts(chId) {
  const counts = { echo: 0, filler: 0, adverb: 0, name: 0 };
  for (const f of revisionFlags.get(chId) || []) counts[f.kind]++;
  return counts;
}

function revisionScanHere() {
  if (!revisionOn || currentTab !== "manuscript" || !currentChapterId) return;
  if (revisionScanned.has(currentChapterId)) return;
  revisionScan(spellElFor(currentChapterId), currentChapterId);
}

function scheduleRevisionRescan(chId, el) {
  clearTimeout(saveTimers["rev-" + chId]);
  saveTimers["rev-" + chId] = setTimeout(() => {
    if (revisionOn) revisionScan(el, chId);
  }, 700);
}

function toggleRevisionPass(force) {
  const next = typeof force === "boolean" ? force : !revisionOn;
  if (next === revisionOn) return;
  revisionOn = next;
  revisionScanned = new Set();
  revisionFlags = new Map();
  document.querySelector(".revision-menu")?.remove();
  if (!revisionOn) {
    for (const k of REVISION_KINDS) CSS.highlights.delete("neo-rev-" + k);
    toast("Revision pass off");
    return;
  }
  if (!book || currentTab !== "manuscript") {
    revisionOn = false;
    toast("Open a manuscript to run a revision pass");
    return;
  }
  buildRevisionNames();
  revisionScanHere();
  const c = revisionCounts(currentChapterId);
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  toast(`Revision pass: ${n(c.echo, "echo", "echoes")} · ${n(c.filler, "filler", "fillers")} · ${n(c.adverb, "-ly adverb", "-ly adverbs")} · ${n(c.name, "name slip", "name slips")} in this chapter. Right-click a mark to see why; Esc ends the pass.`, 7000);
}

// right-click a revision mark: say why, offer to ignore that word
document.addEventListener("contextmenu", (e) => {
  if (!revisionOn || e.defaultPrevented) return; // a spelling mark gets the spelling menu
  const body = e.target.closest && e.target.closest(".chapter-body");
  if (!body) return;
  const pos = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!pos) return;
  const chId = body.closest(".chapter").dataset.id;
  const hits = (revisionFlags.get(chId) || []).filter((f) => {
    try { return f.range.isPointInRange(pos.startContainer, pos.startOffset); } catch { return false; }
  });
  if (!hits.length) return;
  e.preventDefault();
  document.querySelector(".revision-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "spell-menu revision-menu";
  const labels = { echo: "Echo", filler: "Filler", adverb: "-ly adverb", name: "Name variant" };
  for (const f of hits) {
    const info = document.createElement("button");
    info.disabled = true;
    info.textContent = `${labels[f.kind]}: ${f.note}`;
    menu.appendChild(info);
  }
  const sep = document.createElement("div");
  sep.className = "sm-sep";
  menu.appendChild(sep);
  const word = hits[0].kind === "filler" ? hits[0].word.toLowerCase().replace(/\s+/g, " ") : revisionCanon(hits[0].word);
  const ignore = document.createElement("button");
  ignore.textContent = `Ignore “${hits[0].kind === "name" ? hits[0].word : word}” this session`;
  ignore.onclick = () => {
    menu.remove();
    revisionIgnored.add(word);
    revisionScanned = new Set();
    revisionScan(body, chId);
  };
  menu.appendChild(ignore);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, window.innerWidth - r.width - 10) + "px";
  menu.style.top = Math.min(e.clientY + 4, window.innerHeight - r.height - 10) + "px";
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener("mousedown", close, true);
  };
  document.addEventListener("mousedown", close, true);
});

/* ================================================================== */
/*  READ ALOUD                                                         */
/*  Hearing prose catches what reading skips. Uses the computer's own  */
/*  voices (offline). Reads the selection, or from the caret to the    */
/*  end of the chapter, one sentence at a time, lighting the sentence  */
/*  being read. Any key, a click, or Esc stops it.                     */
/* ================================================================== */

let reading = null; // { queue: [{ range, text }], index, token }

// Sentences inside one paragraph, as DOM ranges.
function sentenceRanges(p, fromNode = null, fromOffset = 0) {
  const nodes = [];
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.parentElement && n.parentElement.closest(".ph-mark, .ghost")) continue;
    nodes.push(n);
  }
  let text = "";
  const starts = [];
  let skip = 0;
  for (const node of nodes) {
    if (node === fromNode) skip = text.length + fromOffset;
    starts.push(text.length);
    text += node.data;
  }
  const at = (offset) => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > offset) i--;
    return [nodes[i], Math.min(offset - starts[i], nodes[i].data.length)];
  };
  const out = [];
  const re = /[^.!?…]+(?:[.!?…]+["”’)\]]*|$)\s*/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    const end = m.index + m[0].trimEnd().length;
    if (end <= skip) continue;
    const start = m.index; // the caret's whole sentence, not half of it
    const said = text.slice(start, end).trim();
    if (!/[A-Za-z0-9]/.test(said)) continue;
    const range = new Range();
    range.setStart(...at(start));
    range.setEnd(...at(end));
    out.push({ range, text: said });
  }
  return out;
}

function readAloudQueue() {
  const sel = window.getSelection();
  const body = currentChapterId && document.querySelector(`.chapter[data-id="${currentChapterId}"] .chapter-body`);
  if (!body) return [];
  // a selection: read exactly that, paragraph by paragraph
  if (sel && sel.rangeCount && !sel.isCollapsed && body.closest(".chapter").contains(sel.anchorNode)) {
    const picked = sel.getRangeAt(0);
    const queue = [];
    for (const p of body.querySelectorAll("p:not(.scene-break):not(.ghost)")) {
      if (!picked.intersectsNode(p)) continue;
      for (const s of sentenceRanges(p)) {
        const r = s.range.cloneRange();
        if (picked.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(picked.startContainer, picked.startOffset);
        if (picked.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(picked.endContainer, picked.endOffset);
        if (r.collapsed) continue;
        const said = r.toString().trim();
        if (/[A-Za-z0-9]/.test(said)) queue.push({ range: r, text: said });
      }
    }
    return queue;
  }
  // otherwise: from the caret to the end of the chapter
  let startP = null, node = null, offset = 0;
  if (sel && sel.rangeCount && body.contains(sel.anchorNode)) {
    node = sel.anchorNode;
    offset = sel.anchorOffset;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    startP = el && el.closest("p");
    if (node.nodeType !== Node.TEXT_NODE) node = null;
  }
  const paras = [...body.querySelectorAll("p:not(.scene-break):not(.ghost)")];
  let i = startP ? Math.max(0, paras.indexOf(startP)) : 0;
  const queue = [];
  for (; i < paras.length; i++) {
    const first = paras[i] === startP;
    queue.push(...sentenceRanges(paras[i], first ? node : null, first ? offset : 0));
  }
  return queue;
}

function stopReadAloud(quiet = false) {
  if (!reading) return;
  reading = null;
  window.speechSynthesis.cancel();
  CSS.highlights.delete("neo-reading");
  if (!quiet) toast("Stopped reading");
}

function readNextSentence(token) {
  if (!reading || reading.token !== token) return;
  const item = reading.queue[reading.index];
  if (!item) {
    stopReadAloud(true);
    toast("Finished reading");
    return;
  }
  CSS.highlights.set("neo-reading", new Highlight(item.range));
  const rect = item.range.getBoundingClientRect();
  if (rect.top < 80 || rect.bottom > window.innerHeight - 120) {
    const scroller = $("#paper-scroll");
    scroller.scrollBy({ top: rect.top - window.innerHeight / 3, behavior: "smooth" });
  }
  const u = readAloudUtterance(item.text);
  u.onend = () => {
    if (!reading || reading.token !== token) return;
    reading.index++;
    readNextSentence(token);
  };
  u.onerror = (e) => {
    if (!reading || reading.token !== token || e.error === "interrupted" || e.error === "canceled") return;
    stopReadAloud(true);
    toast("This computer’s voice couldn’t read that");
  };
  window.speechSynthesis.speak(u);
}

// The writer's chosen voice and speed (Progress & Settings → Read Aloud).
// Voice names are per computer; an unknown one falls back to the default.
function readAloudUtterance(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = Math.min(2, Math.max(0.5, Number(library.readAloudRate) || 1));
  const voice = library.readAloudVoice && window.speechSynthesis.getVoices().find((v) => v.name === library.readAloudVoice);
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  return u;
}

function readAloudSettingsHtml() {
  const rate = Math.min(2, Math.max(0.5, Number(library.readAloudRate) || 1));
  return `
      <div class="stats-section readaloud-settings">
        <h3>Read Aloud</h3>
        <div class="stats-row">
          <label>Voice <select id="ra-voice"><option value="">System default</option></select></label>
          <label>Speed <span class="ra-rate-row"><input id="ra-rate" type="range" min="0.5" max="2" step="0.1" value="${rate}"/><span id="ra-rate-label">${rate.toFixed(1)}×</span></span></label>
        </div>
        <div class="sync-actions"><button id="ra-test" class="btn-quiet">Hear a sample</button><span class="soft" style="font-size:12px">Edit → Read Aloud (${K("⌘⇧R", "Ctrl+Shift+R")}) · any key stops it</span></div>
      </div>`;
}

function bindReadAloudSettings(bd) {
  const select = bd.querySelector("#ra-voice");
  const rate = bd.querySelector("#ra-rate");
  if (!select || !("speechSynthesis" in window)) {
    bd.querySelector(".readaloud-settings")?.remove();
    return () => {};
  }
  const fill = () => {
    const voices = window.speechSynthesis.getVoices();
    const current = select.value || library.readAloudVoice || "";
    select.innerHTML = '<option value="">System default</option>' + voices
      .slice().sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))
      .map((v) => `<option value="${escHtml(v.name)}">${escHtml(v.name)} (${escHtml(v.lang)})</option>`).join("");
    select.value = voices.some((v) => v.name === current) ? current : "";
  };
  fill();
  window.speechSynthesis.addEventListener("voiceschanged", fill);
  rate.addEventListener("input", () => {
    bd.querySelector("#ra-rate-label").textContent = Number(rate.value).toFixed(1) + "×";
  });
  const apply = () => {
    library.readAloudVoice = select.value || "";
    library.readAloudRate = Number(rate.value) || 1;
  };
  bd.querySelector("#ra-test").onclick = () => {
    apply();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(readAloudUtterance("It was a dark and stormy night. This is how your pages will sound."));
  };
  return () => {
    apply();
    window.speechSynthesis.removeEventListener("voiceschanged", fill);
    window.speechSynthesis.cancel();
  };
}

function toggleReadAloud() {
  if (reading) return stopReadAloud();
  if (!("speechSynthesis" in window)) return toast("Read Aloud isn’t available on this computer");
  if (!book || currentTab !== "manuscript") return toast("Open a manuscript to read it aloud");
  const queue = readAloudQueue();
  if (!queue.length) return toast("Nothing to read from here");
  window.speechSynthesis.cancel();
  reading = { queue, index: 0, token: Symbol("read") };
  toast("Reading aloud. Press any key to stop", 3000);
  readNextSentence(reading.token);
}

// Any key or click stops the reading; the key itself still does its job,
// except Esc, which only stops.
document.addEventListener("keydown", (e) => {
  if (!reading) return;
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyR") return; // the menu toggles it
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); }
  stopReadAloud();
}, true);
document.addEventListener("mousedown", () => { if (reading) stopReadAloud(); }, true);

/* ---------- Focus mode (View → Focus Mode) ---------- */
// Everything but the paragraph you're in fades back. Off by default; the
// page itself doesn't change, and the choice is remembered.
let focusModeOn = false;
let focusPara = null;

function markFocusParagraph(p) {
  if (p === focusPara) return;
  if (focusPara && focusPara.isConnected) {
    focusPara.classList.remove("focus-current");
    if (!focusPara.classList.length) focusPara.removeAttribute("class");
  }
  focusPara = p || null;
  if (focusPara) focusPara.classList.add("focus-current");
}

function applyFocusMode() {
  document.body.classList.toggle("focus-mode", focusModeOn);
  if (!focusModeOn) markFocusParagraph(null);
  else {
    const sel = window.getSelection();
    const node = sel && sel.anchorNode;
    const el = node && (node.nodeType === Node.TEXT_NODE ? node.parentElement : node);
    const p = el && el.closest && el.closest(".chapter-body > p");
    markFocusParagraph(p);
  }
}

function toggleFocusMode() {
  focusModeOn = !focusModeOn;
  library.focusMode = focusModeOn;
  window.neo.writeLibrary(library);
  applyFocusMode();
  toast(focusModeOn ? "Focus mode on" : "Focus mode off");
}

let typewriterEnabled = false;
// The page needs empty room beneath its last line, or the caret can't be held
// at the centre once the end of the draft scrolls into view (body.typewriter
// deepens #paper's bottom margin; see styles.css).
function applyTypewriter() {
  document.body.classList.toggle("typewriter", typewriterEnabled);
}
function toggleTypewriter() {
  typewriterEnabled = !typewriterEnabled;
  library.typewriter = typewriterEnabled;
  window.neo.writeLibrary(library);
  applyTypewriter();
  toast(
    typewriterEnabled
      ? "Typewriter scrolling ON — your line stays centered"
      : "Typewriter scrolling off",
  );
}

document.addEventListener("selectionchange", () => {
  if (!typewriterEnabled || !book || currentTab !== "manuscript") return;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  let el = sel.anchorNode;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  if (!el || !el.closest || !el.closest(".chapter-body")) return;
  requestAnimationFrame(() => {
    try {
      let rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.top === 0 && rect.height === 0))
        rect = el.getBoundingClientRect();
      const diff = rect.top - window.innerHeight * 0.45;
      if (Math.abs(diff) > 6) $("#paper-scroll").scrollTop += diff;
    } catch {
      /* selection mid-mutation; skip this frame */
    }
  });
});

/* ================================================================== */
/*  GOALS, SPRINTS, AND THE CHART                                      */
/* ================================================================== */

let sprint = null;
let sprintTimer = null;

function formatDuration(seconds) {
  const mins = Math.floor(Math.max(0, seconds) / 60);
  const secs = Math.max(0, seconds) % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function goalPace(total = bookWordCount()) {
  const goal = book.wordGoal || 0;
  const due = book.goalDueDate
    ? new Date(`${book.goalDueDate}T12:00:00`)
    : null;
  if (!goal || !due || Number.isNaN(due.valueOf())) return null;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Math.max(1, Math.ceil((due - today) / 86400000) + 1);
  const remaining = Math.max(0, goal - total);
  return {
    days,
    remaining,
    daily: Math.ceil(remaining / days),
    weekly: Math.ceil((remaining / days) * 7),
    due,
  };
}

function effectiveDailyTarget(total = bookWordCount()) {
  const pace = goalPace(total);
  return pace ? pace.daily : library.dailyGoal || 0;
}

function finishSprint(message) {
  if (!sprint || sprint.done) return;
  sprint.done = true;
  clearInterval(sprintTimer);
  sprintTimer = null;
  $("#bottombar").classList.add("attn", "sprint-finished");
  setTimeout(
    () => $("#bottombar").classList.remove("attn", "sprint-finished"),
    3400,
  );
  toast(message, 6000);
  updateSprintControls();
  updateCounters();
}

function updateSprintCounter(total = bookWordCount()) {
  if (!sprint || sprint.done) return false;
  if (!pluginEnabled("sprints")) { endSprintQuietly(); return false; }
  const gc = $("#goal-counter");
  if (sprint.mode === "timer") {
    if (sprint.paused) {
      gc.textContent = `Paused · ${formatDuration(Math.ceil(sprint.remainingMs / 1000))}`;
      return true;
    }
    const seconds = Math.ceil((sprint.endsAt - Date.now()) / 1000);
    if (seconds <= 0) {
      finishSprint(
        "Time — take a breath, then keep the words that are coming.",
      );
      return false;
    }
    gc.textContent = formatDuration(seconds);
    return true;
  }
  const words = total - sprint.startCount;
  gc.textContent = `⚡ ${words.toLocaleString()} / ${sprint.target.toLocaleString()}`;
  if (words >= sprint.target) {
    finishSprint(
      `Sprint complete — ${words.toLocaleString()} words. Well earned.`,
    );
    return false;
  }
  return true;
}

function startSprint(mode, amount) {
  const total = bookWordCount();
  sprint = {
    mode,
    target: mode === "words" ? amount : null,
    startCount: total,
    startTime: Date.now(),
    endsAt: mode === "timer" ? Date.now() + amount * 60000 : null,
    remainingMs: mode === "timer" ? amount * 60000 : null,
    paused: false,
    done: false,
  };
  clearInterval(sprintTimer);
  sprintTimer = setInterval(() => updateSprintCounter(), 1000);
  updateSprintCounter(total);
  updateSprintControls();
  toast(
    mode === "timer"
      ? `${amount}-minute writing timer started.`
      : `Sprint started — ${amount.toLocaleString()} words. Go.`,
  );
}

function updateSprintControls() {
  const controls = $("#sprint-controls");
  if (!controls) return;
  const activeTimer = sprint && !sprint.done && sprint.mode === "timer";
  controls.hidden = !activeTimer;
  if (activeTimer) {
    $("#sprint-pause").textContent = sprint.paused ? "▶" : "⏸";
    $("#sprint-pause").title = sprint.paused ? "Resume timer" : "Pause timer";
  }
}

function toggleTimerPause() {
  if (!sprint || sprint.done || sprint.mode !== "timer") return;
  if (sprint.paused) {
    sprint.endsAt = Date.now() + sprint.remainingMs;
    sprint.paused = false;
    clearInterval(sprintTimer);
    sprintTimer = setInterval(() => updateSprintCounter(), 1000);
  } else {
    sprint.remainingMs = Math.max(0, sprint.endsAt - Date.now());
    sprint.paused = true;
    clearInterval(sprintTimer);
    sprintTimer = null;
  }
  updateSprintControls();
  updateCounters();
}

// The plugin was removed (or the pen name changed) mid-sprint: no toast,
// no flash, the counter simply goes back to today's words.
function endSprintQuietly() {
  if (!sprint) return;
  clearInterval(sprintTimer);
  sprintTimer = null;
  sprint = null;
  updateSprintControls();
}

function stopSprint() {
  if (!sprint || sprint.done) return;
  const got = bookWordCount() - sprint.startCount;
  clearInterval(sprintTimer);
  sprintTimer = null;
  sprint = null;
  updateSprintControls();
  updateCounters();
  toast(`Sprint stopped — ${got.toLocaleString()} words saved.`, 4000);
}

function statsChartSvg() {
  const W = 520, H = 170, PAD = 6;
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(writingDay(d)); }
  const daily = days.map((d) => Math.max(0, dailyWords(d)));
  const cumulative = cumulativeWordSeries(days);
  const goal = book.wordGoal || 0;
  const mode = book.goalChartMode || "daily";
  const dailyTarget = effectiveDailyTarget();
  const maxD = Math.max(...daily, dailyTarget, 1);
  let maxC = Math.max(...cumulative, goal, 1);
  const bw = (W - PAD * 2) / 30;
  const due = book.goalDueDate ? new Date(`${book.goalDueDate}T12:00:00`) : null;
  const firstIndex = daily.findIndex((words) => words !== 0);
  const baseline = firstIndex >= 0 ? cumulative[firstIndex] - daily[firstIndex] : cumulative[0];
  const startDate = new Date(`${days[Math.max(0, firstIndex)]}T12:00:00`);
  const planned = mode === "cumulative" && due && goal && due > startDate
    ? days.map((d) => { const point = new Date(`${d}T12:00:00`); const fraction = Math.max(0, Math.min(1, (point - startDate) / (due - startDate))); return baseline + (goal - baseline) * fraction; })
    : null;
  if (planned) maxC = Math.max(maxC, ...planned);
  const bars = mode === "daily" ? daily.map((v, i) => {
    const h = Math.max(2, Math.round((v / maxD) * (mode === "daily" ? H - PAD * 2 - 20 : H * 0.45)));
    const label = new Date(`${days[i]}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<rect class="stats-bar" x="${(PAD + i * bw).toFixed(1)}" y="${H - PAD - h}" width="${(bw - 2).toFixed(1)}" height="${h}" rx="1.5" fill="#3d5a4f" tabindex="0" data-label="${label}" data-words="${v.toLocaleString()}" aria-label="${label}: ${v.toLocaleString()} words"></rect>`;
  }).join("") : "";
  const line = mode === "cumulative" ? cumulative.map((v, i) => {
    const x = (PAD + i * bw + bw / 2).toFixed(1);
    const y = (H - PAD - (v / maxC) * (H - PAD * 2 - 20)).toFixed(1);
    return (i === 0 ? "M" : "L") + x + "," + y;
  }).join(" ") : "";
  const paceLine = planned ? `<path d="${planned.map((v, i) => `${i === 0 ? "M" : "L"}${(PAD + i * bw + bw / 2).toFixed(1)},${(H - PAD - (v / maxC) * (H - PAD * 2 - 20)).toFixed(1)}`).join(" ")}" fill="none" stroke="#8d8778" stroke-dasharray="4,4" stroke-width="1.5"/>` : "";
  const goalLine = mode === "daily" && dailyTarget
    ? `<line x1="${PAD}" x2="${W - PAD}" y1="${(H - PAD - (dailyTarget / maxD) * (H - PAD * 2 - 20)).toFixed(1)}" y2="${(H - PAD - (dailyTarget / maxD) * (H - PAD * 2 - 20)).toFixed(1)}" stroke="#c9a86a" stroke-dasharray="5,4" stroke-width="1.5"/>`
    : mode === "cumulative" && goal ? `<line x1="${PAD}" x2="${W - PAD}" y1="${(H - PAD - (goal / maxC) * (H - PAD * 2 - 20)).toFixed(1)}" y2="${(H - PAD - (goal / maxC) * (H - PAD * 2 - 20)).toFixed(1)}" stroke="#c9a86a" stroke-dasharray="5,4" stroke-width="1.5"/>` : "";
  const axisLabels = mode === "daily" ? `<text x="8" y="18" fill="#aaa" font-size="10">${maxD.toLocaleString()}</text><text x="8" y="${H - 10}" fill="#777" font-size="10">0</text>` : `<text x="8" y="18" fill="#aaa" font-size="10">${maxC.toLocaleString()}</text><text x="8" y="${H - 10}" fill="#777" font-size="10">0</text>`;
  return `<svg id="stats-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${axisLabels}${bars}<path d="${line}" fill="none" stroke="#c9a86a" stroke-width="2"/>${paceLine}${goalLine}<g class="chart-tooltip" hidden><rect rx="3" fill="#292722" stroke="#c9a86a" stroke-width="0.7"></rect><text fill="#eee" font-size="11" text-anchor="middle"></text></g></svg>
  <div style="display:flex;justify-content:space-between;font-size:10px;color:#666;padding:2px 4px"><span>30 days ago</span><span style="color:#3d8a6a">▮ daily words</span><span style="color:var(--accent)">${mode === "daily" ? "- - daily target" : "— total · - - goal"}${planned ? " · pace" : ""}</span><span>today</span></div>`;
}

function bindStatsChart(root) {
  const svg = root.querySelector("#stats-chart");
  if (!svg) return;
  const tip = svg.querySelector(".chart-tooltip"), text = tip.querySelector("text"), rect = tip.querySelector("rect");
  const show = (bar) => {
    text.textContent = `${bar.dataset.label} · ${bar.dataset.words} words`;
    const box = bar.getBBox(), x = Math.max(60, Math.min(460, box.x + box.width / 2));
    text.setAttribute("x", x); text.setAttribute("y", "22");
    const width = Math.max(104, text.getComputedTextLength() + 16);
    rect.setAttribute("x", x - width / 2); rect.setAttribute("y", "7"); rect.setAttribute("width", width); rect.setAttribute("height", "21");
    tip.removeAttribute("hidden");
  };
  svg.querySelectorAll(".stats-bar").forEach((bar) => { bar.addEventListener("pointerenter", () => show(bar)); bar.addEventListener("focus", () => show(bar)); });
  svg.addEventListener("pointerleave", () => { tip.setAttribute("hidden", ""); });
  svg.addEventListener("focusout", () => { tip.setAttribute("hidden", ""); });
}

function statsOverview() {
  const wordsToday = dailyWords(todayStr());
  const total = bookWordCount();
  const pace = goalPace(total);
  return `
    <div class="stats-nums">
      <div><div class="big">${total.toLocaleString()}</div><div class="lbl">total words</div></div>
      <div><div class="big">${wordsToday.toLocaleString()}</div><div class="lbl">today</div></div>
      <div><div class="big">${book.wordGoal ? Math.min(100, Math.round((total / book.wordGoal) * 100)) + "%" : "—"}</div><div class="lbl">of manuscript goal</div></div>
    </div>
    ${pace ? `<div class="stats-pace"><span class="pace-item"><strong>${pace.daily.toLocaleString()}</strong> / day</span><span class="pace-item"><strong>${pace.weekly.toLocaleString()}</strong> / week</span><span class="pace-item">to finish ${pace.remaining.toLocaleString()} words by ${pace.due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div>` : ""}
    ${statsChartSvg()}`;
}

function deadlinePaceText() {
  const pace = goalPace();
  return pace
    ? `Deadline pace: <strong>${pace.daily.toLocaleString()} words/day</strong> · ${pace.weekly.toLocaleString()} words/week`
    : "";
}

/* ================================================================== */
/*  COVER ART SETTINGS (File → Cover Art…)                             */
/* ================================================================== */

// One key per provider. The brief and the painting always come from the
// same provider, so a writer only ever needs one account.
const COVER_PROVIDERS = {
  openai: {
    name: "OpenAI",
    keyHint: "sk-…",
    where: "platform.openai.com → API keys",
    text: "gpt-5-mini",
    image: "gpt-image-1-mini",
    quality: true,
    cost: "a few cents a picture",
  },
};
// Key formats change under us, so the only test is "one token, long enough" —
// the provider does the rest.
const looksLikeKey = (k) => /^\S{20,}$/.test(k);
const coverSettings = () => library.coverArt || {};
const coverProvider = () =>
  COVER_PROVIDERS[coverSettings().provider]
    ? coverSettings().provider
    : "openai";

function openCoverArt() {
  const cs = coverSettings();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  const provOptions = Object.entries(COVER_PROVIDERS)
    .map(
      ([id, p]) =>
        `<option value="${id}"${coverProvider() === id ? " selected" : ""}>${p.name}</option>`,
    )
    .join("");
  bd.innerHTML = `
    <div class="modal" style="width:540px">
      <h2 style="font-size:17px">Cover art</h2>
      <p>Every book gets a cover on the shelf: an abstract with the title set in type. With an OpenAI key, NEO can also read a story once it passes ${PAINT_AT.toLocaleString()} words and paint a cover from the text. Paintings stay on your shelf — exports never include them.</p>
      <div class="stats-row">
        <select id="ca-provider" hidden>${provOptions}</select>
        <label class="st-check"><input id="ca-auto" type="checkbox"${cs.auto === false ? "" : " checked"}/> paint at ${PAINT_AT.toLocaleString()} words</label>
      </div>
      <div class="stats-row st-covers">
        <label>API key <input id="ca-key" type="password" autocomplete="off" spellcheck="false" style="width:300px"/></label>
      </div>
      <p class="soft" id="ca-note" style="margin:-6px 0 12px;font-size:12px"></p>
      <details class="st-advanced">
        <summary class="soft">Models</summary>
        <div class="stats-row">
          <label>Brief <input id="ca-tmodel" type="text" spellcheck="false"/></label>
          <label>Paint <input id="ca-imodel" type="text" spellcheck="false"/></label>
          <label id="ca-quality-wrap">Quality
            <select id="ca-quality">
              ${["low", "medium", "high"].map((q) => `<option value="${q}"${(cs.quality || "medium") === q ? " selected" : ""}>${q}</option>`).join("")}
            </select>
          </label>
        </div>
        <p class="soft" style="font-size:12px;margin:0 0 6px">Leave blank for NEO\u2019s defaults. Names drift; if a provider retires one, NEO tries its own list before giving up.</p>
      </details>
      <div style="text-align:right;margin-top:14px">
        <button class="m-cancel btn-quiet" style="margin-right:10px">Cancel</button>
        <button class="m-ok btn-gold">Save</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  const sel = bd.querySelector("#ca-provider");
  const key = bd.querySelector("#ca-key");
  const note = bd.querySelector("#ca-note");
  const models = cs.models || {};
  // per-provider fields: key placeholder, stored model overrides, quality
  const showProvider = async () => {
    const id = sel.value,
      p = COVER_PROVIDERS[id];
    key.value = "";
    key.placeholder = `${p.name} key (${p.keyHint})`;
    bd.querySelector("#ca-tmodel").value =
      (models[id] && models[id].text) || "";
    bd.querySelector("#ca-tmodel").placeholder = p.text;
    bd.querySelector("#ca-imodel").value =
      (models[id] && models[id].image) || "";
    bd.querySelector("#ca-imodel").placeholder = p.image;
    bd.querySelector("#ca-quality-wrap").style.display = p.quality
      ? ""
      : "none";
    const has = await window.neo.hasSecret(id);
    if (sel.value !== id) return;
    note.textContent = has
      ? `A ${p.name} key is saved, encrypted, outside your library folder. Paste a new one to replace it, or type \u201cremove\u201d to forget it.`
      : `Get a key at ${p.where} (${p.cost}). It\u2019s stored encrypted on this computer and only ever sent to ${p.name}.`;
  };
  sel.onchange = showProvider;
  showProvider();
  const done = () => bd.remove();
  bd.querySelector(".m-cancel").onclick = done;
  bd.querySelector(".m-ok").onclick = async () => {
    const id = sel.value,
      p = COVER_PROVIDERS[id];
    const k = key.value.trim();
    if (k === "remove") await window.neo.setSecret(id, "");
    else if (k && !looksLikeKey(k)) {
      toast(
        `That doesn\u2019t look like an API key (${p.name} keys look like ${p.keyHint}) \u2014 not saved`,
        6000,
      );
      return;
    } else if (k) await window.neo.setSecret(id, k);
    models[id] = {
      text: bd.querySelector("#ca-tmodel").value.trim() || undefined,
      image: bd.querySelector("#ca-imodel").value.trim() || undefined,
    };
    library.coverArt = {
      provider: id,
      auto: bd.querySelector("#ca-auto").checked,
      quality: bd.querySelector("#ca-quality").value,
      models,
    };
    await window.neo.writeLibrary(library);
    done();
    if (!(await window.neo.hasSecret(id)))
      toast(`Saved. Add a ${p.name} key to start painting.`, 5000);
  };
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      done();
    }
  });
  key.focus();
}

function openStats() {
  const hasBook = !!book;
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal stats-modal" style="width:600px">
      <div class="stats-modal-head"><h2 style="font-size:17px">${hasBook ? escHtml(book.title) + " — progress" : "Writing settings"}</h2><button class="m-cancel btn-quiet" title="Close">×</button></div>
      <div id="stats-overview">${hasBook ? statsOverview() : ""}</div>
      <div class="stats-section">
        <h3>${hasBook ? "Targets" : "Writing rhythm"}</h3>
        ${hasBook ? `<div class="stats-target-toggle"><button data-chart-mode="daily" class="${(book.goalChartMode || "daily") === "daily" ? "active" : ""}">Daily words</button><button data-chart-mode="cumulative" class="${(book.goalChartMode || "daily") === "cumulative" ? "active" : ""}">Total words</button></div>` : ""}
        <div class="stats-row">
          <label>Daily target <input id="st-daily" type="number" min="0" value="${library.dailyGoal || ""}" placeholder="500"/></label>
          ${hasBook ? `<label>Manuscript target <input id="st-book" type="number" min="0" value="${book.wordGoal || ""}" placeholder="80000"/></label><label>Deadline <input id="st-due" type="date" value="${book.goalDueDate || ""}"/></label>` : ""}
        </div>
        ${hasBook ? `<div id="deadline-pace" class="deadline-pace">${deadlinePaceText()}</div>` : ""}
      </div>
      <div class="stats-row stats-preferences">
        <label>My writing day ends at
          <select id="st-dayends">
            ${[0, 1, 2, 3, 4, 5, 6].map((h) => `<option value="${h}"${(library.dayEndsAt || 0) === h ? " selected" : ""}>${h ? h + " am" : "midnight"}</option>`).join("")}
          </select>
        </label>
      </div>
      ${
        hasBook && pluginEnabled("sprints")
          ? `
      <div class="stats-section">
        <h3>Writing Sprint</h3>
        <div id="st-sprint-actions" class="stats-sprint-actions">
          ${sprint && !sprint.done ? `<div class="stats-sprint-live"><span class="soft">${sprint.mode === "timer" ? (sprint.paused ? `Timer paused · ${formatDuration(Math.ceil(sprint.remainingMs / 1000))}` : `Timer running · ${formatDuration(Math.ceil((sprint.endsAt - Date.now()) / 1000))}`) : "Word sprint running"}</span>${sprint.mode === "timer" ? `<button id="st-sprint-pause">${sprint.paused ? "Resume" : "Pause"}</button>` : ""}<button id="st-sprint-end">Stop</button></div>` : `<div class="stats-sprint-option"><label>Word sprint <input id="st-sprint-words" type="number" min="50" value="500"/></label><button id="st-word-sprint">Start</button></div><div class="stats-sprint-option"><label>Timer <input id="st-sprint-minutes" type="number" min="1" value="25"/> min</label><button id="st-timer-sprint">Start</button></div>`}
        </div>
      </div>`
          : ""
      }
      ${readAloudSettingsHtml()}
      <div class="stats-section stats-writing-style">
        <h3>New-book starting point</h3>
        <div class="stats-style-choices" role="group" aria-label="New-book starting point">
          <button type="button" data-writing-style="pantser" class="${library.writingStyle !== "plotter" ? "active" : ""}"><strong>Pantser</strong><span>Start on the blank page</span></button>
          <button type="button" data-writing-style="plotter" class="${library.writingStyle === "plotter" ? "active" : ""}"><strong>Plotter</strong><span>Start in the outline</span></button>
        </div>
      </div>
      <div style="text-align:right;margin-top:14px">
        <button class="m-ok btn-gold">Done</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  if (hasBook) bindStatsChart(bd);
  const finishReadAloudSettings = bindReadAloudSettings(bd);
  const refreshStatsPreview = () => {
    if (!hasBook) return;
    library.dailyGoal = parseInt(bd.querySelector("#st-daily").value, 10) || 0;
    book.wordGoal = parseInt(bd.querySelector("#st-book").value, 10) || 0;
    book.goalDueDate = bd.querySelector("#st-due").value || "";
    bd.querySelector("#stats-overview").innerHTML = statsOverview();
    bd.querySelector("#deadline-pace").innerHTML = deadlinePaceText();
    bindStatsChart(bd);
    updateCounters();
  };
  if (hasBook) ["#st-daily", "#st-book", "#st-due"].forEach((sel) => {
    const input = bd.querySelector(sel);
    input.addEventListener("input", refreshStatsPreview);
    input.addEventListener("change", refreshStatsPreview);
  });
  const close = async () => {
    finishReadAloudSettings();
    library.dailyGoal = parseInt(bd.querySelector("#st-daily").value, 10) || 0;
    setWritingDayEnd(parseInt(bd.querySelector("#st-dayends").value, 10) || 0);
    if (hasBook) {
      book.wordGoal = parseInt(bd.querySelector("#st-book").value, 10) || 0;
      book.goalDueDate = bd.querySelector("#st-due").value || "";
      book.goalChartMode = book.goalChartMode || "daily";
      scheduleMetaSave();
    }
    await window.neo.writeLibrary(library);
    bd.remove();
    if (hasBook) updateCounters();
  };
  bd.querySelector(".m-ok").onclick = close;
  bd.querySelector(".m-cancel").onclick = close;
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  bd.querySelector("#st-dayends").onchange = async () => {
    setWritingDayEnd(parseInt(bd.querySelector("#st-dayends").value, 10) || 0);
    await window.neo.writeLibrary(library);
    if (hasBook) {
      bd.querySelector("#stats-overview").innerHTML = statsOverview();
      bindStatsChart(bd);
      updateCounters();
    }
  };
  if (hasBook) {
    bd.querySelectorAll("[data-chart-mode]").forEach((btn) => {
      btn.onclick = () => {
        book.goalChartMode = btn.dataset.chartMode;
        bd.querySelectorAll("[data-chart-mode]").forEach((b) => b.classList.toggle("active", b === btn));
        bd.querySelector("#stats-overview").innerHTML = statsOverview();
        bindStatsChart(bd);
      };
    });
    const pause = bd.querySelector("#st-sprint-pause");
    if (pause) pause.onclick = () => {
      toggleTimerPause();
      pause.textContent = sprint && sprint.paused ? "Resume" : "Pause";
      const status = bd.querySelector(".stats-sprint-live .soft");
      if (status) status.textContent = sprint && sprint.paused ? `Timer paused · ${formatDuration(Math.ceil(sprint.remainingMs / 1000))}` : `Timer running · ${formatDuration(Math.ceil((sprint.endsAt - Date.now()) / 1000))}`;
    };
    const end = bd.querySelector("#st-sprint-end");
    if (end)
      end.onclick = () => {
        stopSprint();
        bd.querySelector("#st-sprint-actions").innerHTML = sprintOptionsHtml();
        wireSprintStarts(bd, close);
      };
    wireSprintStarts(bd, close);
  }
  bd.querySelectorAll("[data-writing-style]").forEach((choice) => {
    choice.onclick = () => {
      library.writingStyle = choice.dataset.writingStyle;
      bd.querySelectorAll("[data-writing-style]").forEach((button) => button.classList.toggle("active", button === choice));
    };
  });
}

// Electron wraps errors from the main process as
// "Error invoking remote method 'x': Error: <message>". Writers only need the message.
const STARTER_MARK = "[starter-files] ";
function ipcErrorText(err, fallback) {
  const raw = String((err && err.message) || err || "");
  const text = raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(\w*Error):\s*/, "").trim();
  return { text: (text || fallback).replace(STARTER_MARK, ""), starter: text.startsWith(STARTER_MARK) };
}

function timeAgo(iso) {
  const then = Date.parse(iso || "");
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(then).toLocaleString();
}

function openSyncSettings() {
  const settings = historySettings();
  const git = settings.git || {};
  const hasBook = !!book;
  const saveTime = lastSavedAt || (hasBook && book.modified ? new Date(book.modified) : null);
  const saveLabel = saveTime && !Number.isNaN(saveTime.getTime()) ? saveTime.toLocaleString() : "not yet recorded";
  const checkpointLabel = lastCheckpointAt ? lastCheckpointAt.toLocaleString() : "not yet this session";
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal stats-modal sync-settings-modal">
      <div class="stats-modal-head"><h2 style="font-size:17px">Sync settings</h2><button class="m-cancel btn-quiet" title="Close">×</button></div>
      <p class="sync-intro">NEO saves your writing locally as you type. These controls keep recovery copies and, if you choose, a private GitHub backup.</p>

      <div class="stats-section">
        <h3>Local saving</h3>
        <p class="sync-status-line">Autosave is on · latest save <strong>${escHtml(saveLabel)}</strong></p>
        <label class="sync-switch"><input id="sy-history-enabled" type="checkbox" ${settings.enabled !== false ? "checked" : ""}/> <span>Keep automatic versions</span></label>
        <div class="stats-row sync-options-row">
          <label>Make a version every
            <select id="sy-history-interval">
              ${[5, 10, 15, 30, 60].map((minutes) => `<option value="${minutes}"${(Number(settings.intervalMinutes) || 5) === minutes ? " selected" : ""}>${minutes} minutes</option>`).join("")}
            </select>
          </label>
          <label>Keep daily versions for
            <select id="sy-history-retention">
              ${[30, 90, 180, 365].map((days) => `<option value="${days}"${(Number(settings.retentionDays) || 90) === days ? " selected" : ""}>${days} days</option>`).join("")}
            </select>
          </label>
        </div>
        <p class="sync-detail">Latest version: ${escHtml(checkpointLabel)}.${hasBook ? " You can restore an earlier version of this book at any time." : " Open a book to browse its versions."}</p>
        ${hasBook ? '<div class="sync-actions"><button id="sy-history-versions" class="btn-quiet">Browse this book’s versions…</button></div>' : ""}
      </div>

      <div class="stats-section sync-github-section">
        <h3>GitHub backup <span class="soft">(optional)</span></h3>
        <p class="sync-detail">Back up the entire NEO Library—not just this book. Create an empty private repository on GitHub, then paste its HTTPS address below.</p>
        <label class="sync-switch"><input id="sy-git-enabled" type="checkbox" ${git.enabled && git.autoPush !== false ? "checked" : ""}/> <span>Back up automatically after each version</span></label>
        <p class="sync-detail">NEO creates a private local commit and uploads it in the background. You do not need to run Git commands.</p>
        <div class="sync-connect-row">
          <label>GitHub repository address <input id="sy-git-remote" value="${escHtml(git.remoteUrl || "")}" placeholder="https://github.com/you/neo-library.git"/></label>
          <button id="sy-git-connect" class="btn-gold">Connect &amp; back up</button>
        </div>
        <p class="sync-detail">The first backup may ask GitHub to sign you in through your installed Git credentials.</p>
        <div class="sync-actions"><button id="sy-git-push" class="btn-quiet">Back up now</button><button id="sy-git-replace" class="btn-gold" hidden>Replace GitHub copy</button><span id="sy-git-status" class="sync-git-status"></span></div>
        <p id="sy-git-last" class="sync-detail" hidden></p>
        <div class="sync-actions"><button id="sy-git-restore" class="btn-quiet">Set up this computer from a GitHub backup…</button></div>
      </div>

      <div class="sync-footer">
        <button class="m-cancel">Cancel</button><button class="m-ok btn-gold">Save settings</button>
      </div>
    </div>`;
  document.body.appendChild(bd);

  const status = bd.querySelector("#sy-git-status");
  const replaceBtn = bd.querySelector("#sy-git-replace");
  const lastLine = bd.querySelector("#sy-git-last");
  let lastPushAt = null;
  const showLastPush = () => {
    const ago = timeAgo(lastPushAt);
    lastLine.hidden = !ago;
    if (ago) lastLine.textContent = `Last backed up to GitHub ${ago}.`;
  };
  const lastTimer = setInterval(() => {
    if (!bd.isConnected) return clearInterval(lastTimer);
    showLastPush();
  }, 30000);
  const showGitStatus = (message, isError = false) => {
    status.textContent = message;
    status.style.color = isError ? "var(--red, #b44)" : "";
    replaceBtn.hidden = true;
  };
  const showGitError = (err, fallback) => {
    const { text, starter } = ipcErrorText(err, fallback);
    showGitStatus(text, true);
    replaceBtn.hidden = !starter;
  };
  const noteStatus = (current) => {
    if (current && current.lastPushAt) lastPushAt = current.lastPushAt;
    showLastPush();
  };
  const refreshGitStatus = async () => {
    try {
      const current = await window.neo.gitStatus();
      noteStatus(current);
      if (!current.available) return showGitStatus("Git is not installed.", true);
      if (!current.initialized) return showGitStatus(current.parentRepo ? "Not connected yet. (Your library sits inside another Git repository; NEO will make its own.)" : "Not connected yet.");
      const remote = current.remote ? "GitHub connected." : "Local history ready; GitHub not connected.";
      const auto = git.enabled && git.autoPush !== false;
      showGitStatus(`${remote} ${current.remote && !auto ? "Automatic backup is off." : current.clean ? "Up to date." : "New writing will be backed up with the next version."}`);
    } catch (err) {
      showGitError(err, "Could not check Git status.");
    }
  };
  refreshGitStatus();

  bd.querySelectorAll(".m-cancel").forEach((button) => {
    button.onclick = () => bd.remove();
  });
  // Everything the dialog shows, as settings; used by Save and by Connect.
  const readForm = () => {
    const auto = bd.querySelector("#sy-git-enabled").checked;
    return {
      ...(library.history || {}),
      enabled: bd.querySelector("#sy-history-enabled").checked,
      intervalMinutes: Number(bd.querySelector("#sy-history-interval").value),
      retentionDays: Number(bd.querySelector("#sy-history-retention").value),
      git: {
        ...((library.history && library.history.git) || {}),
        enabled: auto,
        autoPush: auto,
        remoteUrl: bd.querySelector("#sy-git-remote").value.trim()
      }
    };
  };
  const saveForm = async () => {
    library.history = readForm();
    await window.neo.writeLibrary(library);
  };
  const withBusy = async (button, work) => {
    const buttons = bd.querySelectorAll("#sy-git-connect, #sy-git-push, #sy-git-replace, #sy-git-restore");
    buttons.forEach((b) => (b.disabled = true));
    try { await work(); } finally { buttons.forEach((b) => (b.disabled = false)); }
  };
  bd.querySelector(".m-ok").onclick = async () => {
    await saveForm();
    bd.remove();
    toast("Sync settings saved");
  };
  bd.querySelector("#sy-git-connect").onclick = (e) => withBusy(e.currentTarget, async () => {
    try {
      const remoteUrl = bd.querySelector("#sy-git-remote").value.trim();
      showGitStatus("Connecting…");
      await window.neo.connectGitRemote(remoteUrl);
      // Connecting is the request for backups: turn automatic backup on
      // rather than leaving it off because the box wasn't ticked first.
      bd.querySelector("#sy-git-enabled").checked = true;
      await saveForm();
      showGitStatus("Uploading…");
      noteStatus(await window.neo.pushGit());
      showGitStatus("Connected. Automatic backups are on.");
    } catch (err) {
      showGitError(err, "Could not connect GitHub.");
    }
  });
  bd.querySelector("#sy-git-push").onclick = (e) => withBusy(e.currentTarget, async () => {
    try {
      flushAllSaves();
      showGitStatus("Uploading…");
      noteStatus(await window.neo.pushGit());
      showGitStatus("Backed up to GitHub.");
    } catch (err) {
      showGitError(err, "Could not back up to GitHub.");
    }
  });
  bd.querySelector("#sy-git-restore").onclick = (e) => withBusy(e.currentTarget, async () => {
    const remoteUrl = bd.querySelector("#sy-git-remote").value.trim();
    if (!remoteUrl) {
      showGitStatus("Paste the backup repository’s address above first.", true);
      bd.querySelector("#sy-git-remote").focus();
      return;
    }
    const choice = await optionModal("Set up this computer from GitHub?", `NEO will download the library backed up at ${escHtml(remoteUrl)} and use it here.`, [
      { label: "Download and use it", desc: "If this computer already has books, they’re kept beside it in a folder named “NEO Library (before restore …)”. Nothing is deleted.", value: "restore" },
    ]);
    if (choice !== "restore") return;
    try {
      flushAllSaves();
      showGitStatus("Downloading your library…");
      const result = await window.neo.restoreFromGit(remoteUrl);
      showGitStatus(`Restored ${result.books} book${result.books === 1 ? "" : "s"}. Opening…`);
      if (result.keptAs) toast(`Your earlier library is kept at ${result.keptAs}`, 8000);
    } catch (err) {
      showGitError(err, "Could not restore from GitHub.");
    }
  });
  replaceBtn.onclick = (e) => withBusy(e.currentTarget, async () => {
    try {
      flushAllSaves();
      showGitStatus("Replacing GitHub’s starter files with your library…");
      noteStatus(await window.neo.replaceGitStarter());
      showGitStatus("Backed up. GitHub now holds your library.");
    } catch (err) {
      showGitError(err, "Could not replace the GitHub copy.");
    }
  });
  const versions = bd.querySelector("#sy-history-versions");
  if (versions) versions.onclick = () => openVersionHistory(book.id);
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      bd.remove();
    }
  });
}

/* ---------- Compare a saved version with the manuscript as it is now ---------- */

// Paragraph texts of a chapter's saved HTML (outline ghosts and placeholder
// marks are scaffolding, not prose).
function comparableParas(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html || "";
  holder.querySelectorAll(".ghost, .ph-mark").forEach((n) => n.remove());
  return [...holder.querySelectorAll("p")]
    .map((p) => (p.classList.contains("scene-break") ? "***" : p.textContent.replace(/ /g, " ").trim()))
    .filter(Boolean);
}

// Longest-common-subsequence diff of two token lists → [{op: "=", "+", "-", items}]
function diffLists(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [{ op: "-", items: a }, { op: "+", items: b }]; // too big to align; show as rewritten
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (op, item) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.items.push(item);
    else out.push({ op, items: [item] });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("=", a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push("-", a[i++]);
    else push("+", b[j++]);
  }
  while (i < n) push("-", a[i++]);
  while (j < m) push("+", b[j++]);
  return out;
}

const countParaWords = (texts) => texts.reduce((sum, t) => sum + (t.match(/[\p{L}\p{N}][\p{L}\p{N}’'-]*/gu) || []).length, 0);

// Mostly the same paragraph? Otherwise a word diff is just noise.
function similarParas(a, b) {
  const wa = a.toLowerCase().match(/[\p{L}\p{N}’']+/gu) || [];
  const wb = b.toLowerCase().match(/[\p{L}\p{N}’']+/gu) || [];
  if (!wa.length || !wb.length) return false;
  const same = diffLists(wa, wb).filter((p) => p.op === "=").reduce((n, p) => n + p.items.length, 0);
  return same / Math.max(wa.length, wb.length) >= 0.4;
}

// One paragraph rewritten: show the words that changed inside it.
function wordDiffHtml(before, after) {
  const words = (t) => t.match(/\s+|[\p{L}\p{N}’']+|[^\s\p{L}\p{N}]/gu) || [];
  let added = 0, removed = 0;
  const html = diffLists(words(before), words(after)).map((part) => {
    const text = escHtml(part.items.join(""));
    if (part.op === "=") return text;
    const n = countParaWords([part.items.join("")]);
    if (part.op === "+") { added += n; return `<ins>${text}</ins>`; }
    removed += n;
    return `<del>${text}</del>`;
  }).join("");
  return { html, added, removed };
}

// A chapter's changes as HTML, with one paragraph of context either side.
function chapterDiffHtml(oldParas, newParas) {
  const parts = diffLists(oldParas, newParas);
  const blocks = [];
  let added = 0, removed = 0;
  parts.forEach((part, k) => {
    if (part.op === "=") {
      const prevChanged = k > 0, nextChanged = k < parts.length - 1;
      const items = part.items;
      if (items.length <= 2) {
        if (prevChanged || nextChanged) items.forEach((t) => blocks.push(`<p class="cmp-same">${escHtml(t)}</p>`));
      } else {
        if (prevChanged) blocks.push(`<p class="cmp-same">${escHtml(items[0])}</p>`);
        if (prevChanged && nextChanged) blocks.push('<p class="cmp-gap">⋯</p>');
        if (nextChanged) blocks.push(`<p class="cmp-same">${escHtml(items[items.length - 1])}</p>`);
      }
      return;
    }
    if (part.op === "-" && parts[k + 1] && parts[k + 1].op === "+") {
      // paired rewrite: diff paragraph by paragraph, words inside
      const next = parts[k + 1];
      const pairs = Math.min(part.items.length, next.items.length);
      for (let x = 0; x < pairs; x++) {
        if (similarParas(part.items[x], next.items[x])) {
          const w = wordDiffHtml(part.items[x], next.items[x]);
          blocks.push(`<p class="cmp-edit">${w.html}</p>`);
          added += w.added;
          removed += w.removed;
        } else {
          blocks.push(`<p class="cmp-del">${escHtml(part.items[x])}</p>`, `<p class="cmp-ins">${escHtml(next.items[x])}</p>`);
          removed += countParaWords([part.items[x]]);
          added += countParaWords([next.items[x]]);
        }
      }
      part.items.slice(pairs).forEach((t) => blocks.push(`<p class="cmp-del">${escHtml(t)}</p>`));
      next.items.slice(pairs).forEach((t) => blocks.push(`<p class="cmp-ins">${escHtml(t)}</p>`));
      removed += countParaWords(part.items.slice(pairs));
      added += countParaWords(next.items.slice(pairs));
      next.handled = true;
      return;
    }
    if (part.handled) return;
    if (part.op === "-") { part.items.forEach((t) => blocks.push(`<p class="cmp-del">${escHtml(t)}</p>`)); removed += countParaWords(part.items); }
    else { part.items.forEach((t) => blocks.push(`<p class="cmp-ins">${escHtml(t)}</p>`)); added += countParaWords(part.items); }
  });
  return { html: blocks.join(""), added, removed, changed: parts.some((p) => p.op !== "=") };
}

async function openVersionCompare(bookId, checkpointId) {
  if (!book || book.id !== bookId) return;
  flushAllSaves();
  let saved;
  try {
    saved = await window.neo.readCheckpoint(bookId, checkpointId);
  } catch (err) {
    toast(ipcErrorText(err, "NEO couldn’t read that version.").text, 6000);
    return;
  }
  const label = (meta, chId, i) => {
    const title = (meta.chapterTitles || {})[chId];
    return `Chapter ${i + 1}${title ? ": " + escHtml(title) : ""}`;
  };
  const nowOrder = book.chapterOrder;
  const thenOrder = saved.meta.chapterOrder || Object.keys(saved.chapters);
  // "moved" means its place among the chapters both versions share changed,
  // not just that an earlier chapter was added or cut
  const nowShared = nowOrder.filter((id) => thenOrder.includes(id));
  const thenShared = thenOrder.filter((id) => nowOrder.includes(id));
  const sections = [];
  let totalAdded = 0, totalRemoved = 0;
  nowOrder.forEach((chId, i) => {
    const before = thenOrder.includes(chId) ? comparableParas(saved.chapters[chId]) : [];
    const after = comparableParas(chapterHTML[chId]);
    const d = chapterDiffHtml(before, after);
    const moved = thenOrder.includes(chId) && nowShared.indexOf(chId) !== thenShared.indexOf(chId);
    if (!d.changed && !moved && thenOrder.includes(chId)) return;
    totalAdded += d.added; totalRemoved += d.removed;
    const tag = !thenOrder.includes(chId) ? "new since then" : moved ? `was chapter ${thenOrder.indexOf(chId) + 1}` : "";
    sections.push({ title: label(book, chId, i), tag, added: d.added, removed: d.removed, html: d.html });
  });
  thenOrder.forEach((chId, i) => {
    if (nowOrder.includes(chId)) return;
    const before = comparableParas(saved.chapters[chId]);
    totalRemoved += countParaWords(before);
    sections.push({ title: label(saved.meta, chId, i), tag: "deleted since then", added: 0, removed: countParaWords(before), html: before.map((t) => `<p class="cmp-del">${escHtml(t)}</p>`).join("") });
  });

  const when = new Date(saved.createdAt).toLocaleString();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal compare-modal">
      <div class="stats-modal-head"><h2 style="font-size:17px">Changes since ${escHtml(when)}</h2><button class="m-cancel btn-quiet" title="Close">×</button></div>
      <p class="soft">${sections.length ? `${sections.length} chapter${sections.length === 1 ? "" : "s"} changed · <span class="cmp-plus">+${totalAdded}</span> / <span class="cmp-minus">−${totalRemoved}</span> words. <ins>Added</ins> and <del>removed</del> text is marked.` : "The manuscript is the same as this version."}</p>
      <div class="compare-list">${sections.map((s, k) => `
        <details class="compare-ch"${k === 0 ? " open" : ""}>
          <summary><span>${s.title}${s.tag ? ` <small>· ${escHtml(s.tag)}</small>` : ""}</span><span class="cmp-count"><span class="cmp-plus">+${s.added}</span> <span class="cmp-minus">−${s.removed}</span></span></summary>
          <div class="compare-body">${s.html || '<p class="cmp-gap">Only moved.</p>'}</div>
        </details>`).join("")}</div>
      <div style="text-align:right;margin-top:14px"><button class="m-ok btn-gold">Done</button></div>
    </div>`;
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.querySelectorAll(".m-ok, .m-cancel").forEach((b) => (b.onclick = close));
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  });
  bd.querySelector(".m-ok").focus();
}

async function openVersionHistory(bookId) {
  const versions = await window.neo.listCheckpoints(bookId);
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  const rows = versions.length
    ? versions.map((version) => {
      const when = version.createdAt ? new Date(version.createdAt).toLocaleString() : "Unknown date";
      const note = version.valid ? (version.reason || "writing") : `unavailable — ${escHtml(version.error || "failed verification")}`;
      return `<div class="history-row"><span><strong>${when}</strong><br><small>${escHtml(note)}</small></span><span class="history-actions"><button data-compare="${escHtml(version.id)}" class="btn-quiet"${version.valid ? "" : " disabled"}>Compare</button><button data-version="${escHtml(version.id)}"${version.valid ? "" : " disabled"}>Restore</button></span></div>`;
    }).join("")
    : '<p class="soft">No version checkpoints yet.</p>';
  bd.innerHTML = `
    <div class="modal" style="width:540px">
      <h2 style="font-size:17px">Version history</h2>
      <p>Compare shows what changed since a version. Restoring first saves your current manuscript as a new version.</p>
      <div class="history-list">${rows}</div>
      <div style="text-align:right;margin-top:14px"><button class="m-ok btn-gold">Done</button></div>
    </div>`;
  document.body.appendChild(bd);
  bd.querySelector(".m-ok").onclick = () => bd.remove();
  bd.querySelectorAll("[data-compare]").forEach((button) => {
    button.onclick = () => openVersionCompare(bookId, button.dataset.compare);
  });
  bd.querySelectorAll("[data-version]").forEach((button) => {
    button.onclick = async () => {
      const choice = await optionModal("Restore this version?", "Your current manuscript will be preserved as a new version first.", [
        { label: "Restore version", desc: "Replace the current book with this saved version.", value: "restore", danger: true },
      ]);
      if (choice !== "restore") return;
      button.disabled = true;
      try {
        await window.neo.restoreCheckpoint(bookId, button.dataset.version);
        bd.remove();
        await openBook(bookId);
        toast("Version restored — the version you were editing was saved first.", 5000);
      } catch (err) {
        button.disabled = false;
        toast("NEO couldn't restore that version. Your current manuscript is still safe.", 6000);
        window.neo.logError(`restore checkpoint: ${err && err.stack ? err.stack : err}`);
      }
    };
  });
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      bd.remove();
    }
  });
}

function sprintOptionsHtml() {
  return '<div class="stats-sprint-option"><label>Word sprint <input id="st-sprint-words" type="number" min="50" value="500"/></label><button id="st-word-sprint">Start</button></div><div class="stats-sprint-option"><label>Timer <input id="st-sprint-minutes" type="number" min="1" value="25"/> min</label><button id="st-timer-sprint">Start</button></div>';
}

function wireSprintStarts(bd, close) {
    const word = bd.querySelector("#st-word-sprint");
    if (word)
      word.onclick = () => {
        startSprint(
          "words",
          parseInt(bd.querySelector("#st-sprint-words").value, 10) || 500,
        );
        close();
      };
    const timer = bd.querySelector("#st-timer-sprint");
    if (timer)
      timer.onclick = () => {
        startSprint(
          "timer",
          parseInt(bd.querySelector("#st-sprint-minutes").value, 10) || 25,
        );
        close();
      };
}

$("#goal-counter").onclick = openStats;
$("#sprint-pause").onclick = toggleTimerPause;
$("#sprint-stop").onclick = stopSprint;

/* ================================================================== */
/*  MENU: Help + fonts                                                 */
/* ================================================================== */

const DROPCAP_FONTS = {
  literary: '"Didot", "Bodoni 72", Georgia, serif',
  fantasy: '"Apple Chancery", "Snell Roundhand", cursive',
  scifi: 'Futura, "Avenir Next", "Helvetica Neue", sans-serif',
};
const BODY_FONTS = {
  Georgia: 'Georgia, "Times New Roman", serif',
  Palatino: '"Palatino", "Palatino Linotype", serif',
  Baskerville: 'Baskerville, "Baskerville Old Face", Georgia, serif',
  "Hoefler Text": '"Hoefler Text", Georgia, serif',
  "Iowan Old Style": '"Iowan Old Style", Georgia, serif',
  Cambria: 'Cambria, Georgia, serif',
  Constantia: 'Constantia, Georgia, serif',
};

// Hoefler Text and Iowan Old Style ship only with macOS; elsewhere they
// would fall back to Georgia, so offer the fonts Windows actually has.
// Keep in step with bodyFonts in main.js.
const BODY_FONT_CHOICES = IS_MAC
  ? ['Georgia', 'Palatino', 'Baskerville', 'Hoefler Text', 'Iowan Old Style']
  : ['Georgia', 'Palatino', 'Baskerville', 'Cambria', 'Constantia'];

function applyFonts() {
  const f = library.fonts || {};
  if (f.body && typeof f.body === "string") {
    document.documentElement.style.setProperty(
      "--body-font",
      bodyFontStack(f.body),
    );
  }
  if (f.dropcap && DROPCAP_FONTS[f.dropcap]) {
    document.documentElement.style.setProperty(
      "--dropcap-font",
      DROPCAP_FONTS[f.dropcap],
    );
  }
  document.body.classList.toggle("night", library.pageTheme === "night");
  document.body.classList.toggle("bright", !!library.uiBright);
  const size = Math.min(22, Math.max(14, library.editorFontSize || 17));
  document.documentElement.style.setProperty("--editor-size", size + "px");
  const zoom = Math.min(1.6, Math.max(0.75, library.pageZoom || 1));
  document.documentElement.style.setProperty("--page-zoom", zoom);
  updateZoomDisplay();
}

// A built-in choice, or a font the writer picked from their own computer.
// A library opened where that font is missing simply reads in Georgia.
function bodyFontStack(name) {
  return Object.hasOwn(BODY_FONTS, name) ? BODY_FONTS[name] : `"${name.replace(/["\\]/g, '')}", Georgia, serif`;
}

// Format → Body Font → Other Font…: every font installed on this computer,
// each shown in its own face. The panel sits top right, off the undimmed
// page, so hovering previews the font on the writer's own words. Resolves
// to a family name, or null on cancel.
async function pickLocalFont() {
  let families = [];
  try {
    // one entry per style; names starting with "." are the system's hidden fonts
    const faces = await window.queryLocalFonts();
    families = [...new Set(faces.map((f) => f.family))]
      .filter((n) => n && !n.startsWith('.'))
      .sort((a, b) => a.localeCompare(b));
  } catch {}
  if (!families.length) { toast('NEO couldn’t read the fonts on this computer'); return null; }
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop font-picker';
    bd.innerHTML = `
      <div class="modal" style="width:320px">
        <h2 style="font-size:16px">Other font</h2>
        <p class="font-now" style="font-size:13px;color:var(--muted);margin-bottom:10px"></p>
        <input type="text" spellcheck="false" placeholder="Search ${families.length} installed fonts" />
        <div class="font-list"></div>
        <div style="text-align:right;margin-top:14px">
          <button class="m-cancel btn-quiet">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    const input = bd.querySelector('input');
    const list = bd.querySelector('.font-list');
    const current = (library.fonts || {}).body || 'Georgia';
    bd.querySelector('.font-now').textContent = 'Now: ' + current;
    const done = (val) => { bd.remove(); resolve(val); };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      list.innerHTML = '';
      for (const name of families) {
        if (q && !name.toLowerCase().includes(q)) continue;
        const b = document.createElement('button');
        b.className = 'fr-font' + (name === current ? ' sel' : '');
        b.textContent = name;
        b.style.fontFamily = bodyFontStack(name);
        b.onmouseenter = () => { document.documentElement.style.setProperty('--body-font', bodyFontStack(name)); };
        b.onclick = () => done(name);
        list.appendChild(b);
      }
    };
    list.onmouseleave = applyFonts; // back to the saved font
    input.oninput = render;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && list.firstChild) done(list.firstChild.textContent);
      if (e.key === 'Escape') done(null);
    };
    bd.querySelector('.m-cancel').onclick = () => done(null);
    render();
    const sel = list.querySelector('.sel');
    if (sel) sel.scrollIntoView({ block: 'center' });
    input.focus();
  });
}

// Pinch (trackpad) or Ctrl+scroll: page and text zoom together.
// A pinch arrives as a wheel event with ctrlKey set.
let zoomSaveTimer = null;
function updateZoomDisplay() {
  const el = $("#zoom-level");
  if (el) el.textContent = Math.round((library.pageZoom || 1) * 100) + "%";
}
function setPageZoom(next) {
  next = Math.min(1.6, Math.max(0.75, next));
  if (next === (library.pageZoom || 1)) return;
  library.pageZoom = next;
  document.documentElement.style.setProperty("--page-zoom", next);
  updateZoomDisplay();
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => {
    window.neo.writeLibrary(library);
  }, 600);
}
$("#editor-view").addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setPageZoom((library.pageZoom || 1) * Math.exp(-e.deltaY * 0.005));
  },
  { passive: false },
);

// zoom control in the bottom bar: buttons, click-to-reset, and scroll
$("#zoom-in").onclick = () => setPageZoom((library.pageZoom || 1) + 0.1);
$("#zoom-out").onclick = () => setPageZoom((library.pageZoom || 1) - 0.1);
$("#zoom-level").onclick = () => setPageZoom(1);
$("#zoom-control").addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    setPageZoom((library.pageZoom || 1) * Math.exp(-e.deltaY * 0.002));
  },
  { passive: false },
);

// Format → Align Paragraph: applies to every paragraph the selection touches
function applyAlign(value) {
  if (!book || currentTab !== "manuscript") {
    toast("Click into a paragraph first");
    return;
  }
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  let el = r.startContainer;
  if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  const body = el && el.closest ? el.closest(".chapter-body") : null;
  if (!body) {
    toast("Click into a paragraph first");
    return;
  }
  const chId = body.closest(".chapter").dataset.id;
  const ps = [...body.querySelectorAll("p")].filter(
    (p) => r.intersectsNode(p) && !p.classList.contains("scene-break"),
  );
  for (const p of ps) {
    if (value === "left") p.style.removeProperty("text-align");
    else p.style.textAlign = value;
    if (!p.getAttribute("style")) p.removeAttribute("style");
  }
  syncChapter(body, chId);
}

function showHelp() {
  //Toggle between visible and hidden.
  const existing = document.querySelector(".help-modal-backdrop");
  if (existing) {
    existing.remove();
    return;
  }
  const row = (k, d) => `<span class="hk">${k}</span><span>${d}</span>`;
  const bd = document.createElement("div");
  bd.className = "modal-backdrop help-modal-backdrop";
  bd.innerHTML = `
    <div class="modal" style="width:560px">
      <h2>NEO Shortcuts</h2>

      <div class="help-sec">Writing</div>
      <div class="help-grid">
        ${row('Enter ×2', 'Section break (***)')}
        ${row('Enter ×3', 'New chapter, auto-numbered')}
        ${row('⇧Enter', 'Poetry paragraph — verse, a quote, a POV name; italic, set in from the margins. ⇧Enter again continues it; Enter returns to prose')}
        ${row(KPH, 'Placeholder note')}
        ${row(KDA, 'Send the selected passage to Darlings')}
        ${row(K('⌘⇧;', 'Ctrl+Shift+;'), 'Revision pass — echoes, filler, -ly adverbs, name slips. Esc ends it')}
        ${row(K('⌘⇧U', 'Ctrl+Shift+U'), 'Focus mode — everything but your paragraph fades back')}
        ${row(K('⌘⇧R', 'Ctrl+Shift+R'), 'Read aloud from the caret, or the selection. Any key stops it')}
        ${row(KZ, 'Undo big moves (chapter deletes, replace-all, darlings) when not mid-typing')}
        ${row('-- and ...', 'Become an em dash — and a true ellipsis …')}
        ${row(K('⌘B · ⌘I', 'Ctrl+B · Ctrl+I'), 'Bold, italic. Quotes curl themselves.')}
      </div>

      <div class="help-sec">Getting around</div>
      <div class="help-grid">
        ${row(K("⌘F", "Ctrl+F"), "Find &amp; replace across the whole book")}
        ${row(K("⌘PageUp / ⌘PageDown", "Ctrl+PageUp / Ctrl+PageDown"), "Previous / next screen — wraps through available tabs")}
        ${row("Hover edges", "Left: chapters &amp; outline notes. Right: comments (☉ pins).")}
        ${row("Esc", "Closes whatever’s open; otherwise back to the shelf")}
      </div>

      <div class="help-sec">Modes</div>
      <div class="help-grid">
        ${row(K("⌘⇧F", "Ctrl+Shift+F"), "Full screen (Esc leaves)")}
        ${row(K("⌘⇧T", "Ctrl+Shift+T"), "Typewriter scrolling")}
        ${row(K("⌘;", "Ctrl+;"), "Spellcheck pass (right-click squiggles for fixes)")}
      </div>

      <div class="help-sec">Files</div>
      <div class="help-grid">
        ${row(K("⌘E", "Ctrl+E"), "Email a timestamped draft to yourself")}
        ${row(K("⌘⇧I", "Ctrl+Shift+I"), "Import .docx / .txt / .md manuscripts")}
        ${row("File → Export", "txt · md · html · pdf · docx · epub")}
      </div>

      <div class="help-sec">Mouse</div>
      <div class="help-grid">
        ${row("Drag text", "Onto the Darlings tab")}
        ${row("Right-click", "Books, shelf names, chapter headings, outline lines")}
        ${row("Drag chapters", "In the left panel, to reorder — everything renumbers")}
        ${row("Double-click", "A tab, to rename it")}
        ${row("Click counters", "Cycle word counts · open goals &amp; sprints")}
        ${row(K("Pinch", "Ctrl+Scroll"), "Zoom the page — text and column together (" + K("⌘0", "Ctrl+0") + " resets)")}
        ${row("Zoom control", "Bottom bar — +/− buttons, scroll it, or click the % to reset")}
      </div>

      <div style="text-align:right;margin-top:18px">
        <button class="m-ok btn-gold">Got it</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.querySelector(".m-ok").onclick = close;
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  bd.querySelector(".m-ok").focus();
}

/* ================================================================== */
/*  EXPORT + EMAIL                                                     */
/* ================================================================== */

function safeName(s) {
  return (s || "Untitled")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// Every paragraph is rebuilt from its text runs, so exports carry only
// author-meaningful markup: text, bold, italic, alignment, scene breaks.
// Stray spans, inline styles, trailing <br>s, and no-break spaces all
// stop at this door.
function parasFromHtml(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html || "";
  // an unwritten outline section is a ghost paragraph plus the scene break
  // NEO planted for it; neither belongs in a book
  holder.querySelectorAll("p.ghost[data-sec-id]").forEach((g) => {
    const brk = holder.querySelector(
      `p.scene-break[data-sec-brk="${g.dataset.secId}"]`,
    );
    if (brk) brk.remove();
  });
  holder.querySelectorAll('.darling-anchor, .ph-mark, .ghost').forEach((n) => n.remove());
  return [...holder.querySelectorAll('p')].map((p) => {
    const sceneBreak = p.classList.contains('scene-break');
    const poetry = p.classList.contains('poetry');
    const align = (p.style && p.style.textAlign) || '';
    const runs = paraRuns(p.innerHTML).filter((r) => r.text);
    const inner = runs.map((r) => {
      let t = escHtml(r.text);
      if (r.i) t = '<i>' + t + '</i>';
      if (r.b) t = '<b>' + t + '</b>';
      return t;
    }).join('');
    return {
      sceneBreak,
      poetry,
      text: p.innerText.replace(/\u00a0/g, ' ').trim(),
      runs,
      align,
      html: `<p${poetry ? ' class="poetry"' : ''}${align ? ` style="text-align:${align}"` : ''}>${inner}</p>`
    };
  }).filter((p) => p.sceneBreak || p.text);
}

function exportChapters() {
  // [{num, heading, paras: [{text, sceneBreak, html}]}]
  return book.chapterOrder.map((chId, i) => {
    const el = document.querySelector(
      `.chapter[data-id="${chId}"] .chapter-body`,
    );
    const paras = parasFromHtml(el ? el.innerHTML : chapterHTML[chId] || "");
    const t = (book.chapterTitles || {})[chId];
    // chapterless stories export as continuous text
    const heading =
      book.chapterOrder.length === 1
        ? ""
        : "Chapter " + (i + 1) + (t ? " — " + t : "");
    return { num: i + 1, heading, paras };
  });
}

// The open book, packaged for the builders. Every builder takes an optional
// data object in this shape, good for anthologies.
function bookExportData() {
  // an EPUB wants a real UUID as its identifier; the book gets one the first
  // time it's exported and keeps it, so re-exports are the same book
  if (!book.uuid) {
    book.uuid = crypto.randomUUID();
    saveMeta();
  }
  return {
    id: book.id,
    uuid: book.uuid,
    title: book.title,
    subtitle: book.subtitle,
    author: book.author || 'Anonymous', // the screen says so; the files should too
    language: library.spellLanguage || 'en',
    coverSeed: book.coverSeed,
    coverImage: book.coverImage || null,
    sections: exportChapters(),
  };
}

function buildTxt(data) {
  const d = data || bookExportData();
  let out = `${d.title.toUpperCase()}\n`;
  if (d.subtitle) out += `${d.subtitle}\n`;
  out += `by ${d.author}\n\n\n`;
  for (const ch of d.sections) {
    if (ch.heading) out += `${ch.heading.toUpperCase()}\n\n`;
    for (const p of ch.paras) out += p.sceneBreak ? '\n***\n\n' : (p.poetry ? '    ' : '') + p.text + '\n\n';
    out += '\n';
  }
  return out;
}

function buildMd(data) {
  const d = data || bookExportData();
  // wrap a run in emphasis markers, keeping boundary spaces outside them
  const mdRun = (r) => {
    let t = r.text.replace(/([\\*_`])/g, "\\$1");
    const mark = r.b && r.i ? "***" : r.b ? "**" : r.i ? "*" : "";
    if (!mark) return t;
    const lead = t.match(/^\s*/)[0];
    const trail = t.match(/\s*$/)[0];
    const core = t.slice(lead.length, t.length - trail.length);
    return core ? lead + mark + core + mark + trail : t;
  };
  let out = `# ${d.title}\n\n`;
  if (d.subtitle) out += `*${d.subtitle}*\n\n`;
  out += `**by ${d.author}**\n\n`;
  for (const ch of d.sections) {
    if (ch.heading) out += `\n## ${ch.heading}\n\n`;
    for (const p of ch.paras) {
      out += p.sceneBreak ? '\n***\n\n' : (p.poetry ? '> ' : '') + p.runs.map(mdRun).join('') + '\n\n';
    }
  }
  return out;
}

function buildHtml(data, opts = {}) {
  const d = data || bookExportData();
  const total = d.sections.reduce(
    (s, ch) => s + ch.paras.reduce((n, p) => n + countWords(p.text || ""), 0),
    0,
  );
  const stamp = new Date().toLocaleString();
  const chaptersHtml = d.sections.map((ch) => {
    // only the chapter's opening paragraph gets the enlarged initial —
    // scene breaks resume ordinary body text
    let first = true;
    const paras = ch.paras.map((p) => {
      if (p.sceneBreak) return '<p class="brk">***</p>';
      if (p.poetry) return p.html;
      let html = p.html;
      if (first) {
        const h = document.createElement('div');
        h.innerHTML = html;
        if (h.firstElementChild) {
          h.firstElementChild.classList.add('first');
          html = h.innerHTML;
        }
      }
      first = false;
      return html;
    }).join('\n');
    return `
    <section class="chapter">
      ${ch.heading ? `<h2>${ch.heading}</h2>` : ""}
      ${paras}
    </section>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${d.title}</title>
<style>
  body { font-family: Georgia, serif; color: #1c1c1c; max-width: 620px; margin: 40px auto; line-height: 1.7; font-size: 13pt; }
  .coverpage { text-align: center; margin: 0 0 40px; page-break-after: always; }
  .coverpage img { display: block; margin: 0 auto; width: 100%; max-width: 620px; max-height: 95vh; object-fit: contain; }
  .titlepage { text-align: center; margin: 30vh 0 20vh; page-break-after: always; }
  .titlepage h1 { font-size: 30pt; margin: 0; }
  .titlepage .sub { font-style: italic; color: #555; }
  .titlepage .auth { margin-top: 40px; letter-spacing: 3px; text-transform: uppercase; font-size: 11pt; }
  .chapter { page-break-before: always; }
  .chapter h2 { text-align: center; letter-spacing: 4px; text-transform: uppercase; font-size: 12pt; font-weight: normal; color: #555; margin: 60px 0 40px; }
  .chapter p { text-indent: 2em; margin: 0; }
  .chapter h2 + p, .brk + p, .chapter p.first { text-indent: 0; }
  /* an in-flow raised initial: stays inside its word for copy, search,
     and screen readers, unlike a floated drop cap */
  .chapter h2 + p:not(.poetry)::first-letter, .chapter p.first::first-letter { font-size: 1.8em; line-height: 1; }
  .brk { text-align: center; text-indent: 0 !important; letter-spacing: 8px; color: #888; margin: 2.5em 0; }
  .chapter p.poetry { text-indent: 0; margin: 0 2.5em; }
  .chapter p:not(.poetry) + p.poetry, .chapter h2 + p.poetry { margin-top: 0.9em; }
  .chapter p.poetry + p:not(.poetry) { margin-top: 0.9em; }
  .prov { margin-top: 80px; text-align: center; color: #999; font-size: 9pt; }
</style></head><body>
${opts.cover ? `<div class="coverpage"><img src="data:${opts.cover.mime};base64,${opts.cover.base64}" alt="Cover"/></div>` : ""}
<div class="titlepage"><h1>${d.title}</h1>
${d.subtitle ? `<p class="sub">${d.subtitle}</p>` : ""}
<p class="auth">${d.author}</p></div>
${chaptersHtml}
${opts.stamp ? `<p class="prov">${total.toLocaleString()} words · exported from NEO on ${stamp}</p>` : ""}
</body></html>`;
}

/* ---------- runs: paragraphs broken into styled text pieces ---------- */

const escXml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// Walk a paragraph's DOM and emit [{text, b, i}] so docx/epub get real bold/italic
function paraRuns(pHtml) {
  const holder = document.createElement("div");
  holder.innerHTML = pHtml;
  const runs = [];
  const walk = (node, b, i) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent)
          runs.push({ text: child.textContent.replace(/\u00a0/g, " "), b, i });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.classList && child.classList.contains("ph-mark")) {
          runs.push({ mark: child.dataset.sid || "" });
          continue;
        }
        const tag = child.tagName;
        walk(
          child,
          b || tag === "B" || tag === "STRONG",
          i || tag === "I" || tag === "EM",
        );
      }
    }
  };
  walk(holder, false, false);
  return runs;
}

/* ---------- DOCX ---------- */

function docxP(runs, opts = {}) {
  const pPr = [];
  if (opts.pageBreak) pPr.push("<w:pageBreakBefore/>");
  if (opts.align) pPr.push(`<w:jc w:val="${opts.align}"/>`);
  if (opts.indent) pPr.push('<w:ind w:firstLine="480"/>');
  if (opts.poetry) pPr.push('<w:ind w:left="720" w:right="720"/>');
  if (opts.spaceBefore) pPr.push(`<w:spacing w:before="${opts.spaceBefore}" w:line="360" w:lineRule="auto"/>`);
  const rXml = runs.map((r) => {
    const rPr = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + (opts.size ? `<w:sz w:val="${opts.size}"/>` : '');
    return `<w:r>${rPr ? '<w:rPr>' + rPr + '</w:rPr>' : ''}<w:t xml:space="preserve">${escXml(r.text)}</w:t></w:r>`;
  }).join('');
  return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${rXml}</w:p>`;
}

function buildDocxEntries(data) {
  const d = data || bookExportData();
  const body = [];
  // title page
  body.push(
    docxP([{ text: d.title, b: true }], {
      align: "center",
      spaceBefore: 3000,
      size: 56,
    }),
  );
  if (d.subtitle)
    body.push(
      docxP([{ text: d.subtitle, i: true }], { align: "center", size: 32 }),
    );
  body.push(docxP([{ text: d.author }], { align: "center", spaceBefore: 800 }));
  d.sections.forEach((ch) => {
    if (ch.heading) {
      body.push(
        docxP([{ text: ch.heading.toUpperCase(), b: false }], {
          align: "center",
          pageBreak: true,
          spaceBefore: 1200,
          size: 28,
        }),
      );
      body.push(docxP([], {}));
    } else {
      body.push(docxP([], { pageBreak: true })); // headingless story still starts fresh
    }
    for (const p of ch.paras) {
      if (p.sceneBreak) body.push(docxP([{ text: '***' }], { align: 'center', spaceBefore: 240 }));
      else if (p.poetry) body.push(docxP(paraRuns(p.html), { align: p.align === 'center' || p.align === 'right' ? p.align : '', poetry: true }));
      else if (p.align === 'center' || p.align === 'right') body.push(docxP(paraRuns(p.html), { align: p.align }));
      else body.push(docxP(paraRuns(p.html), { indent: true }));
    }
  });
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="24"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
</w:styles>`;
  return [
    {
      path: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    },
    {
      path: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    {
      path: "word/_rels/document.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { path: "word/document.xml", content: documentXml },
    { path: "word/styles.xml", content: stylesXml },
  ];
}

/* ---------- Manuscript format (standard submission / Shunn) ---------- */
// What agents and editors ask for: Times New Roman 12, double spaced, one-inch
// margins, half-inch indents, contact block and rounded word count on the
// first page, "Surname / TITLE / page" in the header from page two, each
// chapter a third of the way down a new page, # for scene breaks, END at the
// close. Contact details stay on this computer (see library.backup.json).

function manuscriptWordCount(d) {
  const words = d.sections.reduce((n, ch) => n + ch.paras.reduce((m, p) => m + (p.sceneBreak ? 0 : countWords(p.text)), 0), 0);
  if (words >= 20000) return { words, label: `about ${(Math.round(words / 1000) * 1000).toLocaleString("en-US")} words` };
  return { words, label: `about ${Math.max(100, Math.round(words / 100) * 100).toLocaleString("en-US")} words` };
}

function buildManuscriptDocxEntries(d, contact) {
  const TNR = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>';
  const para = (runs, o = {}) => {
    const pPr = [];
    if (o.pageBreak) pPr.push("<w:pageBreakBefore/>");
    if (o.keepNext) pPr.push("<w:keepNext/>");
    if (o.tabRight) pPr.push('<w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs>');
    pPr.push(`<w:spacing w:before="${o.before || 0}" w:after="0" w:line="${o.single ? 240 : 480}" w:lineRule="auto"/>`);
    if (o.indent) pPr.push('<w:ind w:firstLine="720"/>');
    else if (o.poetry) pPr.push('<w:ind w:left="720" w:right="720"/>');
    if (o.align) pPr.push(`<w:jc w:val="${o.align}"/>`);
    const rXml = runs.map((r) => {
      if (r.tab) return "<w:r><w:tab/></w:r>";
      const rPr = (r.b ? "<w:b/>" : "") + (r.i ? "<w:i/>" : "");
      return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${escXml(r.text)}</w:t></w:r>`;
    }).join("");
    return `<w:p><w:pPr>${pPr.join("")}</w:pPr>${rXml}</w:p>`;
  };
  const body = [];
  const count = manuscriptWordCount(d);
  // first page: contact block (single spaced, top left), word count top right
  const lines = [contact.legalName || d.author, ...String(contact.address || "").split(/\r?\n/), contact.phone, contact.email]
    .map((l) => (l || "").trim()).filter(Boolean);
  lines.forEach((line, i) => {
    body.push(para(i === 0 ? [{ text: line }, { tab: true }, { text: count.label }] : [{ text: line }], { single: true, tabRight: i === 0 }));
  });
  if (!lines.length) body.push(para([{ tab: true }, { text: count.label }], { single: true, tabRight: true }));
  // title and byline, centred, about halfway down
  body.push(para([{ text: d.title }], { align: "center", before: 4320 }));
  if (d.subtitle) body.push(para([{ text: d.subtitle }], { align: "center" }));
  body.push(para([{ text: `by ${contact.byline || d.author}` }], { align: "center" }));

  const multi = d.sections.length > 1;
  d.sections.forEach((ch, i) => {
    if (multi) {
      // each chapter starts a third of the way down a fresh page
      body.push(para([{ text: ch.heading || `Chapter ${i + 1}` }], { align: "center", pageBreak: true, before: 2880, keepNext: true }));
      body.push(para([], { keepNext: true }));
    } else if (i === 0) {
      body.push(para([], {}));
    }
    for (const p of ch.paras) {
      if (p.sceneBreak) body.push(para([{ text: "#" }], { align: "center" }));
      else if (p.poetry) body.push(para(paraRuns(p.html), { poetry: true }));
      else if (p.align === "center" || p.align === "right") body.push(para(paraRuns(p.html), { align: p.align }));
      else body.push(para(paraRuns(p.html), { indent: true }));
    }
  });
  body.push(para([{ text: "END" }], { align: "center", before: 480 }));

  const surname = String(contact.byline || d.author || "").trim().split(/\s+/).pop() || "Author";
  const keyword = String(d.title || "Untitled").toUpperCase().split(/\s+/).filter((w) => !/^(THE|A|AN)$/.test(w)).slice(0, 3).join(" ") || "UNTITLED";
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:t xml:space="preserve">${escXml(surname)} / ${escXml(keyword)} / </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:hdr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join("")}
<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/><w:titlePg/></w:sectPr>
</w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${TNR}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
</w:styles>`;
  return [
    { path: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>` },
    { path: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>` },
    { path: "word/_rels/document.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>` },
    { path: "word/document.xml", content: documentXml },
    { path: "word/styles.xml", content: stylesXml },
    { path: "word/header1.xml", content: headerXml },
  ];
}

// The pen name this book is written under (falls back to the current one).
function authorForBook() {
  return ownerOfBook(book.id) || (library.authors || []).find((a) => a.name === book.author) || currentAuthor();
}

/* ---------- Shared end matter ---------- */
// About the Author, Also by, and a copyright page, written once per pen name
// and added to the back of every export of that author's books. The
// manuscript never contains them; they appear only in exported files.
// {year}, {title} and {author} are filled in at export time.

function otherTitlesBy(author) {
  const homeId = library.authors[0].id;
  const ids = library.shelves.filter((s) => (s.authorId || homeId) === author.id).flatMap((s) => s.bookIds);
  return ids.filter((id) => !book || id !== book.id);
}

function endMatterSections(d) {
  if (!book || book.endMatterOff) return [];
  const author = authorForBook();
  const m = author.endMatter || {};
  const fill = (t) => String(t || "")
    .replace(/\{year\}/g, String(new Date().getFullYear()))
    .replace(/\{title\}/g, d.title || "")
    .replace(/\{author\}/g, d.author || author.name || "");
  const paras = (text, align) => parasFromHtml(fill(text).split(/\r?\n/).map((line) => line.trim())
    .filter(Boolean).map((line) => `<p${align ? ` style="text-align:${align}"` : ""}>${escHtml(line)}</p>`).join(""));
  const out = [];
  const add = (heading, text, align) => {
    const p = paras(text, align);
    if (p.length) out.push({ num: d.sections.length + out.length + 1, heading, paras: p, matter: true });
  };
  add(`Also by ${d.author || author.name}`, m.alsoBy, "center");
  add("About the Author", m.about, "");
  add("Copyright", m.copyright, "center");
  return out;
}

function withEndMatter(d) {
  const extra = endMatterSections(d);
  if (!extra.length) return d;
  // a one-chapter story exports without a heading; give it one once other
  // sections follow, so the reader can tell where the story ends
  const sections = d.sections.length === 1 && !d.sections[0].heading
    ? [{ ...d.sections[0], heading: d.title }]
    : d.sections;
  return { ...d, sections: [...sections, ...extra] };
}

/* ---------- Publishing details: one window, two tabs ---------- */
// File → Publishing Details… Everything NEO needs to dress a book for the
// outside world, per pen name:
//   Manuscript  — contact block for standard submissions (this computer only)
//   End matter  — Also by, About the Author, Copyright (added to exports)
// The byline is always the pen name, so it isn't asked for here.

function hasSubmissionDetails(author) {
  const s = author.submission || {};
  return !!(s.legalName || s.address || s.email || s.phone);
}

function openPublishingDetails({ tab = "manuscript", exportAfter = false } = {}) {
  const author = book ? authorForBook() : currentAuthor();
  const sub = author.submission || {};
  const m = author.endMatter || {};
  document.querySelector(".pub-backdrop")?.remove();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop pub-backdrop";
  bd.innerHTML = `
    <div class="modal ms-modal pub-modal">
      <div class="stats-modal-head"><h2 style="font-size:17px">Publishing details · ${escHtml(author.name || "Anonymous")}</h2><button class="m-cancel btn-quiet" title="Close">×</button></div>
      <div class="pub-tabs" role="tablist">
        <button role="tab" data-tab="manuscript">Manuscript</button>
        <button role="tab" data-tab="matter">End matter</button>
      </div>

      <section data-panel="manuscript">
        ${exportAfter ? '<p class="pub-note">Add your contact details once, then NEO exports the manuscript.</p>' : ""}
        <p class="soft">For standard submissions (File → Export → Manuscript Format): your contact block and a rounded word count go on page one. Kept on this computer only, never in your GitHub backup.</p>
        <label>Legal name <input data-f="legalName" value="${escHtml(sub.legalName || "")}" placeholder="${escHtml(author.name || "")}"/></label>
        <label>Mailing address <textarea data-f="address" rows="3" placeholder="Street&#10;City, State ZIP">${escHtml(sub.address || "")}</textarea></label>
        <div class="ms-row">
          <label>Phone <input data-f="phone" value="${escHtml(sub.phone || "")}"/></label>
          <label>Email <input data-f="email" value="${escHtml(sub.email || "")}"/></label>
        </div>
        <p class="soft pub-byline">Byline: <strong>${escHtml(author.name || "Anonymous")}</strong>, your pen name. Change it on the shelf or on a title page.</p>
      </section>

      <section data-panel="matter">
        <p class="soft">Added to the back of every ${escHtml(author.name || "")} book when you export it (EPUB, Word, PDF, web page, text). Your manuscript stays as it is. {year}, {title} and {author} fill themselves in.</p>
        <label>Also by <textarea data-m="alsoBy" rows="4" placeholder="One title per line">${escHtml(m.alsoBy || "")}</textarea></label>
        <div class="sync-actions" style="margin-top:4px"><button class="btn-quiet" data-fill>Fill from my shelves</button></div>
        <label>About the Author <textarea data-m="about" rows="4">${escHtml(m.about || "")}</textarea></label>
        <label>Copyright page <textarea data-m="copyright" rows="4" placeholder="Copyright © {year} {author}&#10;All rights reserved.">${escHtml(m.copyright || "")}</textarea></label>
        ${book ? `<label class="sync-switch" style="margin-top:12px"><input type="checkbox" data-include ${book.endMatterOff ? "" : "checked"}/> <span>Include in “${escHtml(book.title || "Untitled")}”</span></label>` : ""}
      </section>

      <div style="text-align:right;margin-top:14px"><button class="m-cancel btn-quiet">Cancel</button> <button class="m-ok btn-gold">${exportAfter ? "Save &amp; export manuscript" : "Save"}</button></div>
    </div>`;
  document.body.appendChild(bd);

  const show = (name) => {
    bd.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    bd.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
    bd.querySelector(`[data-panel="${name}"] input, [data-panel="${name}"] textarea`)?.focus();
  };
  bd.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  show(tab);

  const close = () => bd.remove();
  bd.querySelectorAll(".m-cancel").forEach((b) => (b.onclick = close));
  bd.querySelector("[data-fill]").onclick = async () => {
    const titles = [];
    for (const id of otherTitlesBy(author)) {
      const meta = await window.neo.readBookMeta(id);
      if (meta && meta.title && meta.title !== "Untitled") titles.push(meta.title);
    }
    bd.querySelector('[data-m="alsoBy"]').value = titles.join("\n");
    if (!titles.length) toast("No other titles on this pen name’s shelves yet");
  };
  bd.querySelector(".m-ok").onclick = async () => {
    author.submission = Object.fromEntries([...bd.querySelectorAll("[data-f]")].map((el) => [el.dataset.f, el.value.trim()]));
    author.endMatter = Object.fromEntries([...bd.querySelectorAll("[data-m]")].map((el) => [el.dataset.m, el.value.trim()]));
    await window.neo.writeLibrary(library);
    const include = bd.querySelector("[data-include]");
    if (include && book && book.endMatterOff !== !include.checked) {
      book.endMatterOff = !include.checked;
      scheduleMetaSave();
    }
    close();
    if (exportAfter) doExport("manuscript");
    else toast("Publishing details saved");
  };
  bd.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
}

/* ---------- EPUB (KDP-friendly: EPUB 3, nav + NCX TOC, cover image) ---------- */

// The cover that travels with an export: the writer's own image if they
// gave one, otherwise the shelf's abstract with the title set in type,
// rendered at KDP size. NEO's paintings never leave the shelf.
async function exportCover(d) {
  if (d.coverImage) {
    const c = await window.neo.readCover(d.id, d.coverImage);
    if (c) return { base64: c.base64, mime: c.mime, ext: c.ext };
  }
  await NeoCovers.ready;
  const url = NeoCovers.renderFull(d).toDataURL("image/jpeg", 0.9);
  return { base64: url.split(",")[1], mime: "image/jpeg", ext: "jpg" };
}

function chapterXhtml(ch, d) {
  let first = true;
  const paras = ch.paras.map((p) => {
    if (p.sceneBreak) { first = true; return '<p class="brk">* * *</p>'; }
    const classes = [];
    if (p.poetry) classes.push('poetry');
    else if (first) classes.push('first');
    if (p.align === 'center' || p.align === 'right') classes.push(p.align);
    const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
    if (!p.poetry) first = false;
    const inner = paraRuns(p.html).map((r) => {
      let t = escXml(r.text);
      if (r.i) t = '<em>' + t + '</em>';
      if (r.b) t = '<strong>' + t + '</strong>';
      return t;
    }).join('');
    return `<p${cls}>${inner}</p>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escXml(ch.heading || d.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><section epub:type="chapter">${ch.heading ? `<h1>${escXml(ch.heading)}</h1>` : ""}
${paras}
</section></body></html>`;
}

async function buildEpubEntries(data) {
  const d = data || bookExportData();
  const chapters = d.sections;
  const uuid = 'urn:uuid:' + (d.uuid || crypto.randomUUID());
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  // real cover art when the book has it; the shelf's cover otherwise
  const cover = await exportCover(d);
  const coverName = "cover." + cover.ext;
  const coverMime = cover.mime;
  const coverContent = cover.base64;
  const chItems = chapters
    .map(
      (ch) =>
        `<item id="ch${ch.num}" href="ch${ch.num}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const chSpine = chapters
    .map((ch) => `<itemref idref="ch${ch.num}"/>`)
    .join("\n");
  const navPoints = chapters
    .map(
      (ch) =>
        `<li><a href="ch${ch.num}.xhtml">${escXml(ch.heading || d.title)}</a></li>`,
    )
    .join("\n");
  const ncxPoints = chapters
    .map(
      (ch) => `
<navPoint id="ch${ch.num}" playOrder="${ch.num + 1}"><navLabel><text>${escXml(ch.heading || d.title)}</text></navLabel><content src="ch${ch.num}.xhtml"/></navPoint>`,
    )
    .join("");

  const entries = [
    { path: "mimetype", content: "application/epub+zip", store: true },
    {
      path: "META-INF/container.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    },
    {
      path: "OEBPS/content.opf",
      content: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uuid}</dc:identifier>
<dc:title>${escXml(d.title)}</dc:title>
<dc:creator>${escXml(d.author)}</dc:creator>
<dc:language>${escXml(d.language || 'en')}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
<meta name="cover" content="cover-image"/>
</metadata>
<manifest>
<item id="cover-image" href="${coverName}" media-type="${coverMime}" properties="cover-image"/>
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
<item id="titlepage" href="title.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
${chItems}
</manifest>
<spine toc="ncx">
<itemref idref="cover" linear="no"/>
<itemref idref="titlepage"/>
<itemref idref="nav"${chapters.length === 1 ? ' linear="no"' : ""}/>
${chSpine}
</spine>
<guide>
<reference type="cover" title="Cover" href="cover.xhtml"/>
<reference type="toc" title="Table of Contents" href="nav.xhtml"/>
<reference type="text" title="Beginning" href="ch1.xhtml"/>
</guide>
</package>`,
    },
    {
      path: "OEBPS/nav.xhtml",
      content: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Table of Contents</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1>
<ol>
<li><a href="title.xhtml">Title Page</a></li>
${navPoints}
</ol></nav>
<nav epub:type="landmarks" hidden=""><ol>
<li><a epub:type="cover" href="cover.xhtml">Cover</a></li>
<li><a epub:type="toc" href="nav.xhtml">Table of Contents</a></li>
<li><a epub:type="bodymatter" href="ch1.xhtml">Beginning</a></li>
</ol></nav>
</body></html>`,
    },
    {
      path: "OEBPS/toc.ncx",
      content: `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${uuid}"/></head>
<docTitle><text>${escXml(d.title)}</text></docTitle>
<navMap>
<navPoint id="titlepage" playOrder="1"><navLabel><text>Title Page</text></navLabel><content src="title.xhtml"/></navPoint>${ncxPoints}
</navMap></ncx>`,
    },
    {
      path: "OEBPS/style.css",
      content: `body { font-family: serif; line-height: 1.5; margin: 1em; }
h1 { text-align: center; font-weight: normal; letter-spacing: 0.2em; text-transform: uppercase; font-size: 1.2em; margin: 3em 0 2em; }
p { text-indent: 1.2em; margin: 0; }
p.first, p.brk + p { text-indent: 0; }
p.center { text-align: center; text-indent: 0; }
p.right { text-align: right; text-indent: 0; }
p.brk { text-align: center; text-indent: 0; margin: 2.5em 0; letter-spacing: 0.5em; }
p.poetry { text-indent: 0; margin: 0 2em; }
p:not(.poetry) + p.poetry, h1 + p.poetry { margin-top: 0.9em; }
p.poetry + p:not(.poetry) { margin-top: 0.9em; }
.titlepage { text-align: center; margin-top: 30%; }
.titlepage h2 { font-size: 2em; margin: 0; }
.titlepage .sub { font-style: italic; }
.titlepage .auth { margin-top: 4em; letter-spacing: 0.3em; text-transform: uppercase; }
.coverimg { text-align: center; margin: 0; padding: 0; }
.coverimg img { max-width: 100%; max-height: 100%; }`,
    },
    {
      path: "OEBPS/cover.xhtml",
      content: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><div class="coverimg"><img src="${coverName}" alt="${escXml(d.title)}"/></div></body></html>`,
    },
    {
      path: "OEBPS/title.xhtml",
      content: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escXml(d.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><div class="titlepage"><h2>${escXml(d.title)}</h2>
${d.subtitle ? `<p class="sub">${escXml(d.subtitle)}</p>` : ""}
<p class="auth">${escXml(d.author)}</p></div></body></html>`,
    },
    { path: "OEBPS/" + coverName, content: coverContent, base64: true },
  ];
  for (const ch of chapters) {
    entries.push({
      path: `OEBPS/ch${ch.num}.xhtml`,
      content: chapterXhtml(ch, d),
    });
  }
  return entries;
}

/* ---------- ANTHOLOGY: a whole shelf becomes one book ---------- */

// Read every book on a shelf from disk and merge into export sections.
// Each story's title becomes its TOC entry; multi-chapter works keep
// their chapters as continuation sections.
async function shelfExportData(shelf, anthologyTitle) {
  const sections = [];
  let num = 0;
  for (const bookId of shelf.bookIds) {
    const meta = await window.neo.readBookMeta(bookId);
    if (!meta || !meta.chapterOrder) continue;
    const multi = meta.chapterOrder.length > 1;
    for (let i = 0; i < meta.chapterOrder.length; i++) {
      const html = await window.neo.readChapter(bookId, meta.chapterOrder[i]);
      const paras = parasFromHtml(html);
      if (!paras.length) continue;
      num++;
      const t = (meta.chapterTitles || {})[meta.chapterOrder[i]];
      const heading = !multi
        ? meta.title
        : i === 0
          ? meta.title
          : `${meta.title} — Chapter ${i + 1}${t ? ": " + t : ""}`;
      sections.push({ num, heading, paras });
    }
  }
  return {
    id: "shelf-" + shelf.id,
    title: anthologyTitle,
    subtitle: "",
    author: displayAuthor(),
    coverSeed: shelf.id + ":" + anthologyTitle,
    sections,
  };
}

async function exportShelfAnthology(shelf) {
  if (!shelf.bookIds.length) {
    toast("This shelf has no books on it yet");
    return;
  }
  const title = await askInput(
    "Anthology title",
    "Shown on the title page, cover, and metadata",
    shelf.name,
  );
  if (title === null) return;
  const format = await optionModal("Export the anthology as…", null, [
    {
      label: "EPUB",
      desc: "For ebook stores — the TOC lists every story.",
      value: "epub",
    },
    {
      label: "Word (.docx)",
      desc: "For editors — each story starts on a new page.",
      value: "docx",
    },
    { label: "PDF", desc: "For reading, sharing, and print.", value: "pdf" },
  ]);
  if (!format) return;
  toast("Collecting the shelf…");
  const data = await shelfExportData(shelf, title || shelf.name);
  if (!data.sections.length) {
    toast("No words found on this shelf yet");
    return;
  }
  const defaultName = safeName(data.title);
  let payload;
  if (format === "docx")
    payload = { format, defaultName, zipEntries: buildDocxEntries(data) };
  else if (format === "epub")
    payload = { format, defaultName, zipEntries: await buildEpubEntries(data) };
  else
    payload = {
      format: "pdf",
      defaultName,
      content: buildHtml(data, { cover: await exportCover(data) }),
    };
  const saved = await window.neo.exportSave(payload);
  if (saved)
    toast(
      `Anthology of ${shelf.bookIds.length} works exported: ` +
        saved.split("/").pop(),
      6000,
    );
}

async function doExport(format) {
  if (!book) {
    toast("Open a book first");
    return;
  }
  flushAllSaves();
  const defaultName = safeName(book.title);
  let payload;
  if (format === "manuscript") {
    const author = authorForBook();
    if (!hasSubmissionDetails(author)) {
      openPublishingDetails({ tab: "manuscript", exportAfter: true });
      return;
    }
    const d = bookExportData();
    payload = { format: "docx", defaultName: defaultName + " - manuscript", zipEntries: buildManuscriptDocxEntries(d, { ...author.submission, byline: author.name }) };
  } else {
    const d = withEndMatter(bookExportData());
    if (format === "docx")
      payload = { format, defaultName, zipEntries: buildDocxEntries(d) };
    else if (format === "epub")
      payload = { format, defaultName, zipEntries: await buildEpubEntries(d) };
    else if (format === "txt")
      payload = { format, defaultName, content: buildTxt(d) };
    else if (format === "md")
      payload = { format, defaultName, content: buildMd(d) };
    else
      payload = { format, defaultName, content: buildHtml(d, { cover: await exportCover(d) }) };
  }
  const saved = await window.neo.exportSave(payload);
  if (saved) toast("Exported: " + saved.split("/").pop());
}

function chooseEmailMethod() {
  // Apple Mail only exists on Macs; elsewhere Gmail
  if (!navigator.platform.toLowerCase().includes("mac"))
    return Promise.resolve("gmail");
  return new Promise((resolve) => {
    const bd = document.createElement("div");
    bd.className = "modal-backdrop";
    bd.innerHTML = `
      <div class="modal" style="width:440px">
        <h2 style="font-size:16px">How should NEO email your drafts?</h2>
        <div class="fr-choices" style="margin-top:14px">
          <button class="fr-choice" data-m="gmail">
            <strong>Gmail</strong>
            <span>Opens a pre-filled compose window in your browser. NEO shows you the PDF to drag into it.</span>
          </button>
          <button class="fr-choice" data-m="mail">
            <strong>Apple Mail</strong>
            <span>Fully automatic — the PDF is attached and addressed. Just hit send.</span>
          </button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    bd.querySelectorAll(".fr-choice").forEach((b) => {
      b.onclick = () => {
        bd.remove();
        resolve(b.dataset.m);
      };
    });
  });
}

async function emailSettings() {
  const addr = await askInput(
    "Email drafts to",
    "you@example.com",
    library.emailAddress || "",
  );
  if (addr === null) return false;
  if (addr) library.emailAddress = addr;
  library.emailMethod = await chooseEmailMethod();
  await window.neo.writeLibrary(library);
  toast("Email settings saved");
  return true;
}

async function manuscriptHash() {
  // SHA-256 of the manuscript text: a fingerprint for your provenance trail
  const text =
    book.title + "\n" + book.chapterOrder.map((c) => chapterText(c)).join("\n");
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function doEmailDraft() {
  if (!book) {
    toast("Open a book first");
    return;
  }
  flushAllSaves();
  if (!library.emailAddress || !library.emailMethod) {
    const ok = await emailSettings();
    if (!ok) return;
  }
  const total = bookWordCount();
  const subject = `NEO draft — ${book.title} — ${total.toLocaleString()} words — ${new Date().toLocaleDateString()}`;
  const hash = await manuscriptHash();
  const body =
    `Draft snapshot of "${book.title}" — ${total.toLocaleString()} words.\n` +
    `Sent from NEO on ${new Date().toLocaleString()}.\n\n` +
    `SHA-256 fingerprint of the manuscript text:\n${hash}\n\n` +
    (library.emailMethod === "gmail"
      ? "The PDF snapshot is in the Finder window NEO just opened — drag it into this email before sending."
      : "PDF snapshot attached.");
  toast("Preparing your draft…");
  const res = await window.neo.emailDraft({
    to: library.emailAddress,
    subject,
    body,
    html: buildHtml(null, { stamp: true }), // the email snapshot is a provenance record
    defaultName: safeName(book.title),
    method: library.emailMethod,
  });
  if (res.method === "gmail")
    toast(
      "Gmail compose opened — drag in the PDF NEO revealed, then send",
      8000,
    );
  else if (res.ok) toast("Draft handed to Mail — hit send for your timestamp");
  else
    toast("Mail unavailable — snapshot saved to your Exports folder instead");
}

// Help → Check for Update…: on-demand release lookup, only ever runs on a click
async function checkForUpdate() {
  const res = await window.neo.checkForUpdate();
  if (res.error) {
    toast("Couldn't check for updates — try again later");
    return;
  }
  if (!res.hasUpdate) {
    toast(`You're on the latest version (${res.currentVersion})`);
    return;
  }
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal" style="width:380px">
      <h2 style="font-size:16px">NEO ${res.latestVersion} is available</h2>
      <p>You have ${res.currentVersion}.</p>
      <div style="text-align:right;margin-top:14px">
        <button class="m-cancel btn-quiet" style="margin-right:10px">Later</button>
        <button class="m-ok btn-gold">View Release</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.querySelector(".m-cancel").onclick = close;
  bd.querySelector(".m-ok").onclick = () => {
    window.neo.openRelease();
    close();
  };
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
}

// Help → About NEO: the version, plainly
async function showAbout() {
  const v = await window.neo.appVersion();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal" style="width:340px;text-align:center">
      <h2 style="font-size:22px;letter-spacing:6px">NEO</h2>
      <p style="color:#999">Version ${v}</p>
      <p style="font-size:13px;color:#777">A word processor for authors.</p>
      <div style="margin-top:16px">
        <button class="m-ok btn-gold">Back to writing</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.querySelector(".m-ok").onclick = close;
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  bd.querySelector(".m-ok").focus();
}

window.neo.onMenu(async (msg) => {
  if (msg.type === "flush") {
    flushAllSaves();
    finishPendingCheckpoint("quit");
    window.neo.flushComplete();
  }
  if (msg.type === "help") showHelp();
  if (msg.type === "about") showAbout();
  if (msg.type === "checkUpdate") checkForUpdate();
  if (msg.type === "export") doExport(msg.format);
  if (msg.type === "emailDraft") doEmailDraft();
  if (msg.type === "emailSettings") emailSettings();
  if (msg.type === "find") openSearch();
  if (msg.type === "spellcheck") toggleSpellcheck();
  if (msg.type === "spellLanguage") changeSpellLanguage(msg.value);
  if (msg.type === "revisionPass") toggleRevisionPass();
  if (msg.type === "readAloud") toggleReadAloud();
  if (msg.type === "publishingDetails") openPublishingDetails({ tab: msg.tab || "manuscript" });
  if (msg.type === "typewriter") toggleTypewriter();
  if (msg.type === "focusMode") toggleFocusMode();
  if (msg.type === "import") importBooks();
  if (msg.type === "stats") openStats();
  if (msg.type === "syncSettings") openSyncSettings();
  if (msg.type === "gitAutoPushError") {
    const { text, starter } = ipcErrorText(msg.message, "open Sync Settings to retry");
    toast(starter ? "GitHub backup paused: the repository has starter files. Open Sync Settings to replace them." : `GitHub backup failed: ${text}`, 7000);
  }
  if (msg.type === "plugins") openPlugins();
  if (msg.type === "coverArt") openCoverArt();
  if (msg.type === "align") {
    applyAlign(msg.value);
  }
  if (msg.type === 'poetry') togglePoetry();
  if (msg.type === 'uiBright') {
    library.uiBright = !library.uiBright;
    await window.neo.writeLibrary(library);
    applyFonts();
  }
  if (msg.type === "pageTheme") {
    library.pageTheme = msg.value;
    await window.neo.writeLibrary(library);
    applyFonts();
    applyPluginAppearance();
  }
  if (msg.type === "fontSize") {
    const cur = library.editorFontSize || 17;
    library.editorFontSize =
      msg.value === 0 ? 17 : Math.min(22, Math.max(14, cur + msg.value));
    if (msg.value === 0) library.pageZoom = 1; // ⌘0 resets pinch zoom too
    await window.neo.writeLibrary(library);
    applyFonts();
  }
  if (msg.type === "bodyFontPick") {
    const name = await pickLocalFont();
    if (name) {
      library.fonts = library.fonts || {};
      library.fonts.body = name;
      await window.neo.writeLibrary(library);
    }
    applyFonts(); // also undoes a hover preview after Cancel
  }
  if (msg.type === "bodyFont") {
    library.fonts = library.fonts || {};
    library.fonts.body = msg.value;
    await window.neo.writeLibrary(library);
    applyFonts();
  }
  if (msg.type === "dropCap") {
    library.fonts = library.fonts || {};
    library.fonts.dropcap = msg.value;
    await window.neo.writeLibrary(library);
    applyFonts();
  }
});

/* ================================================================== */
/*  SAFETY NET — errors get logged, never eaten silently               */
/* ================================================================== */

let errorToastShown = false;
function reportError(msg) {
  window.neo.logError(msg);
  if (!errorToastShown) {
    errorToastShown = true;
    toast(
      "Something hiccuped — your words are safe, and the details were logged",
    );
  }
}
window.addEventListener("error", (e) =>
  reportError(`${e.message} @ ${e.filename}:${e.lineno}`),
);
window.addEventListener("unhandledrejection", (e) =>
  reportError("Unhandled: " + ((e.reason && e.reason.stack) || e.reason)),
);

/* ================================================================== */
/*  Linux body fonts                                                   */
/*  Georgia, Palatino, Baskerville, Hoefler Text, and Iowan Old Style  */
/*  are not on Linux. The bundled faces below are what the Format menu */
/*  and the first-run picker offer instead. Old libraries still resolve */
/*  the macOS names, but those names stay out of the picker.           */
/* ================================================================== */

const LINUX_BODY_FONTS = {
  'Gelasio': '"Gelasio", Georgia, "Times New Roman", serif',
  'TeX Gyre Pagella': '"TeX Gyre Pagella", Palatino, "Palatino Linotype", serif',
  'Libre Baskerville': '"Libre Baskerville", Baskerville, Georgia, serif',
  'Alegreya': '"Alegreya", "Hoefler Text", Georgia, serif',
  'Source Serif Pro': '"Source Serif Pro", "Iowan Old Style", Georgia, serif'
};

function installLinuxBodyFonts() {
  if (IS_MAC || /win/i.test(navigator.platform)) return;
  const legacy = {
    Georgia: LINUX_BODY_FONTS.Gelasio,
    Palatino: LINUX_BODY_FONTS['TeX Gyre Pagella'],
    Baskerville: LINUX_BODY_FONTS['Libre Baskerville'],
    'Hoefler Text': LINUX_BODY_FONTS.Alegreya,
    'Iowan Old Style': LINUX_BODY_FONTS['Source Serif Pro'],
    Cambria: LINUX_BODY_FONTS['Source Serif Pro'],
    Constantia: LINUX_BODY_FONTS['Libre Baskerville']
  };
  for (const key of Object.keys(BODY_FONTS)) delete BODY_FONTS[key];
  Object.assign(BODY_FONTS, LINUX_BODY_FONTS);
  for (const [key, stack] of Object.entries(legacy)) {
    Object.defineProperty(BODY_FONTS, key, {
      value: stack, enumerable: false, writable: true, configurable: true
    });
  }
  DROPCAP_FONTS.literary = '"Libre Bodoni", "Didot", "Bodoni 72", Georgia, serif';
  DROPCAP_FONTS.fantasy = '"TeX Gyre Chorus", "Apple Chancery", "Snell Roundhand", cursive';
  DROPCAP_FONTS.scifi = '"Jost", Futura, "Avenir Next", "Helvetica Neue", sans-serif';
  // A shared choice list, when the renderer defines one, has to name these
  // bundled faces on Linux rather than fonts the machine does not have.
  if (typeof BODY_FONT_CHOICES !== 'undefined') {
    BODY_FONT_CHOICES.splice(0, BODY_FONT_CHOICES.length, ...Object.keys(LINUX_BODY_FONTS));
  }
}
installLinuxBodyFonts();

/* ================================================================== */

loadLibrary().then(() => {
  applyFonts();
  applyPluginAppearance();
  typewriterEnabled = !!library.typewriter;
  applyTypewriter();
  focusModeOn = !!library.focusMode;
  applyFocusMode();
});
