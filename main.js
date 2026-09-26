// NEO — main process
// Owns the window and all file-system access. The renderer talks to this
// through the IPC handlers below (see preload.js for the exposed API).

const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const flushAcknowledgements = new Map();

// macOS Chromium's "smart delete" also removes whitespace around a deleted
// selection, and that pass can duplicate characters. Deletes stay literal.
app.commandLine.appendSwitch('blink-settings', 'smartInsertDeleteEnabled=false');

// ---------------------------------------------------------------------------
// Library location: a folder of plain files the user can inspect, sync, back up.
// ---------------------------------------------------------------------------
// Resolved properly at startup via app.getPath('documents') — this default
// covers any early access and non-redirected setups.
let LIBRARY_DIR = path.join(os.homedir(), 'Documents', 'NEO Library');
let LIBRARY_FILE = path.join(LIBRARY_DIR, 'library.json');

function ensureLibrary() {
  if (!fs.existsSync(LIBRARY_DIR)) fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  if (!fs.existsSync(LIBRARY_FILE)) {
    const seed = {
      authorName: '',
      penNames: [],
      firstRunDone: false,
      pageTheme: 'night',
      shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
    };
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(seed, null, 2));
  }
}

function bookDir(bookId) {
  return path.join(LIBRARY_DIR, bookId);
}

// A human-readable map of the library, regenerated on every change:
// which folder is which book, and what shelf it lives on. Sorts to the
// top of the folder so browsing writers can always find their way.
function writeCatalog() {
  try {
    const lib = readJSON(LIBRARY_FILE, { shelves: [] });
    const onShelf = {};
    for (const s of lib.shelves || []) {
      for (const id of s.bookIds) onShelf[id] = s.name;
    }
    const lines = [];
    for (const d of fs.readdirSync(LIBRARY_DIR)) {
      if (!d.startsWith('book-')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, d, 'book.json'), 'utf8'));
        lines.push(`${m.title || 'Untitled'}  —  ${d}  —  shelf: ${onShelf[m.id] || '(none — removed from shelves)'}`);
      } catch { /* not a valid book folder */ }
    }
    lines.sort((a, b) => a.localeCompare(b));
    fs.writeFileSync(path.join(LIBRARY_DIR, '_catalog.txt'),
      'NEO LIBRARY CATALOG — which folder is which book\n' +
      '(regenerated automatically; edits here do nothing)\n\n' +
      lines.join('\n') + '\n');
  } catch (err) {
    logError('catalog', err);
  }
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWrite(file, data) {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

async function atomicWriteAsync(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(tmp, 'w');
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  try {
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

function writeJSON(file, data) {
  atomicWrite(file, JSON.stringify(data, null, 2));
}

// Calls from a renderer are asynchronous. Serializing every write for a book
// prevents an older debounce from landing after a newer edit, and gives a
// checkpoint a coherent point in the book's on-disk history.
const bookWriteQueues = new Map();
function queueBookWrite(bookId, work) {
  const previous = bookWriteQueues.get(bookId) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  bookWriteQueues.set(bookId, next);
  next.catch((err) => logError('book-save', err));
  return next;
}

async function drainBookWrites() {
  await Promise.allSettled([...bookWriteQueues.values()]);
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: LIBRARY_DIR, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function libraryGitStatus() {
  try {
    await runGit(['--version']);
  } catch {
    return { available: false, initialized: false };
  }
  try {
    const inside = await runGit(['rev-parse', '--is-inside-work-tree']);
    if (inside.stdout !== 'true') return { available: true, initialized: false };
    const [branch, remote, status] = await Promise.all([
      runGit(['branch', '--show-current']),
      runGit(['remote', 'get-url', 'origin']).catch(() => ({ stdout: '' })),
      runGit(['status', '--porcelain'])
    ]);
    return { available: true, initialized: true, branch: branch.stdout || 'main', remote: remote.stdout || null, clean: !status.stdout };
  } catch {
    return { available: true, initialized: false };
  }
}

async function initializeLibraryGit(authorName = 'NEO Writer', authorEmail = 'writer@neo.local') {
  const status = await libraryGitStatus();
  if (!status.available) throw new Error('Git is not installed');
  if (!status.initialized) await runGit(['init', '-b', 'main']);
  const ignore = [
    '# NEO keeps these locally; Git commits are the portable history.',
    '.neo-history/',
    'Backups/',
    'Exports/',
    'neo-errors.log',
    '.DS_Store',
    ''
  ].join('\n');
  atomicWrite(path.join(LIBRARY_DIR, '.gitignore'), ignore);
  if (authorName) await runGit(['config', 'user.name', authorName]);
  if (authorEmail) await runGit(['config', 'user.email', authorEmail]);
  await runGit(['add', '--all']);
  try {
    await runGit(['diff', '--cached', '--quiet']);
  } catch (err) {
    if (err.code !== 1) throw err;
    await runGit(['commit', '-m', 'NEO library baseline']);
  }
  return libraryGitStatus();
}

async function ensureLibraryGitMainBranch() {
  const status = await libraryGitStatus();
  if (!status.initialized || status.branch === 'main') return status;
  await runGit(['branch', '-M', 'main']);
  return libraryGitStatus();
}

async function connectLibraryGitRemote(remoteUrl) {
  if (!/^(https:\/\/github\.com\/|git@github\.com:)[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(String(remoteUrl || ''))) {
    throw new Error('Enter a GitHub repository URL');
  }
  const status = await libraryGitStatus();
  if (!status.initialized) await initializeLibraryGit();
  await ensureLibraryGitMainBranch();
  if (status.remote) await runGit(['remote', 'set-url', 'origin', remoteUrl]);
  else await runGit(['remote', 'add', 'origin', remoteUrl]);
  return libraryGitStatus();
}

async function pushLibraryGit() {
  const status = await ensureLibraryGitMainBranch();
  if (!status.remote) throw new Error('Connect a GitHub repository first');
  await runGit(['push', '--set-upstream', 'origin', 'HEAD']);
  return libraryGitStatus();
}

let libraryGitQueue = Promise.resolve();
function queueGitCommit(reason) {
  const work = async () => {
    const prefs = readJSON(LIBRARY_FILE, {}).history?.git || {};
    if (!prefs.enabled) return null;
    const status = await ensureLibraryGitMainBranch();
    if (!status.initialized) return null;
    await runGit(['add', '--all']);
    try {
      await runGit(['diff', '--cached', '--quiet']);
      return null;
    } catch (err) {
      if (err.code !== 1) throw err;
    }
    await runGit(['commit', '-m', `NEO checkpoint: ${reason}`]);
    // Older NEO settings only had `git.enabled`; treat those as automatic
    // backups too so an existing connection does not silently stop at local
    // commits after the auto-push option was introduced.
    if (prefs.autoPush !== false && status.remote) {
      try {
        await runGit(['push', '--set-upstream', 'origin', 'HEAD']);
      } catch (err) {
        logError('git-auto-push', err);
        sendToWindow({ type: 'gitAutoPushError', message: err.stderr || err.message || 'GitHub push failed' });
      }
    }
    return true;
  };
  libraryGitQueue = libraryGitQueue.catch(() => {}).then(work);
  libraryGitQueue.catch((err) => logError('git-history', err));
  return libraryGitQueue;
}

const HISTORY_DIR = '.neo-history';
function historyDir(bookId) {
  return path.join(bookDir(bookId), HISTORY_DIR);
}

async function copyCheckpointTree(source, destination, relative = '', files = []) {
  for (const name of await fs.promises.readdir(source)) {
    if (name === HISTORY_DIR || name.endsWith('.tmp')) continue;
    const from = path.join(source, name);
    const rel = relative ? path.join(relative, name) : name;
    const to = path.join(destination, rel);
    const stat = await fs.promises.stat(from);
    if (stat.isDirectory()) {
      await fs.promises.mkdir(to, { recursive: true });
      await copyCheckpointTree(from, destination, rel, files);
      continue;
    }
    const content = await fs.promises.readFile(from);
    await atomicWriteAsync(to, content);
    files.push({ path: rel.replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  return files;
}

async function pruneCheckpoints(dir) {
  const now = Date.now();
  const seenHours = new Set();
  const seenDays = new Set();
  const retentionDays = Math.max(1, Number(readJSON(LIBRARY_FILE, {}).history?.retentionDays) || 90);
  const snapshots = (await fs.promises.readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      const manifest = readJSON(path.join(full, 'manifest.json'), null);
      return { full, created: Date.parse(manifest && manifest.createdAt) || fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.created - a.created);
  for (const snapshot of snapshots) {
    const age = now - snapshot.created;
    const stamp = new Date(snapshot.created);
    const hour = stamp.toISOString().slice(0, 13);
    const day = stamp.toISOString().slice(0, 10);
    const keep = age <= 24 * 60 * 60 * 1000 ||
      (age <= 30 * 24 * 60 * 60 * 1000 && !seenHours.has(hour)) ||
      (age <= retentionDays * 24 * 60 * 60 * 1000 && !seenDays.has(day));
    seenHours.add(hour);
    seenDays.add(day);
    if (!keep) await fs.promises.rm(snapshot.full, { recursive: true, force: true });
  }
}

async function createCheckpoint(bookId, reason = 'writing') {
  const source = bookDir(bookId);
  if (!fs.existsSync(source)) return null;
  const dir = historyDir(bookId);
  await fs.promises.mkdir(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const safeReason = String(reason).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'writing';
  const name = `${createdAt.replace(/[:.]/g, '-')}-${safeReason}-${Math.random().toString(36).slice(2, 7)}`;
  const pending = path.join(dir, `.${name}.pending`);
  const target = path.join(dir, name);
  await fs.promises.mkdir(pending, { recursive: true });
  try {
    const files = await copyCheckpointTree(source, pending);
    await atomicWriteAsync(path.join(pending, 'manifest.json'), JSON.stringify({ version: 1, createdAt, reason: safeReason, files }, null, 2));
    await fs.promises.rename(pending, target);
    await pruneCheckpoints(dir);
    return { id: name, createdAt };
  } catch (err) {
    await fs.promises.rm(pending, { recursive: true, force: true });
    throw err;
  }
}

function checkpointPath(bookId, checkpointId) {
  if (!/^[a-z0-9-]+$/i.test(checkpointId)) throw new Error('Invalid checkpoint id');
  return path.join(historyDir(bookId), checkpointId);
}

async function verifyCheckpoint(bookId, checkpointId) {
  const dir = checkpointPath(bookId, checkpointId);
  const manifest = readJSON(path.join(dir, 'manifest.json'), null);
  if (!manifest || !Array.isArray(manifest.files)) return { valid: false, manifest: null };
  try {
    for (const file of manifest.files) {
      const rel = String(file.path || '');
      if (!rel || rel.includes('..') || path.isAbsolute(rel)) throw new Error('Unsafe checkpoint path');
      const content = await fs.promises.readFile(path.join(dir, rel));
      if (crypto.createHash('sha256').update(content).digest('hex') !== file.sha256) throw new Error(`Checksum mismatch: ${rel}`);
    }
    return { valid: true, manifest };
  } catch (err) {
    return { valid: false, manifest, error: String(err.message || err) };
  }
}

async function listCheckpoints(bookId) {
  const dir = historyDir(bookId);
  if (!fs.existsSync(dir)) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const list = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const checked = await verifyCheckpoint(bookId, entry.name);
    list.push({ id: entry.name, valid: checked.valid, error: checked.error || null, ...(checked.manifest || {}) });
  }
  return list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function restoreCheckpoint(bookId, checkpointId) {
  const checked = await verifyCheckpoint(bookId, checkpointId);
  if (!checked.valid) throw new Error(`Checkpoint cannot be restored: ${checked.error || 'invalid manifest'}`);
  await createCheckpoint(bookId, 'before-restore');
  const target = bookDir(bookId);
  for (const name of await fs.promises.readdir(target)) {
    if (name !== HISTORY_DIR) await fs.promises.rm(path.join(target, name), { recursive: true, force: true });
  }
  for (const file of checked.manifest.files) {
    const destination = path.join(target, file.path);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await atomicWriteAsync(destination, await fs.promises.readFile(path.join(checkpointPath(bookId, checkpointId), file.path)));
  }
  writeCatalog();
  return { restored: checkpointId };
}

// ---------------------------------------------------------------------------
// IPC — the renderer's whole view of the disk
// ---------------------------------------------------------------------------

ipcMain.handle('library:read', () => {
  ensureLibrary();
  return readJSON(LIBRARY_FILE, null);
});

ipcMain.handle('library:write', (_e, data) => {
  ensureLibrary();
  writeJSON(LIBRARY_FILE, data);
  writeCatalog();
  return true;
});

// A book is a folder: book.json + chapters/*.html + notes.html + outline.html + darlings.json
ipcMain.handle('book:create', (_e, meta) => {
  ensureLibrary();
  // folders carry a slug of the title when it's known at creation (imports),
  // so the library reads like a bookshelf in Finder too
  const slug = String(meta.title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  const id = 'book-' + (slug ? slug + '-' : '') +
    Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const dir = bookDir(id);
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  const book = {
    id,
    title: meta.title || 'Untitled',
    subtitle: '',
    series: '',
    author: meta.author || 'Anonymous',
    wordGoal: 0,
    goalDueDate: '',
    goalChartMode: 'daily',
    wordHistory: [],
    dailyCounts: {},
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    chapterOrder: [],
    tabNames: { notes: 'Notes', outline: 'Outline' }
  };
  writeJSON(path.join(dir, 'book.json'), book);
  atomicWrite(path.join(dir, 'notes.html'), '');
  atomicWrite(path.join(dir, 'outline.html'), '');
  writeJSON(path.join(dir, 'darlings.json'), []);
  writeJSON(path.join(dir, 'stickies.json'), []);
  return book;
});

ipcMain.handle('book:readMeta', (_e, bookId) => {
  return readJSON(path.join(bookDir(bookId), 'book.json'), null);
});

ipcMain.handle('book:writeMeta', async (_e, bookId, meta) => {
  return queueBookWrite(bookId, () => {
    meta.modified = new Date().toISOString();
    writeJSON(path.join(bookDir(bookId), 'book.json'), meta);
    writeCatalog();
    return true;
  });
});

ipcMain.handle('chapter:read', (_e, bookId, chapterId) => {
  const file = path.join(bookDir(bookId), 'chapters', chapterId + '.html');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('chapter:write', async (_e, bookId, chapterId, html) => {
  return queueBookWrite(bookId, () => {
    const dir = path.join(bookDir(bookId), 'chapters');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, chapterId + '.html'), html);
    return true;
  });
});

ipcMain.handle('chapter:delete', async (_e, bookId, chapterId) => {
  return queueBookWrite(bookId, () => {
    const file = path.join(bookDir(bookId), 'chapters', chapterId + '.html');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  });
});

ipcMain.handle('aux:read', (_e, bookId, name) => {
  // name: 'notes' | 'outline'
  const file = path.join(bookDir(bookId), name + '.html');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('aux:write', async (_e, bookId, name, html) => {
  return queueBookWrite(bookId, () => {
    atomicWrite(path.join(bookDir(bookId), name + '.html'), html);
    return true;
  });
});

ipcMain.handle('json:read', (_e, bookId, name, fallback) => {
  return readJSON(path.join(bookDir(bookId), name + '.json'), fallback);
});

ipcMain.handle('json:write', async (_e, bookId, name, data) => {
  return queueBookWrite(bookId, () => {
    writeJSON(path.join(bookDir(bookId), name + '.json'), data);
    return true;
  });
});

ipcMain.handle('history:checkpoint', async (_e, bookId, reason) => {
  return queueBookWrite(bookId, async () => {
    const checkpoint = await createCheckpoint(bookId, reason);
    await queueGitCommit(reason);
    return checkpoint;
  });
});

ipcMain.handle('history:list', async (_e, bookId) => {
  return listCheckpoints(bookId);
});

ipcMain.handle('history:restore', async (_e, bookId, checkpointId) => {
  return queueBookWrite(bookId, async () => {
    const restored = await restoreCheckpoint(bookId, checkpointId);
    await queueGitCommit('restore');
    return restored;
  });
});

ipcMain.handle('git:status', () => libraryGitStatus());
ipcMain.handle('git:initialize', async (_e, authorName, authorEmail) => {
  await initializeLibraryGit(authorName, authorEmail);
  return ensureLibraryGitMainBranch();
});
ipcMain.handle('git:connectRemote', (_e, remoteUrl) => connectLibraryGitRemote(remoteUrl));
ipcMain.handle('git:push', () => pushLibraryGit());

ipcMain.handle('book:delete', async (_e, bookId, title) => {
  const win = BrowserWindow.getFocusedWindow();
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', process.platform === 'win32' ? 'Move to Recycle Bin' : 'Move to Trash'],
    defaultId: 0,
    cancelId: 0,
    message: `Move “${title}” to the ${process.platform === 'win32' ? 'Recycle Bin' : 'Trash'}?`,
    detail: 'The book folder goes to your system trash, so you can recover it.'
  });
  if (response === 1) {
    const { shell } = require('electron');
    try {
      return queueBookWrite(bookId, async () => {
        await shell.trashItem(bookDir(bookId));
        return true;
      });
    } catch (err) {
      // Some filesystems have no Trash (network mounts, odd drives).
      // Words are never lost: leave the book alone and show the writer where it lives.
      logError('trash', err);
      shell.showItemInFolder(bookDir(bookId));
      dialog.showMessageBox(win, {
        message: 'NEO couldn’t move that folder to the Trash.',
        detail: 'The book is untouched. Its folder is highlighted so you can deal with it yourself.'
      });
      return false;
    }
  }
  return false;
});

// ---------------------------------------------------------------------------
// Cover art: images live inside the book's folder, so covers travel with
// the library. Timestamped filenames sidestep every caching gremlin.
// ---------------------------------------------------------------------------

const COVER_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

ipcMain.handle('library:path', () => LIBRARY_DIR);

ipcMain.handle('cover:pick', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose cover art',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: COVER_EXTS }]
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

function clearCovers(dir) {
  for (const f of fs.readdirSync(dir)) {
    if (/^cover-\d+\./.test(f)) fs.unlinkSync(path.join(dir, f));
  }
}

ipcMain.handle('cover:set', (_e, bookId, srcPath) => {
  const ext = path.extname(srcPath).toLowerCase().replace('.', '');
  if (!COVER_EXTS.includes(ext)) return null;
  const dir = bookDir(bookId);
  if (!fs.existsSync(dir)) return null;
  clearCovers(dir);
  const fname = 'cover-' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext);
  fs.copyFileSync(srcPath, path.join(dir, fname));
  return fname;
});

ipcMain.handle('cover:remove', (_e, bookId) => {
  const dir = bookDir(bookId);
  if (fs.existsSync(dir)) clearCovers(dir);
  return true;
});

ipcMain.handle('cover:read', (_e, bookId, fname) => {
  try {
    if (!/^(cover|art)-\d+\.(png|jpg|webp)$/.test(fname)) return null;
    const buf = fs.readFileSync(path.join(bookDir(bookId), fname));
    const ext = path.extname(fname).slice(1);
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { base64: buf.toString('base64'), mime, ext };
  } catch {
    return null;
  }
});

// ---------------------------------------------------------------------------
// Painted covers: once a story passes a thousand words, NEO reads it and
// paints an abstract cover (art.js). The API key lives encrypted in the
// app's own data folder — never in the library, which gets synced and
// backed up as plain files.
// ---------------------------------------------------------------------------

const SECRETS_FILE = () => path.join(app.getPath('userData'), 'secrets.json');

function readSecret(name) {
  try {
    const { safeStorage } = require('electron');
    const all = readJSON(SECRETS_FILE(), {});
    if (!all[name]) return null;
    if (all[name].enc && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(all[name].value, 'base64'));
    }
    return all[name].value;
  } catch (err) {
    logError('secret', err);
    return null;
  }
}

ipcMain.handle('secret:set', (_e, name, value) => {
  const { safeStorage } = require('electron');
  const all = readJSON(SECRETS_FILE(), {});
  if (!value) {
    delete all[name];
  } else if (safeStorage.isEncryptionAvailable()) {
    all[name] = { enc: true, value: safeStorage.encryptString(String(value)).toString('base64') };
  } else {
    all[name] = { enc: false, value: String(value) };
  }
  writeJSON(SECRETS_FILE(), all);
  return true;
});

ipcMain.handle('secret:has', (_e, name) => !!readSecret(name));

// One painting at a time per book; a second request while one is running
// simply gets the running one's answer.
const paintJobs = new Map();

ipcMain.handle('cover:paint', (_e, bookId, text, options) => {
  if (paintJobs.has(bookId)) return paintJobs.get(bookId);
  const job = (async () => {
    const provider = (options && options.provider) || 'openai';
    const apiKey = readSecret(provider);
    if (!apiKey) return { error: 'No API key for ' + provider + ' — add one under File → Cover Art…' };
    const dir = bookDir(bookId);
    if (!fs.existsSync(dir)) return { error: 'Book folder is missing' };
    try {
      const art = require('./art.js');
      const out = await art.paintCover({
        provider,
        apiKey,
        text: String(text || ''),
        textModel: options && options.textModel,
        imageModel: options && options.imageModel,
        quality: options && options.quality
      });
      // sweep older paintings; the writer's own cover-*.png files are untouched
      for (const f of fs.readdirSync(dir)) {
        if (/^art-\d+\.(png|jpg|webp)$/.test(f)) fs.unlinkSync(path.join(dir, f));
      }
      const fname = 'art-' + Date.now() + '.' + (out.ext || 'jpg');
      fs.writeFileSync(path.join(dir, fname), out.buffer);
      // the brief sits beside the picture, so a future repaint can start from it
      writeJSON(path.join(dir, 'art.json'), {
        file: fname,
        brief: out.brief,
        provider,
        textModel: out.textModel,
        imageModel: out.imageModel,
        painted: new Date().toISOString()
      });
      return { file: fname, brief: out.brief };
    } catch (err) {
      logError('paint', err);
      return { error: String((err && err.message) || err) };
    }
  })();
  paintJobs.set(bookId, job);
  job.finally(() => paintJobs.delete(bookId));
  return job;
});

// ---------------------------------------------------------------------------
// Fullscreen
// ---------------------------------------------------------------------------

// ⌘Enter / Ctrl+Enter toggles fullscreen
ipcMain.handle('fullscreen:toggle', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setFullScreen(!win.isFullScreen());
  return true;
});

// Regular fullscreen: Esc walks you out like any civilized app
ipcMain.handle('fullscreen:escape', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && win.isFullScreen()) {
    win.setFullScreen(false);
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Export + email
// ---------------------------------------------------------------------------

async function renderPDF(html) {
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  // Letter is a North American habit; most of the world prints A4.
  const letterCountries = ['US', 'CA', 'MX', 'PH'];
  try {
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await pdfWin.webContents.printToPDF({
      pageSize: letterCountries.includes(app.getLocaleCountryCode()) ? 'Letter' : 'A4',
      margins: { top: 1, bottom: 1, left: 1, right: 1 },
      printBackground: false
    });
  } finally {
    pdfWin.destroy();
  }
}

// zipEntries: [{path, content, base64?, store?}] — order matters (EPUB mimetype first)
async function buildZip(zipEntries) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  for (const e of zipEntries) {
    zip.file(e.path, e.base64 ? Buffer.from(e.content, 'base64') : e.content, {
      compression: e.store ? 'STORE' : 'DEFLATE'
    });
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/epub+zip'
  });
}

ipcMain.handle('export:save', async (_e, { format, defaultName, content, zipEntries }) => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(os.homedir(), 'Documents', defaultName + '.' + format),
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  });
  if (canceled || !filePath) return null;
  if (zipEntries) {
    fs.writeFileSync(filePath, await buildZip(zipEntries));
  } else if (format === 'pdf') {
    fs.writeFileSync(filePath, await renderPDF(content));
  } else {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return filePath;
});

// Writes a timestamped snapshot to the library's Exports folder, then hands it
// to your email — an outside-the-machine paper trail for provenance.
ipcMain.handle('email:draft', async (_e, { to, subject, body, html, defaultName, method }) => {
  const { shell } = require('electron');
  const exportsDir = path.join(LIBRARY_DIR, 'Exports');
  if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(exportsDir, `${defaultName}-${stamp}.pdf`);
  fs.writeFileSync(file, await renderPDF(html));

  if (method === 'gmail') {
    // Gmail compose in the browser can't take an attachment from outside,
    // so open the draft pre-filled and reveal the PDF right next to it to drag in.
    const url = 'https://mail.google.com/mail/?view=cm&fs=1'
      + '&to=' + encodeURIComponent(to)
      + '&su=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(body);
    await shell.openExternal(url);
    shell.showItemInFolder(file);
    return { ok: true, method: 'gmail', file };
  }

  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
    tell application "Mail"
      set msg to make new outgoing message with properties {subject:"${esc(subject)}", content:"${esc(body)}" & return & return, visible:true}
      tell msg to make new to recipient at end of to recipients with properties {address:"${esc(to)}"}
      tell msg to make new attachment with properties {file name:(POSIX file "${esc(file)}")} at after the last paragraph of content
      activate
    end tell`;
  return new Promise((resolve) => {
    require('child_process').execFile('osascript', ['-e', script], (err) => {
      if (err) {
        // Mail not available — at least reveal the snapshot we saved
        shell.showItemInFolder(file);
        resolve({ ok: false, file });
      } else {
        resolve({ ok: true, method: 'mail', file });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Import: .docx / .txt / .md → chapters
// ---------------------------------------------------------------------------

const decodeEntities = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

async function importFile(fp) {
  const name = path.basename(fp).replace(/\.[^.]+$/, '');
  const ext = path.extname(fp).toLowerCase();
  let paras = [];

  if (ext === '.docx') {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(fp));
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Not a valid .docx: ' + fp);
    const xml = await docFile.async('string');
    paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => {
      const p = m[0];
      // <w:t> or <w:t attr...> ONLY — never <w:tab>/<w:tabs>, which share
      // the same first letters and once leaked raw XML into a manuscript
      const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
        .map((t) => decodeEntities(t[1])).join('');
      const pageBreak = /<w:br [^>]*w:type="page"/.test(p) || /<w:pageBreakBefore/.test(p);
      return { text: text.trim(), pageBreak };
    });
  } else {
    const raw = fs.readFileSync(fp, 'utf8');
    paras = raw.split(/\r?\n\s*\r?\n/)
      .map((b) => ({ text: b.replace(/\s*\r?\n\s*/g, ' ').trim(), pageBreak: false }))
      .filter((p) => p.text);
  }

  // Chapterize: page breaks and heading lines start new chapters. Headings
  // include "Chapter N" styles plus bare chapter numbers — "7", "VII",
  // "Seven" — which get stripped so NEO's own numbering doesn't duplicate them.
  const SPELLED = /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\.?$/i;
  const isNumeralish = (t) => /^\d{1,3}\.?$/.test(t) || /^[IVXLC]{1,7}\.?$/.test(t) || SPELLED.test(t);
  // Bare numbers only count as chapter markers when there's a ladder of them —
  // a story that merely OPENS with "Seven." keeps its seven.
  const numeralMode = paras.filter((p) => p.text && isNumeralish(p.text.trim())).length >= 2;
  const isHeading = (t) => t && (
    (/^(chapter|prologue|epilogue|part)\b/i.test(t) && t.length < 60) ||
    (numeralMode && isNumeralish(t))
  );
  const isBreak = (t) => /^\s*([*#•~⁂—–-]\s*){1,7}$/.test(t || '');

  const chapterize = (usePageBreaks) => {
    const chapters = [];
    let cur = [];
    for (const p of paras) {
      const brk = usePageBreaks && p.pageBreak;
      if (!p.text && !brk) continue;
      if ((brk || isHeading(p.text)) && cur.length) {
        chapters.push(cur);
        cur = [];
      }
      if (isHeading(p.text)) continue; // the heading line itself is replaced by NEO's numbering
      if (isBreak(p.text)) { cur.push({ scene: true }); continue; }
      if (p.text) cur.push({ text: p.text });
    }
    if (cur.length) chapters.push(cur);
    return chapters;
  };

  const countAllWords = (list) =>
    list.reduce((n, ch) => n + ch.reduce((m, p) => m + (p.text ? p.text.trim().split(/\s+/).length : 0), 0), 0);

  // First pass trusts page breaks. Some word processors sprinkle page-break
  // formatting on every paragraph, exploding a story into confetti — if the
  // result is absurd (lots of tiny "chapters"), re-run trusting headings only.
  let chapters = chapterize(true);
  if (chapters.length > 6 && countAllWords(chapters) / chapters.length < 250) {
    chapters = chapterize(false);
  }
  if (!chapters.length) chapters.push([{ text: '' }]);

  // Front matter: a short title line and a "by Author" line belong on the
  // title page, not in the body. Detect, harvest, and remove them.
  let title = null;
  let author = null;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const first = chapters[0];
  if (first && first.length) {
    const t0 = (first[0].text || '').trim();
    const t1 = first.length > 1 ? (first[1].text || '').trim() : '';
    const titleish = t0 && t0.length < 90 && !/[.!?]$/.test(t0) && (
      (norm(t0).length > 3 && norm(name).includes(norm(t0))) ||
      /^by\s+\S/i.test(t1) ||
      (t0 === t0.toUpperCase() && /[A-Z].*[A-Z]/.test(t0) && t0.length < 60)
    );
    if (titleish) {
      title = t0;
      first.shift();
    }
    const bl = first.length ? (first[0].text || '').trim().match(/^by\s+(.{2,60})$/i) : null;
    if (bl) {
      author = bl[1].trim();
      first.shift();
    }
    if (!first.length) chapters.shift();
    if (!chapters.length) chapters.push([{ text: '' }]);
  }

  return { name, title, author, chapters };
}

// Same parsing as the picker, but for files dropped from Finder/Explorer
ipcMain.handle('import:files', async (_e, paths) => {
  const out = [];
  for (const fp of paths || []) {
    if (!/\.(docx|txt|md)$/i.test(fp)) continue;
    try {
      out.push(await importFile(fp));
    } catch (err) {
      logError('import', err);
      out.push({ name: path.basename(fp), error: String(err.message || err) });
    }
  }
  return out;
});

ipcMain.handle('import:pick', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Bring your manuscripts home',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Manuscripts', extensions: ['docx', 'txt', 'md'] }]
  });
  if (canceled || !filePaths.length) return [];
  const out = [];
  for (const fp of filePaths) {
    try {
      out.push(await importFile(fp));
    } catch (err) {
      logError('import', err);
      out.push({ name: path.basename(fp), error: String(err.message || err) });
    }
  }
  return out;
});

// ---------------------------------------------------------------------------
// Robustness: error log, daily backups, single instance
// ---------------------------------------------------------------------------
const ERROR_LOG = () => path.join(LIBRARY_DIR, 'neo-errors.log');

function logError(source, err) {
  try {
    ensureLibrary();
    const line = `[${new Date().toISOString()}] [${source}] ${err && err.stack ? err.stack : String(err)}\n`;
    fs.appendFileSync(ERROR_LOG(), line);
  } catch { /* never let logging crash the app */ }
}

process.on('uncaughtException', (err) => logError('main', err));
process.on('unhandledRejection', (err) => logError('main-promise', err));
ipcMain.handle('log:error', (_e, msg) => logError('renderer', msg));

// One zip of the whole library per day, keeping the last 14. Cheap insurance.
async function dailyBackup() {
  try {
    ensureLibrary();
    const backupsDir = path.join(LIBRARY_DIR, 'Backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
    const now = new Date();
    const dayEndsAt = Math.max(0, Math.min(23, Number(readJSON(LIBRARY_FILE, {}).dayEndsAt) || 0));
    now.setHours(now.getHours() - dayEndsAt);
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const target = path.join(backupsDir, `neo-backup-${today}.zip`);
    if (fs.existsSync(target)) return;

    const JSZip = require('jszip');
    const zip = new JSZip();
    const skip = new Set(['Backups', 'Exports', HISTORY_DIR]);
    const walk = (dir, rel) => {
      for (const name of fs.readdirSync(dir)) {
        if (skip.has(name)) continue;
        const full = path.join(dir, name);
        const relPath = rel ? rel + '/' + name : name;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full, relPath);
        else zip.file(relPath, fs.readFileSync(full));
      }
    };
    walk(LIBRARY_DIR, '');
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await JSZip.loadAsync(archive); // validate before replacing or pruning backups
    atomicWrite(target, archive);

    // prune old backups
    const backups = fs.readdirSync(backupsDir).filter((f) => f.startsWith('neo-backup-')).sort();
    while (backups.length > 14) fs.unlinkSync(path.join(backupsDir, backups.shift()));
  } catch (err) {
    logError('backup', err);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The engine is available, but every editable element starts with
      // spellcheck="false" — NEO never nags. A spellcheck pass is a
      // deliberate act (Edit → Spellcheck Pass), not a klaxon.
      spellcheck: true
    }
  });
  win.loadFile('index.html');

  // The renderer flushes its in-memory chapter state first; only then do we
  // let Electron close. This gives queued, atomic writes a chance to finish.
  let savingOnClose = false;
  let allowClose = false;
  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (savingOnClose) return;
    savingOnClose = true;
    const flushed = new Promise((resolve) => {
      let timeout;
      const finish = () => {
        clearTimeout(timeout);
        if (flushAcknowledgements.get(win.id) === finish) flushAcknowledgements.delete(win.id);
        resolve();
      };
      flushAcknowledgements.set(win.id, finish);
      timeout = setTimeout(finish, 1000); // renderer may already be gone; never trap a writer in the window
    });
    win.webContents.send('menu', { type: 'flush' });
    flushed.then(() => {
      drainBookWrites().catch((err) => logError('shutdown-save', err)).finally(() => {
        allowClose = true;
        win.close();
      });
    });
  });

  // NEO does its own spellchecking (see spell:* handlers) — the engine's
  // checker proved unreliable at scanning existing text, so it stays off
  win.webContents.session.setSpellCheckerEnabled(false);
}

ipcMain.on('save:flushComplete', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const resolve = win && flushAcknowledgements.get(win.id);
  if (resolve) {
    flushAcknowledgements.delete(win.id);
    resolve();
  }
});

// ---------------------------------------------------------------------------
// Spellcheck: NEO's own dictionary (Hunspell en-US via nspell), identical on
// every platform. The renderer paints the squiggles and asks for suggestions.
// ---------------------------------------------------------------------------
let neoSpell = null;

function initSpell() {
  try {
    const nspell = require('nspell');
    require('dictionary-en-us')((err, dict) => {
      if (err) { logError('spell', err); return; }
      neoSpell = nspell(dict);
      try {
        const lib = readJSON(LIBRARY_FILE, {});
        for (const w of lib.customWords || []) neoSpell.add(w);
      } catch { /* custom words are a nicety */ }
    });
  } catch (err) {
    logError('spell', err);
  }
}

ipcMain.handle('spell:check', (_e, words) => {
  const out = {};
  // dictionary still loading: report everything correct rather than crying wolf
  for (const w of words) out[w] = neoSpell ? neoSpell.correct(w) : true;
  return out;
});

ipcMain.handle('spell:suggest', (_e, word) => (neoSpell ? neoSpell.suggest(word).slice(0, 6) : []));

ipcMain.handle('spell:learn', (_e, word) => {
  if (neoSpell && typeof word === 'string') neoSpell.add(word);
  return true;
});

// ---------------------------------------------------------------------------
// Application menu — Help and Format live here, out of the writing room
// ---------------------------------------------------------------------------
function sendToWindow(msg) {
  const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (w) w.webContents.send('menu', msg);
}

// whether the caret is in a poetry paragraph — the Format menu's tick
let poetryState = false;
ipcMain.on('poetry:state', (_e, on) => {
  on = !!on;
  if (on === poetryState) return;
  poetryState = on;
  try { buildMenu(); } catch (err) { logError('menu', err); }
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const bodyFonts = isMac
    ? ['Georgia', 'Palatino', 'Baskerville', 'Hoefler Text', 'Iowan Old Style']
    : ['Georgia', 'Palatino', 'Baskerville', 'Cambria', 'Constantia'];
  const template = [
    // appMenu exists only on macOS — including it on Windows throws,
    // which is exactly what kept NEO from ever opening a window there
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Export',
          submenu: [
            { label: 'Plain Text (.txt)', click: () => sendToWindow({ type: 'export', format: 'txt' }) },
            { label: 'Markdown (.md)', click: () => sendToWindow({ type: 'export', format: 'md' }) },
            { label: 'Web Page (.html)', click: () => sendToWindow({ type: 'export', format: 'html' }) },
            { label: 'PDF (.pdf)', click: () => sendToWindow({ type: 'export', format: 'pdf' }) },
            { label: 'Word (.docx)', click: () => sendToWindow({ type: 'export', format: 'docx' }) },
            { label: 'EPUB (.epub)', click: () => sendToWindow({ type: 'export', format: 'epub' }) }
          ]
        },
        { type: 'separator' },
        {
          label: 'Email Draft to Myself',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendToWindow({ type: 'emailDraft' })
        },
        { label: 'Email Settings…', click: () => sendToWindow({ type: 'emailSettings' }) },
        { label: 'Sync Settings…', click: () => sendToWindow({ type: 'syncSettings' }) },
        { label: 'Cover Art…', click: () => sendToWindow({ type: 'coverArt' }) },
        {
          label: isMac ? 'Progress & Settings…' : 'Progress && Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendToWindow({ type: 'stats' })
        },
        { type: 'separator' },
        {
          label: 'Import Manuscripts…',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => sendToWindow({ type: 'import' })
        },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' }] : [{ role: 'quit' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'pasteAndMatchStyle' }, { role: 'selectAll' },
        { type: 'separator' },
        {
          label: isMac ? 'Find & Replace' : 'Find && Replace',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendToWindow({ type: 'find' })
        },
        {
          label: 'Spellcheck Pass',
          accelerator: 'CmdOrCtrl+;',
          click: () => sendToWindow({ type: 'spellcheck' })
        }
      ]
    },
    {
      label: 'Format',
      submenu: [
        {
          label: 'Body Font',
          submenu: [
            ...bodyFonts.map((f) => ({
              label: f,
              click: () => sendToWindow({ type: 'bodyFont', value: f })
            })),
            { type: 'separator' },
            { label: 'Other Font…', click: () => sendToWindow({ type: 'bodyFontPick' }) }
          ]
        },
        {
          label: 'Drop Cap Style',
          submenu: [
            { label: 'Literary', click: () => sendToWindow({ type: 'dropCap', value: 'literary' }) },
            { label: 'Fantasy', click: () => sendToWindow({ type: 'dropCap', value: 'fantasy' }) },
            { label: 'Sci-Fi', click: () => sendToWindow({ type: 'dropCap', value: 'scifi' }) }
          ]
        },
        {
          label: 'Align Paragraph',
          submenu: [
            { label: 'Left', click: () => sendToWindow({ type: 'align', value: 'left' }) },
            { label: 'Center', click: () => sendToWindow({ type: 'align', value: 'center' }) },
            { label: 'Right', click: () => sendToWindow({ type: 'align', value: 'right' }) },
            { label: 'Justify', click: () => sendToWindow({ type: 'align', value: 'justify' }) }
          ]
        },
        { type: 'separator' },
        { label: 'Larger Text', accelerator: 'CmdOrCtrl+=', click: () => sendToWindow({ type: 'fontSize', value: 1 }) },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: () => sendToWindow({ type: 'fontSize', value: -1 }) },
        { label: 'Reset Text Size', accelerator: 'CmdOrCtrl+0', click: () => sendToWindow({ type: 'fontSize', value: 0 }) },
        { type: 'separator' },
        {
          label: 'Typewriter Scrolling',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => sendToWindow({ type: 'typewriter' })
        },
        { type: 'separator' },
        // ticks when the caret sits in a poetry paragraph; ⇧Enter is the
        // editor's own key, so no accelerator here
        {
          label: 'Poetry Paragraph\t⇧Enter',
          type: 'checkbox',
          checked: poetryState,
          click: () => sendToWindow({ type: 'poetry' })
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Full Screen',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => {
            const w = BrowserWindow.getFocusedWindow();
            if (w) w.setFullScreen(!w.isFullScreen());
          }
        },
        { type: 'separator' },
        {
          label: 'Page',
          submenu: [
            { label: 'Night', click: () => sendToWindow({ type: 'pageTheme', value: 'night' }) },
            { label: 'Paper', click: () => sendToWindow({ type: 'pageTheme', value: 'paper' }) }
          ]
        },
        {
          label: 'Brighter Interface',
          click: () => sendToWindow({ type: 'uiBright' })
        }
      ]
    },
    {
      label: 'Plugins',
      submenu: [
        { label: 'Plugin Library…', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendToWindow({ type: 'plugins' }) }
      ]
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'NEO Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => sendToWindow({ type: 'help' })
        },
        { type: 'separator' },
        {
          label: 'About NEO',
          click: () => sendToWindow({ type: 'about' })
        },
        {
          label: 'Check for Update…',
          click: () => sendToWindow({ type: 'checkUpdate' })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Manual update check (Help → Check for Update…): a direct GitHub Releases
// lookup, separate from the silent auto-updater. Works in dev builds too.
let lastReleaseUrl = null;

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// toggling at the session level forces the engine to re-scan visible text —
// newer Chromium ignores attribute changes on text it has already looked at
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('update:check', async () => {
  try {
    const res = await fetch('https://api.github.com/repos/hughhowey/neo/releases/latest', {
      headers: { 'User-Agent': 'NEO-App' }
    });
    if (!res.ok) throw new Error('GitHub API returned ' + res.status);
    const data = await res.json();
    const latestVersion = String(data.tag_name || '').replace(/^v/, '');
    const currentVersion = app.getVersion();
    lastReleaseUrl = data.html_url || null;
    return {
      hasUpdate: !!latestVersion && compareVersions(latestVersion, currentVersion) > 0,
      latestVersion,
      currentVersion
    };
  } catch (err) {
    logError('update', err);
    return { error: true };
  }
});

// the renderer may only open the release page fetched above — never arbitrary URLs
ipcMain.handle('update:openRelease', () => {
  if (lastReleaseUrl && /^https:\/\/github\.com\//.test(lastReleaseUrl)) {
    require('electron').shell.openExternal(lastReleaseUrl);
  }
  return true;
});

// Two copies of NEO editing the same library is how words get eaten
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// Auto-update from GitHub releases. Deliberately defensive: any failure is
// logged and swallowed, so an unsigned build or offline machine never notices.
// (macOS auto-update only works once the app is code-signed.)
function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = null;
    autoUpdater.on('error', (err) => logError('updater', err));
    autoUpdater.checkForUpdatesAndNotify().catch((err) => logError('updater', err));
  } catch (err) {
    logError('updater', err);
  }
}

app.whenReady().then(() => {
  // Packaged builds get name/icon from electron-builder; this covers `npm start`.
  try {
    const devIcon = path.join(__dirname, 'build', 'icon.png');
    if (process.platform === 'darwin' && fs.existsSync(devIcon)) {
      if (app.dock) app.dock.setIcon(devIcon);
      app.setAboutPanelOptions({
        applicationName: 'NEO',
        applicationVersion: app.getVersion(),
        iconPath: devIcon
      });
    }
  } catch { /* cosmetic only */ }
  // Startup discipline: the window is created first, and every other step is
  // individually guarded so no single failure can leave the app running
  // invisibly with no window.
  try {
    // the real Documents folder (handles OneDrive-redirected Windows setups)
    try {
      LIBRARY_DIR = path.join(app.getPath('documents'), 'NEO Library');
      LIBRARY_FILE = path.join(LIBRARY_DIR, 'library.json');
    } catch (err) {
      logError('paths', err);
    }

    // macOS press-and-hold accent picker can open invisibly inside Chromium
    // and re-emit swallowed keys as phantom repeated letters. Within NEO,
    // held keys simply repeat — which is what writers expect anyway.
    if (process.platform === 'darwin') {
      try {
        const { systemPreferences } = require('electron');
        systemPreferences.setUserDefault('ApplePressAndHoldEnabled', 'boolean', false);
        // macOS injects its own items into any menu named "Edit" —
        // these two official switches remove the ones writers can't use here
        systemPreferences.setUserDefault('NSDisabledDictationMenuItem', 'boolean', true);
        systemPreferences.setUserDefault('NSDisabledCharacterPaletteMenuItem', 'boolean', true);
      } catch (err) {
        logError('prefs', err);
      }
    }

    try { ensureLibrary(); } catch (err) { logError('library', err); }
    createWindow();
    try { initSpell(); } catch (err) { logError('spell', err); }
    try { buildMenu(); } catch (err) { logError('menu', err); }
    try { dailyBackup(); } catch (err) { logError('backup', err); }
    setInterval(() => { dailyBackup(); }, 60 * 60 * 1000);
    try { checkForUpdates(); } catch (err) { logError('updater', err); }
  } catch (err) {
    // catastrophic: tell the human instead of dying in silence
    logError('startup', err);
    try {
      dialog.showErrorBox('NEO failed to start',
        'Please report this at github.com/hughhowey/neo/issues:\n\n' + String((err && err.stack) || err));
    } catch { /* nothing left to try */ }
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
