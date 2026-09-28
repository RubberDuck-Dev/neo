"use strict";

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
  if (caretP) NeoPlugins.notify("selection");
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
  if (e.defaultPrevented) return;
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
  const french = frenchTypography();
  const spaced = french === 'ca' ? /^:$/ : /^[;:!?]$/;
  if (french && spaced.test(e.key) && /^[ \u00a0]$/.test(prevChars(1))) {
    e.preventDefault();
    document.execCommand('delete');
    document.execCommand('insertText', false, '\u202f' + e.key);
    return;
  }
  if (e.key === '"' || e.key === "'") {
    e.preventDefault();
    const before = prevChars(1);
    const opening = before === "" || /[\s\(\[\{—‘“«„>]/.test(before);
    const q = quoteStyle();
    const ch = e.key === '"' ? (opening ? q.open : q.close) : (q.singles && opening ? '‘' : '’');
    document.execCommand("insertText", false, ch);
  }
}

const QUOTE_STYLES = {
  en: { open: '“', close: '”', singles: true }, nl: { open: '“', close: '”', singles: true },
  pt: { open: '“', close: '”', singles: true }, 'pt-PT': { open: '«', close: '»' },
  fr: { open: '«\u202f', close: '\u202f»' }, es: { open: '«', close: '»' },
  it: { open: '«', close: '»' }, de: { open: '„', close: '“' }, pl: { open: '„', close: '”' }
};
function writingLanguage() { return library?.spellLanguage || NeoI18n.getLocale(); }
function quoteStyle() {
  const code = writingLanguage();
  return QUOTE_STYLES[code] || QUOTE_STYLES[code.split('-')[0]] || QUOTE_STYLES.en;
}
function frenchTypography() {
  if (!writingLanguage().startsWith('fr')) return false;
  return /^fr-CA$/i.test(NeoI18n.getLocale()) ? 'ca' : 'fr';
}
document.addEventListener('keydown', e => {
  const el = e.target;
  if (!e.defaultPrevented && el?.isContentEditable && !el.closest('.chapter-body')) smartKeys(e, el);
}, true);

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
  persistChapter(chId);
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
  // a save still queued for this chapter must not resurrect it (nejcc, #70)
  clearTimeout(saveTimers[chId]);
  delete saveTimers[chId];
  dirtyChapters.delete(chId);
  await chapterWrites.get(book.id + '/' + chId);
  book.chapterOrder = book.chapterOrder.filter((c) => c !== chId);
  delete chapterHTML[chId];
  delete savedHTML[chId];
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
