'use strict';
// GitHub backup: connect, push, automatic commits, and the ways it can fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadMain, wait } = require('../helpers/main-process');

const neo = loadMain();
neo.internals.resolveLibraryAtStartup();
neo.internals.ensureLibrary();

test('connect commits the library and pushes it to "GitHub"', async () => {
  neo.write('library.json', { emailAddress: 'me@example.com', emailMethod: 'gmail', shelves: [], history: { enabled: true, git: { enabled: false } } });
  neo.write('book-a/book.json', { id: 'book-a', title: 'A', chapterOrder: ['c1'] });
  neo.write('book-a/chapters/c1.html', '<p>Once.</p>');
  await neo.call('git:connectRemote', neo.url);
  await neo.call('git:push');
  const pushed = neo.remoteGit(['ls-tree', '-r', '--name-only', 'main']).split('\n');
  assert.ok(pushed.includes('book-a/chapters/c1.html'));
  const status = await neo.call('git:status');
  assert.equal(status.initialized, true);
  assert.ok(status.lastPushAt, 'records when it last backed up');
});

test('private settings never reach GitHub', () => {
  const pushed = neo.remoteGit(['ls-tree', '-r', '--name-only', 'main']).split('\n');
  assert.ok(!pushed.includes('library.json'), 'library.json stays local');
  assert.ok(pushed.includes('library.backup.json'));
  const backup = neo.remoteGit(['show', 'main:library.backup.json']);
  assert.ok(!backup.includes('me@example.com'));
  assert.ok(!backup.includes('gmail'));
});

test('a version commits in the background without holding up saves', async () => {
  const lib = JSON.parse(fs.readFileSync(path.join(neo.libraryDir, 'library.json'), 'utf8'));
  lib.history.git = { enabled: true, autoPush: true, remoteUrl: neo.url };
  fs.writeFileSync(path.join(neo.libraryDir, 'library.json'), JSON.stringify(lib));
  neo.write('book-a/chapters/c1.html', '<p>Once upon a time.</p>');
  const checkpoint = await neo.call('history:checkpoint', 'book-a', 'writing');
  assert.ok(checkpoint && checkpoint.id, 'checkpoint returns without waiting for git');
  await wait(1500);
  assert.match(neo.git(['log', '-1', '--format=%s']), /NEO checkpoint: writing/);
});

test('a repository with someone else\'s commits is refused with a plain message', async () => {
  const other = path.join(neo.home, 'other');
  neo.git(['clone', '-q', neo.remote, other], neo.home);
  fs.writeFileSync(path.join(other, 'notes.txt'), 'from another computer');
  neo.git(['add', '-A'], other);
  neo.git(['-c', 'user.name=x', '-c', 'user.email=x@y', 'commit', '-q', '-m', 'elsewhere'], other);
  neo.git(['push', '-q'], other);
  neo.write('book-a/chapters/c1.html', '<p>Changed here too.</p>');
  await assert.rejects(neo.call('git:push'), /GitHub has commits this library doesn’t/);
  await assert.rejects(neo.call('git:replaceStarter'), /more than starter files/, 'real content is never overwritten');
});

test('a sign-in failure fails fast instead of hanging', async () => {
  neo.git(['remote', 'set-url', 'origin', 'https://github.com/neo-test-nonexistent-owner/nope.git']);
  const started = Date.now();
  await assert.rejects(neo.call('git:push'));
  assert.ok(Date.now() - started < 60000);
});
