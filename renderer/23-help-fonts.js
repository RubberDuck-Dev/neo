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
  const bodyFont = currentAuthor().bodyFont || f.body || 'Georgia';
  if (bodyFont) {
    document.documentElement.style.setProperty(
      "--body-font",
      bodyFontStack(bodyFont),
    );
  }
  if (f.dropcap && DROPCAP_FONTS[f.dropcap]) {
    document.documentElement.style.setProperty(
      "--dropcap-font",
      DROPCAP_FONTS[f.dropcap],
    );
  }
  document.body.classList.toggle('no-dropcap', f.dropcap === 'none');
  document.body.classList.toggle("night", library.pageTheme === "night");
  document.body.classList.toggle("bright", !!library.uiBright);
  const size = Math.min(22, Math.max(14, library.editorFontSize || 17));
  document.documentElement.style.setProperty("--editor-size", size + "px");
  const zoom = Math.min(1.6, Math.max(0.75, library.pageZoom || 1));
  document.documentElement.style.setProperty("--page-zoom", zoom);
  updateZoomDisplay();
  if (window.neo.viewState) window.neo.viewState({ pageTheme: library.pageTheme, uiBright: library.uiBright, focus: focusLevel });
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
    const current = currentAuthor().bodyFont || (library.fonts || {}).body || 'Georgia';
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
  const existing = document.querySelector('.help-modal-backdrop');
  if (existing) { existing.querySelector('.dialog-close').click(); return; }
  const row = (key, action) => `<span class="hk">${key}</span><span>${action}</span>`;
  const group = (title, rows) => `<h3 class="help-sec">${title}</h3><div class="help-grid">${rows.join('')}</div>`;
  const {bd, close} = settingsDialog({
    title:'Keyboard shortcuts', scope:'Use these while writing or planning.', className:'help-dialog',
    content: [
      group('Write', [
        row('Enter ×2','Insert a section break.'),
        row('Enter ×3','Start a chapter.'),
        row(K('⇧Enter','Shift+Enter'),'Write a poetry paragraph; press Enter to return to prose.'),
        row(K('⌘B / ⌘I','Ctrl+B / Ctrl+I'),'Toggle bold or italic.'),
        row(KPH,'Add a placeholder note.'),
        row(KDA,'Move selected text to Darlings.'),
        row('-- / ...','Insert an em dash or ellipsis.')
      ]),
      group('Edit and review', [
        row(KZ,'Undo typing; undo structural changes outside text fields.'),
        row(K('⌘⇧Z','Ctrl+Y'),'Redo typing.'),
        row(K('⌘X / ⌘C / ⌘V','Ctrl+X / Ctrl+C / Ctrl+V'),'Cut, copy, or paste.'),
        row(K('⌘⌥⇧V','Ctrl+Shift+V'),'Paste without formatting.'),
        row(K('⌘A','Ctrl+A'),'Select all text.'),
        row(K('⌘F','Ctrl+F'),'Find and replace; search the library from the shelf.'),
        row('Enter / Shift+Enter','Find the next or previous match in search.'),
        row(K('⌘;','Ctrl+;'),'Check spelling.'),
        row(K('⌘⇧;','Ctrl+Shift+;'),'Review repeated words and style.'),
        row(K('⌘⌥R','Ctrl+Alt+R'),'Read aloud; press any key to stop.'),
        row(K('⌘⇧L / C / R / J','Ctrl+Shift+L / C / R / J'),'Align left, center, right, or justify.')
      ]),
      group('Outline and cards', [
        row(K('⌘⌥C','Ctrl+Alt+C'),'Switch Outline and Cards with the Cards plugin enabled.'),
        row('Enter','Add an outline line or card subsection.'),
        row('Tab / Shift+Tab','Indent or outdent an outline line.'),
        row('Backspace','Remove an empty outline line or subsection.'),
        row('Alt+arrow keys','Move a card while its drag grip is focused.'),
        row('Right-click a card','Delete its chapter; keep prose in Darlings.')
      ]),
      group('Navigate and view', [
        row(K('⌘PgUp','Ctrl+PgUp'),'Open the previous screen.'),
        row(K('⌘PgDn','Ctrl+PgDn'),'Open the next screen.'),
        row(K('⌘⇧O','Ctrl+Shift+O'),'Cycle paragraph focus, sentence focus, and off.'),
        row(K('⌘⇧T','Ctrl+Shift+T'),'Toggle typewriter scrolling.'),
        row(K('⌘⇧F','Ctrl+Shift+F'),'Toggle full screen.'),
        row(K('⌘+ / ⌘−','Ctrl++ / Ctrl+−'),'Increase or decrease text size.'),
        row(K('Pinch','Ctrl+Scroll'),'Zoom the page.'),
        row(K('⌘0','Ctrl+0'),'Reset text size and page zoom.'),
        row('Esc','Close the active panel or return to the shelf.')
      ]),
      group('Files and settings', [
        row(K('⌘⇧I','Ctrl+Shift+I'),'Import a manuscript.'),
        row(K('⌘E','Ctrl+E'),'Email a draft to yourself.'),
        row(K('⌘,','Ctrl+,'),'Open preferences.'),
        row(K('⌘⇧P','Ctrl+Shift+P'),'Open the Plugin Library.'),
        row(K('⌘/','Ctrl+/'),'Show these shortcuts.')
      ]),
      group('Use the mouse', [
        row('Hover page edges','Show chapters on the left or notes on the right.'),
        row('Drag a grip','Reorder chapters or cards.'),
        row('Drag selected text','Save it on the Darlings tab.'),
        row('Right-click','Manage books, shelves, chapters, or outline lines.'),
        row('Double-click a tab','Rename the tab.'),
        row('Click counters','Change word counts or open goals.')
      ])
    ].join(''),
    actions:'<button class="m-ok btn-gold">Done</button>'
  });
  bd.classList.add('help-modal-backdrop');
  bd.querySelector('.m-ok').onclick = close;
}
