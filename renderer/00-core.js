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
