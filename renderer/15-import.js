"use strict";

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
    meta.language = NeoLanguage.defaultManuscriptLanguage(library);
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
