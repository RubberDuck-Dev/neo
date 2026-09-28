"use strict";

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
    const title = (book.chapterTitles || {})[chId];
    // chapterless stories export as continuous text
    const heading =
      book.chapterOrder.length === 1
        ? ""
        : library.exportCustomChapterTitles && title
          ? title
          : "Chapter " + (i + 1) + (title ? " — " + title : "");
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
    language: NeoLanguage.manuscriptLanguage(book),
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
  // a title like "Wool *Omnibus*" must not turn into markup (idea: nejcc, #70)
  const mdMeta = (s) => String(s || '').replace(/([\\`*_\[\]#<>])/g, '\\$1');
  // wrap a run in emphasis markers, keeping boundary spaces outside them
  const mdRun = (r) => {
    let t = r.text.replace(/([\\*_`])/g, '\\$1');
    const mark = r.b && r.i ? "***" : r.b ? "**" : r.i ? "*" : "";
    if (!mark) return t;
    const lead = t.match(/^\s*/)[0];
    const trail = t.match(/\s*$/)[0];
    const core = t.slice(lead.length, t.length - trail.length);
    return core ? lead + mark + core + mark + trail : t;
  };
  let out = `# ${mdMeta(d.title)}\n\n`;
  if (d.subtitle) out += `*${mdMeta(d.subtitle)}*\n\n`;
  out += `**by ${mdMeta(d.author)}**\n\n`;
  for (const ch of d.sections) {
    if (ch.heading) out += `\n## ${mdMeta(ch.heading)}\n\n`;
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
      ${ch.heading ? `<h2>${escHtml(ch.heading)}</h2>` : ''}
      ${paras}
    </section>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escHtml(d.title)}</title>
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
  ${(library.fonts || {}).dropcap === 'none' ? '' : '.chapter h2 + p:not(.poetry)::first-letter, .chapter p.first::first-letter { font-size: 1.8em; line-height: 1; }'}
  .brk { text-align: center; text-indent: 0 !important; letter-spacing: 8px; color: #888; margin: 2.5em 0; }
  .chapter p.poetry { text-indent: 0; margin: 0 2.5em; }
  .chapter p:not(.poetry) + p.poetry, .chapter h2 + p.poetry { margin-top: 0.9em; }
  .chapter p.poetry + p:not(.poetry) { margin-top: 0.9em; }
  .prov { margin-top: 80px; text-align: center; color: #999; font-size: 9pt; }
</style></head><body>
${opts.cover ? `<div class="coverpage"><img src="data:${opts.cover.mime};base64,${opts.cover.base64}" alt="Cover"/></div>` : ''}
<div class="titlepage"><h1>${escHtml(d.title)}</h1>
${d.subtitle ? `<p class="sub">${escHtml(d.subtitle)}</p>` : ''}
<p class="auth">${escHtml(d.author)}</p></div>
${chaptersHtml}
${opts.stamp ? `<p class="prov">${total.toLocaleString()} words · exported from NEO on ${stamp}</p>` : ''}
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
