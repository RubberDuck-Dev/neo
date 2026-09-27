"use strict";

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
  const re = /[^.!?…。！？]+(?:[.!?…。！？]+["”’)\]]*|$)\s*/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    const end = m.index + m[0].trimEnd().length;
    if (end <= skip) continue;
    const start = m.index; // the caret's whole sentence, not half of it
    const said = text.slice(start, end).trim();
    if (!/[\p{L}\p{N}]/u.test(said)) continue;
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

// The writer's chosen voice and speed (Edit → Read Aloud Settings).
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
    const sample = readAloudUtterance("It was a dark and stormy night. This is how your pages will sound.");
    sample.rate = Number(rate.value) || 1;
    sample.voice = window.speechSynthesis.getVoices().find(v => v.name === select.value) || null;
    sample.lang = sample.voice?.lang || '';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(sample);
  };
  return (save = true) => {
    if (save) apply();
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
