'use strict';
// Version checkpoints and manuscript import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadMain } = require('../helpers/main-process');

const neo = loadMain();
neo.internals.resolveLibraryAtStartup();
neo.internals.ensureLibrary();

test('a checkpoint can be read back for comparing', async () => {
  neo.write('book-x/book.json', { chapterOrder: ['c1'] });
  neo.write('book-x/chapters/c1.html', '<p>hi</p>');
  const cp = await neo.call('history:checkpoint', 'book-x', 'writing');
  const saved = await neo.call('history:read', 'book-x', cp.id);
  assert.deepEqual(saved.chapters, { c1: '<p>hi</p>' });
  assert.deepEqual(saved.meta.chapterOrder, ['c1']);
});

test('a damaged checkpoint is refused rather than trusted', async () => {
  const [cp] = await neo.call('history:list', 'book-x');
  fs.writeFileSync(path.join(neo.libraryDir, 'book-x', '.neo-history', cp.id, 'chapters', 'c1.html'), 'tampered');
  await assert.rejects(neo.call('history:read', 'book-x', cp.id), /Checksum mismatch/);
  await assert.rejects(neo.call('history:read', 'book-x', '../../etc'), /Invalid checkpoint id/);
});

test('Chinese manuscripts import with their chapters and titles', async () => {
  const file = path.join(neo.home, '长夜.md');
  fs.writeFileSync(file, '长夜\n\n第一章 风起\n\n夜很深了。她推开门。\n\n第二章\n\n天亮了。\n\n尾声\n\n完。');
  const [book] = await neo.call('import:files', [file]);
  assert.equal(book.title, '长夜');
  assert.deepEqual(book.chapters.map((c) => c.title), ['风起', '', '']);
  assert.equal(book.chapters.length, 3);
});

test('English chapter headings still import as before', async () => {
  const file = path.join(neo.home, 'story.md');
  fs.writeFileSync(file, 'Chapter 1\n\nIt began.\n\n# The Well\n\nWater.\n\n***\n\nLater.');
  const [book] = await neo.call('import:files', [file]);
  assert.deepEqual(book.chapters.map((c) => c.title), ['', 'The Well']);
  assert.ok(book.chapters[1].paras.some((p) => p.scene));
});

test('international chapter headings and bylines import as book structure', async () => {
  const file = path.join(neo.home, 'roman.md');
  fs.writeFileSync(file, 'La Porte\n\npar Marie Dupont\n\nChapitre 1\n\nLe début.\n\nChapitre 2 — La nuit\n\nLa suite.');
  const [book] = await neo.call('import:files', [file]);
  assert.equal(book.title, 'La Porte');
  assert.equal(book.author, 'Marie Dupont');
  assert.equal(book.chapters.length, 2);
});

test('DOCX Heading 1 with a space starts a chapter', async () => {
  const JSZip = require('jszip'), zip = new JSZip();
  zip.file('word/document.xml', `<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading 1"/></w:pPr><w:r><w:t>Opening</w:t></w:r></w:p>
    <w:p><w:r><w:t>First page.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading 1"/></w:pPr><w:r><w:t>Ending</w:t></w:r></w:p>
    <w:p><w:r><w:t>Last page.</w:t></w:r></w:p>
  </w:body></w:document>`);
  const file = path.join(neo.home, 'spaced-heading.docx');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const [book] = await neo.call('import:files', [file]);
  assert.deepEqual(book.chapters.map(chapter => chapter.title), ['Opening', 'Ending']);
});

test('Google Docs Title-styled tabs become a book title and chapter boundaries', async () => {
  const JSZip = require('jszip');
  const zip = new JSZip();
  const para = (text, style='') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  zip.file('word/document.xml', `<w:document><w:body>${para('The Journey','Title')}${para('Opening','Heading1')}${para('The first page begins here.')}${para('Second tab','Title')}${para('The Long Way Home','Heading1')}${para('The next page begins here.')}</w:body></w:document>`);
  const file = path.join(neo.home,'google-tabs.docx');
  fs.writeFileSync(file,await zip.generateAsync({type:'nodebuffer'}));
  const [book] = await neo.call('import:files',[file]);
  assert.equal(book.title,'The Journey');
  assert.deepEqual(book.chapters.map(c=>c.title),['Opening','Second tab — The Long Way Home']);
  assert.equal(book.chapters.length,2);
});

test('DOCX import preserves inherited italics and explicit formatting overrides', async () => {
  const JSZip = require('jszip'), zip = new JSZip();
  zip.file('word/styles.xml', `<w:styles>
    <w:style w:styleId="Emphasis"><w:rPr><w:i/></w:rPr></w:style>
    <w:style w:styleId="Inherited"><w:basedOn w:val="Emphasis"/></w:style>
    <w:style w:styleId="ParaItalic"><w:rPr><w:i/></w:rPr></w:style>
  </w:styles>`);
  zip.file('word/document.xml', `<w:document><w:body>
    <w:p><w:r><w:rPr><w:rStyle w:val="Inherited"/></w:rPr><w:t>Styled italic</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="ParaItalic"/></w:pPr><w:r><w:t>Paragraph italic</w:t></w:r><w:r><w:rPr><w:i w:val="0"/></w:rPr><w:t> plain</w:t></w:r></w:p>
  </w:body></w:document>`);
  const file = path.join(neo.home, 'styled.docx');
  fs.writeFileSync(file, await zip.generateAsync({type:'nodebuffer'}));
  const [book] = await neo.call('import:files',[file]);
  const text = JSON.stringify(book.chapters);
  assert.match(text,/\*Styled italic\*/);
  assert.match(text,/\*Paragraph italic\*/);
  assert.doesNotMatch(text,/\* plain\*/);
});

test('reshelving can discover books without shelf membership', async () => {
  neo.write('book-unshelved/book.json',{id:'book-unshelved',title:'Forgotten',author:'Writer'});
  const books=await neo.call('library:listBooks');
  assert.ok(books.some(b=>b.id==='book-unshelved'&&b.title==='Forgotten'));
});
