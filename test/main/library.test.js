'use strict';
// The library on disk: where it lives, moving it, restoring it, searching it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadMain } = require('../helpers/main-process');

const neo = loadMain();

test('an unconfigured library lives in Documents', () => {
  assert.equal(neo.internals.resolveLibraryAtStartup(), null);
  assert.equal(neo.libraryDir, path.join(neo.home, 'Documents', process.platform === 'linux' ? 'NEO-Library' : 'NEO Library'));
  neo.internals.ensureLibrary();
  assert.ok(fs.existsSync(path.join(neo.libraryDir, 'library.json')));
});

test('a library inside another Git repository gets its own repository', async () => {
  neo.git(['init', '-q'], neo.home); // a dotfiles-style repo around everything
  neo.git(['remote', 'add', 'origin', 'https://example.com/dotfiles.git'], neo.home);
  const status = await neo.call('git:status');
  assert.equal(status.initialized, false);
  await neo.call('git:connectRemote', neo.url);
  assert.equal(neo.git(['remote', 'get-url', 'origin'], neo.home), 'https://example.com/dotfiles.git', 'parent repo untouched');
  assert.equal(fs.realpathSync(neo.git(['rev-parse', '--show-toplevel'])), fs.realpathSync(neo.libraryDir));
  fs.rmSync(path.join(neo.home, '.git'), { recursive: true, force: true });
});

test('search finds a phrase across every book', async () => {
  neo.write('book-a/book.json', { title: 'Book One', chapterOrder: ['c1', 'c2'], chapterTitles: { c2: 'The Well' } });
  neo.write('book-a/chapters/c1.html', '<p>Her eyes were <i>green</i> as glass.</p>');
  neo.write('book-a/chapters/c2.html', '<p>Green water, and GREEN again.</p>');
  neo.write('book-b/book.json', { title: 'Book Two', chapterOrder: ['x'] });
  neo.write('book-b/chapters/x.html', '<p>Nothing here.</p>');
  const results = await neo.call('library:search', 'green');
  assert.equal(results.length, 1);
  assert.equal(results[0].count, 3);
  assert.deepEqual(results[0].hits.map((h) => [h.chapterId, h.ordinal]), [['c1', 0], ['c2', 0], ['c2', 1]]);
  assert.equal(results[0].hits[1].chapterTitle, 'The Well');
});

test('restore from GitHub swaps the backup in and keeps what was here', async () => {
  neo.write('library.json', { emailAddress: 'me@example.com', shelves: [{ id: 's', name: 'WIP', bookIds: ['book-a'] }], history: { git: { enabled: true } } });
  await neo.call('git:push');
  // this "new computer" has one book of its own
  const L = neo.libraryDir;
  fs.renameSync(L, L + '-computer1');
  neo.internals.ensureLibrary();
  neo.write('library.json', { emailAddress: 'laptop@example.com', shelves: [] });
  neo.write('book-local/book.json', { title: 'Local' });
  const result = await neo.call('git:restore', neo.url);
  assert.ok(result.keptAs && fs.existsSync(path.join(result.keptAs, 'book-local', 'book.json')), 'the old library is set aside');
  assert.ok(fs.existsSync(path.join(L, 'book-a', 'book.json')));
  const lib = JSON.parse(fs.readFileSync(path.join(L, 'library.json'), 'utf8'));
  assert.equal(lib.emailAddress, 'laptop@example.com', 'this computer keeps its own private settings');
  assert.equal(lib.history.git.remoteUrl, neo.url);
});

test('moving the library copies it and leaves the original', async () => {
  fs.mkdirSync(path.join(neo.home, 'Dropbox'));
  neo.dialogAnswers.push({ canceled: false, filePaths: [path.join(neo.home, 'Dropbox')] });
  const before = neo.libraryDir;
  await neo.internals.changeLibraryLocation();
  assert.equal(neo.libraryDir, path.join(neo.home, 'Dropbox'));
  assert.ok(fs.existsSync(path.join(neo.libraryDir, 'book-a', 'book.json')));
  assert.ok(fs.existsSync(path.join(before, 'book-a', 'book.json')), 'original untouched');
  assert.ok(fs.readdirSync(path.join(before, 'Backups')).some((f) => f.startsWith('neo-safety-')));
  const settings = JSON.parse(fs.readFileSync(path.join(neo.home, 'userData', 'settings.json'), 'utf8'));
  assert.equal(settings.libraryDir, neo.libraryDir);
});

test('a missing library folder falls back to Documents instead of starting empty', () => {
  fs.renameSync(path.join(neo.home, 'Dropbox'), path.join(neo.home, 'Dropbox-offline'));
  const missing = neo.internals.resolveLibraryAtStartup();
  assert.equal(missing, path.join(neo.home, 'Dropbox'));
  assert.equal(neo.libraryDir, path.join(neo.home, 'Documents', process.platform === 'linux' ? 'NEO-Library' : 'NEO Library'));
});
