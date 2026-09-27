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
