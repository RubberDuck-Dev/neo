"use strict";

/* ================================================================== */
/*  PUBLISHING — manuscript format, end matter, details               */
/* ================================================================== */

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

/* ---------- Shared author pages ---------- */
// Copyright, About the Author, and Also By remain pen-name defaults. A book
// adds its own front and back pages in book.frontMatter / book.backMatter.

function otherTitlesBy(author) {
  const homeId = library.authors[0].id;
  const ids = library.shelves.filter((s) => (s.authorId || homeId) === author.id).flatMap((s) => s.bookIds);
  return ids.filter((id) => !book || id !== book.id);
}

/* ---------- Publishing details: contact, front matter, back matter ---------- */
// File → Publishing Details… Everything NEO needs to dress a book for the
// outside world, per pen name:
//   Manuscript  — contact block for standard submissions (this computer only)
//   Front matter — book pages plus the pen name's copyright default
//   Back matter  — book pages plus the pen name's About/Also By pages
// The byline is always the pen name, so it isn't asked for here.

function hasSubmissionDetails(author) {
  const s = author.submission || {};
  return !!(s.legalName || s.address || s.email || s.phone);
}

const manuscriptLanguages = [
  ["en", "English"], ["en-US", "English (US)"], ["en-GB", "English (UK)"],
  ["en-CA", "English (Canada)"], ["en-AU", "English (Australia)"],
  ["fr", "French"], ["es", "Spanish"],
  ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
  ["nl", "Dutch"], ["ru", "Russian"], ["zh-Hans", "Chinese (Simplified)"],
  ["zh-Hant", "Chinese (Traditional)"], ["ja", "Japanese"],
  ["ko", "Korean"], ["ar", "Arabic"], ["hi", "Hindi"]
];

function openPublishingDetails({ tab = "manuscript", exportAfter = false } = {}) {
  const author = book ? authorForBook() : currentAuthor();
  const sub = author.submission || {};
  const m = author.endMatter || {};
  const front = book?.frontMatter || {};
  const back = book?.backMatter || {};
  const bookLanguage = book ? NeoLanguage.manuscriptLanguage(book) : "";
  const knownLanguage = manuscriptLanguages.some(([code]) => code === bookLanguage);
  document.querySelector(".pub-backdrop")?.remove();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop pub-backdrop";
  bd.innerHTML = `
    <div class="modal ms-modal pub-modal settings-dialog">
      <div class="stats-modal-head dialog-head"><div><h2>Publishing details</h2><p class="dialog-scope">This author · ${escHtml(author.name || "Anonymous")}</p></div><button class="m-cancel btn-quiet" title="Close">×</button></div>
      <div class="dialog-body"><div class="pub-tabs" role="tablist">
        <button role="tab" data-tab="manuscript">Manuscript</button>
        <button role="tab" data-tab="front">Front matter</button>
        <button role="tab" data-tab="matter">Back matter</button>
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
        ${book ? `<div class="pub-book-language"><label>Language of “${escHtml(book.title || "Untitled")}”
          <select id="pub-language">${manuscriptLanguages.map(([code, name]) => `<option value="${code}"${bookLanguage === code ? " selected" : ""}>${name}</option>`).join("")}<option value="other"${knownLanguage ? "" : " selected"}>Other language…</option></select></label>
          <label id="pub-language-other-row"${knownLanguage ? " hidden" : ""}>Language tag <input id="pub-language-other" value="${knownLanguage ? "" : escHtml(bookLanguage)}" placeholder="e.g. sw or cy"/></label>
          <p class="soft">Set from your spellcheck choice when the book was created. Change it here for exports and writing tools.</p><p class="dialog-error" role="status"></p></div>` : ""}
      </section>

      <section data-panel="front">
        <p class="soft">Each filled page exports before the story. These pages stay outside your manuscript chapters.</p>
        ${book ? `<label>Half title <input data-front="halfTitle" value="${escHtml(front.halfTitle || '')}" placeholder="${escHtml(book.title || 'Book title')}"/></label>` : '<p class="soft">Open a book to add its half title or dedication.</p>'}
        <label>Copyright <textarea data-m="copyright" rows="4" placeholder="Copyright © {year} {author}&#10;All rights reserved.">${escHtml(m.copyright || '')}</textarea></label>
        <p class="soft">Copyright is shared by this pen name. {year}, {title}, and {author} fill in at export.</p>
        ${book ? `<label>Dedication <textarea data-front="dedication" rows="3">${escHtml(front.dedication || '')}</textarea></label>` : ''}
      </section>

      <section data-panel="matter">
        <p class="soft">Each filled page exports after the story. About the Author and Also By are shared by this pen name.</p>
        ${book ? `<label>Acknowledgments <textarea data-back="acknowledgments" rows="4">${escHtml(back.acknowledgments || '')}</textarea></label>` : '<p class="soft">Open a book to add acknowledgments.</p>'}
        <label>Also by <textarea data-m="alsoBy" rows="4" placeholder="One title per line">${escHtml(m.alsoBy || "")}</textarea></label>
        <div class="sync-actions" style="margin-top:4px"><button class="btn-quiet" data-fill>Fill from my shelves</button></div>
        <label>About the Author <textarea data-m="about" rows="4">${escHtml(m.about || "")}</textarea></label>
        ${book ? `<label class="sync-switch" style="margin-top:12px"><input type="checkbox" data-include ${book.endMatterOff ? "" : "checked"}/> <span>Include shared author pages in “${escHtml(book.title || "Untitled")}”</span></label>` : ""}
      </section>

      </div><div class="dialog-footer"><button class="m-cancel btn-quiet">Cancel</button> <button class="m-ok btn-gold">${exportAfter ? "Save &amp; export manuscript" : "Save"}</button></div>
    </div>`;
  document.body.appendChild(bd);

  const show = (name) => {
    bd.querySelectorAll("[data-tab]").forEach((b) => {
      const selected = b.dataset.tab === name;
      b.classList.toggle("active", selected);
      b.setAttribute('aria-selected', String(selected));
      b.tabIndex = selected ? 0 : -1;
    });
    bd.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
    bd.querySelector(`[data-panel="${name}"] input, [data-panel="${name}"] textarea`)?.focus();
  };
  bd.querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => show(b.dataset.tab);
    b.onkeydown = event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const tabs = [...bd.querySelectorAll('.pub-tabs [data-tab]')];
      const next = tabs[(tabs.indexOf(b) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.click(); next.focus();
    };
  });
  const languageSelect = bd.querySelector("#pub-language");
  if (languageSelect) languageSelect.onchange = () => {
    bd.querySelector("#pub-language-other-row").hidden = languageSelect.value !== "other";
  };
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
    let nextLanguage = "";
    if (languageSelect) {
      const raw = languageSelect.value === "other" ? bd.querySelector("#pub-language-other").value.trim() : languageSelect.value;
      try { nextLanguage = Intl.getCanonicalLocales(raw)[0]; if (!nextLanguage) throw new Error("empty tag"); }
      catch {
        show("manuscript");
        bd.querySelector(".pub-book-language [role='status']").textContent = "Choose a language, or enter a tag such as sw or cy.";
        bd.querySelector(languageSelect.value === "other" ? "#pub-language-other" : "#pub-language").focus();
        return;
      }
    }
    author.submission = Object.fromEntries([...bd.querySelectorAll("[data-f]")].map((el) => [el.dataset.f, el.value.trim()]));
    author.endMatter = Object.fromEntries([...bd.querySelectorAll("[data-m]")].map((el) => [el.dataset.m, el.value.trim()]));
    if (book) {
      book.frontMatter = { ...book.frontMatter, ...Object.fromEntries([...bd.querySelectorAll('[data-front]')].map(el => [el.dataset.front, el.value.trim()])) };
      book.backMatter = { ...book.backMatter, ...Object.fromEntries([...bd.querySelectorAll('[data-back]')].map(el => [el.dataset.back, el.value.trim()])) };
      scheduleMetaSave();
    }
    await window.neo.writeLibrary(library);
    if (book && nextLanguage && book.language !== nextLanguage) {
      book.language = nextLanguage;
      scheduleMetaSave();
    }
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
