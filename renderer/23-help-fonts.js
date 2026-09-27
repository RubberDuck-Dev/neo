"use strict";

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
        ${row(K('⌘⇧L/C/R/J', 'Ctrl+Shift+L/C/R/J'), 'Align paragraph: left, center, right, justify')}
        ${row(K('⌘⇧O', 'Ctrl+Shift+O'), 'Cycle focus — paragraph, sentence, off')}
        ${row(K('⌘⌥R', 'Ctrl+Alt+R'), 'Read aloud from the caret, or the selection. Any key stops it')}
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
