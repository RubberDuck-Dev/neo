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
