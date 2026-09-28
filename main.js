// NEO — main process
// Owns the window and all file-system access. The renderer talks to this
// through the IPC handlers below (see preload.js for the exposed API).

const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, utilityProcess, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const flushAcknowledgements = new Map();
const defaultLibraryPath = require('./main/library-path');

// macOS Chromium's "smart delete" also removes whitespace around a deleted
// selection, and that pass can duplicate characters. Deletes stay literal.
app.commandLine.appendSwitch('blink-settings', 'smartInsertDeleteEnabled=false');

// ---------------------------------------------------------------------------
// Library location: a folder of plain files the user can inspect, sync, back up.
// ---------------------------------------------------------------------------
// Resolved properly at startup via app.getPath('documents') — this default
// covers any early access and non-redirected setups.
let LIBRARY_DIR = defaultLibraryPath(path.join(os.homedir(), 'Documents'));
let LIBRARY_FILE = path.join(LIBRARY_DIR, 'library.json');

// Where the library lives can be chosen (File → Library Folder…). The
// choice is an app setting in userData (settings.json, shared with upstream
// NEO's libraryDir), never inside the library itself.
function setLibraryPath(dir) {
  LIBRARY_DIR = path.resolve(dir);
  LIBRARY_FILE = path.join(LIBRARY_DIR, 'library.json');
}

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}
function writeSettings(obj) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  writeJSON(settingsPath(), obj);
}

function validLibrary(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'library.json'))) return false;
  const data = readJSON(path.join(dir, 'library.json'), null);
  return !!data && typeof data === 'object' && Array.isArray(data.shelves);
}

function emptyDir(dir) {
  try { return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).filter((n) => n !== '.DS_Store').length === 0; } catch { return false; }
}

// Returns the configured path when it can't be used this session (a sync
// folder or external drive that isn't mounted), so the writer can be told.
// A fresh library is never created at a configured path that has vanished.
function resolveLibraryAtStartup() {
  const defaultDir = defaultLibraryPath(app.getPath('documents'));
  const settings = readSettings();
  // earlier fork builds kept the choice in preferences.json as libraryPath
  if (!settings.libraryDir) {
    const legacy = readJSON(path.join(app.getPath('userData'), 'preferences.json'), {}).libraryPath;
    if (typeof legacy === 'string' && legacy.trim()) {
      settings.libraryDir = legacy;
      try { writeSettings(settings); } catch (err) { logError('settings-migrate', err); }
    }
  }
  const configured = typeof settings.libraryDir === 'string' && settings.libraryDir.trim()
    ? path.resolve(settings.libraryDir)
    : null;
  if (!configured) { setLibraryPath(defaultDir); return null; }
  if (validLibrary(configured) || emptyDir(configured)) { setLibraryPath(configured); return null; }
  setLibraryPath(defaultDir);
  return configured;
}

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

const { readJSON, writeJSON, atomicWrite, atomicWriteAsync, queueBookWrite, drainBookWrites } = require('./main/storage')({ logError });

function samePath(a, b) {
  try {
    const norm = (p) => {
      const real = fs.realpathSync.native(path.resolve(p));
      return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
    };
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

const { queueGitCommit, settleGit, pushLeftovers } = require('./plugins/github-backup/main')({
  getLibraryDir: () => LIBRARY_DIR, getLibraryFile: () => LIBRARY_FILE,
  readJSON, writeJSON, atomicWrite, drainBookWrites, logError, samePath,
  sendToWindow, writeCatalog, quietLibrary, ipcMain,
  reloadWindows: () => { for (const win of BrowserWindow.getAllWindows()) win.reload(); }
});

const { createCheckpoint, listCheckpoints, restoreCheckpoint, verifyCheckpoint, checkpointPath, HISTORY_DIR } = require('./main/history')({ bookDir, getLibraryFile: () => LIBRARY_FILE, readJSON, atomicWriteAsync, writeCatalog });

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

// Search every book's manuscript from the shelf. Plain substring match,
// case-insensitive, one paragraph at a time (matches never span paragraphs,
// same as Find in the editor). Returns snippets grouped by book.
function htmlParagraphs(html) {
  const decode = (t) => t
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
  return String(html || '')
    .split(/<\/p>/i)
    .map((chunk) => decode(chunk.replace(/<[^>]*>/g, '')))
    .filter((text) => text.trim());
}

ipcMain.handle('library:search', async (_e, query) => {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const ql = q.toLowerCase();
  const lib = readJSON(LIBRARY_FILE, { shelves: [] });
  const shelved = (lib.shelves || []).flatMap((s) => s.bookIds || []);
  const ids = fs.readdirSync(LIBRARY_DIR).filter((d) => d.startsWith('book-'))
    .sort((a, b) => (shelved.indexOf(a) + 1 || 1e9) - (shelved.indexOf(b) + 1 || 1e9));
  const results = [];
  let total = 0;
  for (const id of ids) {
    const meta = readJSON(path.join(LIBRARY_DIR, id, 'book.json'), null);
    if (!meta || !Array.isArray(meta.chapterOrder)) continue;
    const hits = [];
    let count = 0;
    for (const [index, chId] of meta.chapterOrder.entries()) {
      let html = '';
      try { html = await fs.promises.readFile(path.join(LIBRARY_DIR, id, 'chapters', chId + '.html'), 'utf8'); } catch { continue; }
      let ordinal = 0;
      for (const para of htmlParagraphs(html)) {
        const lower = para.toLowerCase();
        let at = lower.indexOf(ql);
        while (at !== -1) {
          count++;
          if (hits.length < 25 && total < 400) {
            const start = Math.max(0, at - 60);
            const end = Math.min(para.length, at + q.length + 60);
            hits.push({
              chapterId: chId,
              chapterIndex: index,
              chapterTitle: (meta.chapterTitles || {})[chId] || '',
              ordinal,
              before: (start > 0 ? '…' : '') + para.slice(start, at).trimStart(),
              match: para.slice(at, at + q.length),
              after: para.slice(at + q.length, end).trimEnd() + (end < para.length ? '…' : '')
            });
            total++;
          }
          ordinal++;
          at = lower.indexOf(ql, at + q.length);
        }
      }
    }
    if (count) results.push({ bookId: id, title: meta.title || 'Untitled', author: meta.author || '', count, hits });
  }
  return results;
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

// every book folder in the library, shelved or not — for File → Reshelve
ipcMain.handle('library:listBooks', () => {
  const out = [];
  try {
    for (const d of fs.readdirSync(LIBRARY_DIR)) {
      if (!d.startsWith('book-')) continue;
      const m = readJSON(path.join(LIBRARY_DIR, d, 'book.json'), null);
      if (m && m.id) out.push({ id: m.id, title: m.title || 'Untitled', author: m.author || '', modified: m.modified || '' });
    }
  } catch (err) { logError('listBooks', err); }
  return out;
});

ipcMain.handle('book:readMeta', (_e, bookId) => {
  return readJSON(path.join(bookDir(bookId), 'book.json'), null);
});

ipcMain.handle('book:writeMeta', async (_e, bookId, meta) => {
  return queueBookWrite(bookId, () => {
    meta.modified = new Date().toISOString();
    writeJSON(path.join(bookDir(bookId), 'book.json'), meta);
    writeCatalog();
    return meta.modified;
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
  const localVersions = readJSON(LIBRARY_FILE, {}).history?.enabled !== false;
  const checkpoint = queueBookWrite(bookId, () => (localVersions ? createCheckpoint(bookId, reason) : null));
  // Git waits for this book's writes to land, but saving never waits for Git.
  queueGitCommit(reason, checkpoint);
  return checkpoint;
});

// A checkpoint's manuscript, for comparing with the current one. Read-only;
// the checkpoint is verified first so a damaged copy never looks like truth.
ipcMain.handle('history:read', async (_e, bookId, checkpointId) => {
  const checked = await verifyCheckpoint(bookId, checkpointId);
  if (!checked.valid) throw new Error(`That version can’t be read: ${checked.error || 'invalid manifest'}`);
  const dir = checkpointPath(bookId, checkpointId);
  const meta = readJSON(path.join(dir, 'book.json'), {});
  const chapters = {};
  for (const file of checked.manifest.files) {
    const m = /^chapters\/([^/]+)\.html$/.exec(file.path);
    if (m) chapters[m[1]] = await fs.promises.readFile(path.join(dir, file.path), 'utf8');
  }
  return { createdAt: checked.manifest.createdAt, meta, chapters };
});

ipcMain.handle('history:list', async (_e, bookId) => {
  return listCheckpoints(bookId);
});

ipcMain.handle('history:restore', async (_e, bookId, checkpointId) => {
  const restored = queueBookWrite(bookId, () => restoreCheckpoint(bookId, checkpointId));
  queueGitCommit('restore', restored);
  return restored;
});

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

// Is a formatting tag (<w:b>, <w:i>) present, and is it on? Returns true,
// false (present but switched off — Word writes <w:i w:val="0"/> to cancel
// a style's italics), or undefined when the run says nothing about it.
function docxFormatOn(rpr, tag) {
  const hit = rpr.match(new RegExp('<' + tag + '(?:\\s[^>]*)?/?>'));
  if (!hit) return undefined;
  const val = (hit[0].match(/w:val="([^"]*)"/) || [])[1];
  return val === undefined || /^(true|1|on)$/i.test(val);
}

// Italics and bold don't always sit on the run: a manuscript may carry them
// in a character style ("Emphasis", Scrivener's "Italic") or a paragraph
// style. Read word/styles.xml once into { styleId: { bold, italic } },
// following basedOn so a style built on an italic one stays italic.
function docxStyleFormats(stylesXml) {
  const out = {};
  if (!stylesXml) return out;
  const raw = {};
  for (const m of stylesXml.matchAll(/<w:style\s[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const body = m[2];
    const basedOn = (body.match(/<w:basedOn\s+w:val="([^"]+)"/) || [])[1];
    // only the style's own run properties, not the paragraph-mark ones
    const rpr = (body.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    raw[m[1]] = { basedOn, bold: docxFormatOn(rpr, 'w:b'), italic: docxFormatOn(rpr, 'w:i') };
  }
  const resolve = (id, depth) => {
    if (out[id]) return out[id];
    const st = raw[id];
    if (!st || depth > 8) return { bold: false, italic: false };
    const base = st.basedOn ? resolve(st.basedOn, depth + 1) : { bold: false, italic: false };
    out[id] = {
      bold: st.bold === undefined ? base.bold : st.bold,
      italic: st.italic === undefined ? base.italic : st.italic
    };
    return out[id];
  };
  for (const id of Object.keys(raw)) resolve(id, 0);
  return out;
}

// Convert one Word paragraph's bold/italic XML into markdown text with bold/italic
function docxParagraphToMarkdown(p, styles = {}) {
  const pageBreak = /<w:br [^>]*w:type="page"/.test(p) || /<w:pageBreakBefore/.test(p);
  // Word marks headings with a paragraph style such as <w:pStyle w:val="Heading1"/>.
  // Any heading style (Heading1..9, or bare "Heading") starts a new chapter and
  // gives it its title — regardless of locale, the underlying style id is
  // always "Heading*".
  const pStyle = (p.match(/<w:pStyle\s+w:val="([^"]*)"/) || [])[1] || '';
  const heading = /^heading\d*$/i.test(pStyle);
  // Google Docs exports each of a document's tabs under a "Title"-styled
  // line, and the book's own title page uses the same style: the first one
  // names the book, later ones start chapters (see chapterize)
  const title = /^title$/i.test(pStyle);
  // what the paragraph's style says, before any run has its say
  const pBase = styles[pStyle] || { bold: false, italic: false };
  const runs = [...p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map((rm) => {
    const r = rm[0];
    const rpr = (r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    const text = [...r.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((t) => decodeEntities(t[1])).join('');
    const rStyle = (rpr.match(/<w:rStyle\s+w:val="([^"]*)"/) || [])[1];
    const rBase = rStyle && styles[rStyle] ? styles[rStyle] : pBase;
    const b = docxFormatOn(rpr, 'w:b');
    const i = docxFormatOn(rpr, 'w:i');
    return { text, bold: b === undefined ? !!rBase.bold : b, italic: i === undefined ? !!rBase.italic : i };
  });
  // make sure **one**"+"**two**" becomes one "**onetwo**", not "**one****two**"
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic) last.text += run.text;
    else merged.push({ ...run });
  }
  const text = merged.map((run) => {
    let t = run.text;
    if (run.bold) t = '**' + t + '**';
    if (run.italic) t = '*' + t + '*';
    return t;
  }).join('').trim();
  return { text, pageBreak, heading, title };
}

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
    const stylesFile = zip.file('word/styles.xml');
    const styles = docxStyleFormats(stylesFile ? await stylesFile.async('string') : '');
    paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
      .map((m) => docxParagraphToMarkdown(m[0], styles));
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
  // A markdown heading: one or more "#" then text — any "size" (depth) counts.
  const isMdHeading = (t) => /^#{1,6}\s+\S/.test(t);
  const mdTitleOf = (t) => t.replace(/^#{1,6}\s*/, '').trim();
  // A heading that is purely NEO's own numbering ("Chapter 2", "Prologue",
  // bare "7") carries no title — NEO numbers chapters itself.
  // Chinese manuscripts mark chapters 第N章 / 第N回 …, or 序章 / 楔子 / 尾声 …
  // (from hughhowey/neo#27 by jqlong17)
  const isCjkHeading = (t) =>
    (/^第[零〇一二三四五六七八九十百千万两0-9０-９]+[章节回部篇卷]/.test(t) && t.length < 40) ||
    (/^(序章|序言|楔子|引子|前言|尾声|终章|后记|附录|番外)([：:\s].*)?$/.test(t) && t.length < 40);
  const isNumberedHeading = (t) => (
    (/^(chapter|prologue|epilogue|part)\b/i.test(t) && t.length < 60) ||
    isCjkHeading(t.trim()) ||
    (numeralMode && isNumeralish(t))
  );
  const isHeading = (t) => t && (isMdHeading(t) || isNumberedHeading(t));
  // The chapter title that a heading contributes. Markdown hashes and any
  // emphasis markers are stripped, and pure numbering yields no title.
  const titleOf = (t) => {
    if (isMdHeading(t)) t = mdTitleOf(t);
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1');
    // "第一章 风起" numbers the chapter and names it: keep the name
    const cjkName = t.trim().match(/^第[零〇一二三四五六七八九十百千万两0-9０-９]+[章节回部篇卷][\s：:、．.·-]*(.+)$/);
    if (cjkName) return cjkName[1].trim();
    return isNumberedHeading(t) ? '' : t;
  };
  const isBreak = (t) => /^\s*([*#•~⁂—–-]\s*){1,7}$/.test(t || '');

  let styledTitle = null; // a Title-styled first line: the book's name
  const chapterize = (usePageBreaks) => {
    const chapters = [];
    let cur = [];
    let curTitle = '';
    let seenProse = false;
    let lastWasHeading = false;
    styledTitle = null;
    const close = () => {
      if (cur.length) chapters.push({ title: curTitle, paras: cur });
      cur = [];
      curTitle = '';
    };
    for (const p of paras) {
      const brk = usePageBreaks && p.pageBreak;
      if (!p.text && !brk && !p.heading && !p.title) continue;
      // a Title line before any prose is the book's title, not a chapter's
      if (p.title && !seenProse && styledTitle === null && p.text) { styledTitle = titleOf(p.text); continue; }
      const isH = p.heading || p.title || isHeading(p.text);
      if (brk || isH) {
        // a heading that follows another with no prose between (a Google
        // Docs tab named "Chapter 2" holding a "The Long Way Home" heading)
        // refines the chapter's title instead of opening an empty chapter
        if (isH && lastWasHeading && !cur.length && !brk) {
          const t = titleOf(p.text || '');
          if (t) curTitle = curTitle ? `${curTitle} — ${t}` : t;
          continue;
        }
        close();
      }
      if (isH) { curTitle = titleOf(p.text || ''); lastWasHeading = true; continue; } // the heading line is replaced by NEO's numbering
      lastWasHeading = false;
      if (isBreak(p.text)) { cur.push({ scene: true }); continue; }
      if (p.text) { cur.push({ text: p.text }); seenProse = true; }
    }
    close();
    return chapters;
  };

  const countText = require("./shared/text").countWords;
  const countAllWords = (list) =>
    list.reduce((n, ch) => n + ch.paras.reduce((m, p) => m + (p.text ? countText(p.text) : 0), 0), 0);

  // First pass trusts page breaks. Some word processors sprinkle page-break
  // formatting on every paragraph, exploding a story into confetti — if the
  // result is absurd (lots of tiny "chapters"), re-run trusting headings only.
  let chapters = chapterize(true);
  if (chapters.length > 6 && countAllWords(chapters) / chapters.length < 250) {
    chapters = chapterize(false);
  }
  if (!chapters.length) chapters.push({ title: '', paras: [{ text: '' }] });

  // Front matter: a short title line and a "by Author" line belong on the
  // title page, not in the body. Detect, harvest, and remove them.
  let title = styledTitle || null;
  let author = null;
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); // any script, not just a–z
  const first = chapters[0];
  if (first && first.paras.length) {
    const t0 = (first.paras[0].text || '').trim();
    const t1 = first.paras.length > 1 ? (first.paras[1].text || '').trim() : '';
    const titleish = t0 && t0.length < 90 && !/[.!?]$/.test(t0) && (
      ((norm(t0).length > 3 || (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t0) && norm(t0).length >= 2)) && norm(name).includes(norm(t0))) ||
      /^by\s+\S/i.test(t1) ||
      (t0 === t0.toUpperCase() && /[A-Z].*[A-Z]/.test(t0) && t0.length < 60)
    );
    if (titleish) {
      title = t0;
      first.paras.shift();
    }
    const bl = first.paras.length ? (first.paras[0].text || '').trim().match(/^by\s+(.{2,60})$/i) : null;
    if (bl) {
      author = bl[1].trim();
      first.paras.shift();
    }
    if (!first.paras.length) chapters.shift();
    if (!chapters.length) chapters.push({ title: '', paras: [{ text: '' }] });
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
async function zipLibrary(target) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  const skip = new Set(['Backups', 'Exports', HISTORY_DIR, '.git']);
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
}

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
    await zipLibrary(target);

    // prune old backups
    const backups = fs.readdirSync(backupsDir).filter((f) => f.startsWith('neo-backup-')).sort();
    while (backups.length > 14) fs.unlinkSync(path.join(backupsDir, backups.shift()));
  } catch (err) {
    logError('backup', err);
  }
}

// ---------------------------------------------------------------------------
// Library location (adapted from hughhowey/neo#16 by swirlingstagnancy)
// ---------------------------------------------------------------------------

// Ask the window to write out anything still in memory, then wait for the
// book queues and Git to settle, so a move or switch sees a quiet library.
async function quietLibrary() {
  sendToWindow({ type: 'flush' });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await drainBookWrites();
  await settleGit(15000);
}

function libraryTargetForSelection(selected) {
  return path.resolve(selected);
}

async function switchLibraryTo(target) {
  const settings = readSettings();
  const defaultDir = defaultLibraryPath(app.getPath('documents'));
  if (samePath(target, defaultDir) || path.resolve(target) === path.resolve(defaultDir)) delete settings.libraryDir;
  else settings.libraryDir = target;
  delete settings.libraryPath;
  writeSettings(settings);
  setLibraryPath(target);
  try { spelling.reset(); } catch (err) { logError('spell', err); } // the new library's language and words
  for (const w of BrowserWindow.getAllWindows()) w.reload();
}

// File → Library Folder… (upstream's menu item, with this fork's safe move:
// NEO copies the library to the new place and leaves the original intact).
async function chooseLibraryFolder() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const defaultDir = defaultLibraryPath(app.getPath('documents'));
  const custom = path.resolve(LIBRARY_DIR) !== path.resolve(defaultDir);
  const ask = await dialog.showMessageBox(win, {
    type: 'question',
    message: 'Library folder',
    detail: `Your books live in:\n${LIBRARY_DIR}\n\nChoose another place and NEO copies your library there (or opens the NEO library already in it). The original stays where it is.`,
    buttons: custom ? ['Choose Folder…', 'Use Default Folder', 'Cancel'] : ['Choose Folder…', 'Cancel'],
    defaultId: 0,
    cancelId: custom ? 2 : 1
  });
  if (ask.response === 0) return changeLibraryLocation();
  if (custom && ask.response === 1) return changeLibraryLocation(defaultDir);
}

async function changeLibraryLocation(chosenTarget = null) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  let picked = chosenTarget;
  if (!picked) {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose the exact library folder (empty or an existing NEO library)',
      defaultPath: path.dirname(LIBRARY_DIR),
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths.length) return;
    picked = libraryTargetForSelection(filePaths[0]);
  }

  const oldLibrary = path.resolve(LIBRARY_DIR);
  const target = path.resolve(picked);
  if (samePath(target, oldLibrary) || target === oldLibrary) {
    await dialog.showMessageBox(win, { type: 'info', message: 'NEO is already using this library.', detail: oldLibrary });
    return;
  }
  if (target.startsWith(oldLibrary + path.sep)) {
    await dialog.showMessageBox(win, {
      type: 'error',
      message: 'Choose a place outside your current NEO Library.',
      detail: 'A library inside another library would make backups and moving unsafe.'
    });
    return;
  }

  await quietLibrary();
  try {
    const backupsDir = path.join(LIBRARY_DIR, 'Backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    await zipLibrary(path.join(backupsDir, `neo-safety-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`));
  } catch (err) {
    logError('library-move-backup', err);
    await dialog.showMessageBox(win, {
      type: 'error',
      message: 'NEO could not make a safety backup first.',
      detail: 'Your library was not moved. Check neo-errors.log and try again.'
    });
    return;
  }

  const targetExists = fs.existsSync(target);
  const targetHasLibrary = targetExists && fs.existsSync(path.join(target, 'library.json'));
  if (targetHasLibrary) {
    if (!validLibrary(target)) {
      await dialog.showMessageBox(win, { type: 'error', message: 'That folder doesn’t hold a valid NEO library.', detail: target });
      return;
    }
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancel', 'Use This Library'],
      defaultId: 1,
      cancelId: 0,
      message: 'Use the NEO Library that’s already here?',
      detail: `NEO will switch to:\n${target}\n\nYour current library stays untouched at:\n${oldLibrary}`
    });
    if (response !== 1) return;
  } else {
    if (targetExists && fs.readdirSync(target).length > 0) {
      await dialog.showMessageBox(win, {
        type: 'error',
        message: 'The selected folder is not empty and does not contain a NEO library.',
        detail: 'Choose another place, or a folder that already holds a NEO library.'
      });
      return;
    }
    try {
      if (targetExists) fs.rmdirSync(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(oldLibrary, target, { recursive: true, errorOnExist: true });
      if (!validLibrary(target)) throw new Error('Copied library failed validation');
    } catch (err) {
      try {
        if (fs.existsSync(target) && !validLibrary(target)) fs.rmSync(target, { recursive: true, force: true });
      } catch { /* keep the original error */ }
      logError('library-move', err);
      await dialog.showMessageBox(win, {
        type: 'error',
        message: 'NEO couldn’t copy your library.',
        detail: 'Your original library is untouched. Check neo-errors.log and try again.'
      });
      return;
    }
  }

  await dialog.showMessageBox(win, {
    type: 'info',
    message: targetHasLibrary ? 'Library switched.' : 'Library copied and switched.',
    detail: targetHasLibrary
      ? `NEO now uses:\n${target}\n\nYour previous library is untouched at:\n${oldLibrary}`
      : `NEO now uses:\n${target}\n\nThe original is still at:\n${oldLibrary}\n\nKeep it until you’re happy the new place works.`
  });
  await switchLibraryTo(target);
}

// ---------------------------------------------------------------------------
// Restore a library from its GitHub backup (a new or replacement computer).
// One-way and non-destructive: the backup is cloned beside the library,
// checked, and only then swapped in. Whatever was here before is renamed,
// never deleted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  const saved = readSettings().window || {};
  let bounds = { width: 1200, height: 800 };
  if (saved.width >= 800 && saved.height >= 600) {
    bounds = { width: saved.width, height: saved.height };
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      const visible = screen.getAllDisplays().some(({ workArea: area }) =>
        saved.x + 100 < area.x + area.width && saved.x + saved.width - 100 > area.x &&
        saved.y + 40 < area.y + area.height && saved.y >= area.y - 20);
      if (visible) Object.assign(bounds, { x: saved.x, y: saved.y });
    }
  }
  const win = new BrowserWindow({
    ...bounds,
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
  let boundsTimer;
  const rememberBounds = () => {
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => writeSettings({ ...readSettings(), window: win.getNormalBounds() }), 250);
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('close', () => { clearTimeout(boundsTimer); if (!win.isFullScreen() && !win.isMinimized()) writeSettings({ ...readSettings(), window: win.getNormalBounds() }); });

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
      drainBookWrites().catch((err) => logError('shutdown-save', err)).then(() => settleGit()).finally(() => {
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
// Spellcheck: NEO's own bundled Hunspell dictionaries via nspell, identical
// on every platform. The renderer paints the squiggles and asks for
// suggestions. Edit → Spellcheck Language picks the dictionary; the choice
// lives in library.json so it travels with the writer's books.
// (Languages beyond US English: idea and dictionary set from Zaim Halili.)
// ---------------------------------------------------------------------------
const SPELL_LANGUAGES = require('./shared/language-data').dictionaries;
const spelling = require('./plugins/spellcheck/main')({ utilityProcess, ipcMain,
  preferences: () => readJSON(LIBRARY_FILE, {}), logError,
  menuChanged: () => buildMenu()
});

// ---------------------------------------------------------------------------
// Application menu — Help and Format live here, out of the writing room
// ---------------------------------------------------------------------------
function sendToWindow(msg) {
  const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (w) w.webContents.send('menu', msg);
}

// the Format menu's ticks: whether the caret is in a poetry paragraph, and
// whether typewriter scrolling is on
let poetryState = false;
let typewriterState = false;
ipcMain.on('poetry:state', (_e, on) => {
  on = !!on;
  if (on === poetryState) return;
  poetryState = on;
  try { buildMenu(); } catch (err) { logError('menu', err); }
});
ipcMain.on('typewriter:state', (_e, on) => {
  on = !!on;
  if (on === typewriterState) return;
  typewriterState = on;
  try { buildMenu(); } catch (err) { logError('menu', err); }
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  // macOS and Windows name faces that ship with the OS. Linux has none of
  // them, so the menu names the faces bundled in fonts/ (see styles.css).
  // The Windows list stays the one the renderer already understands.
  const bodyFonts = isMac
    ? ['Georgia', 'Palatino', 'Baskerville', 'Hoefler Text', 'Iowan Old Style']
    : isWin
      ? ['Georgia', 'Palatino', 'Baskerville', 'Cambria', 'Constantia']
      : ['Gelasio', 'TeX Gyre Pagella', 'Libre Baskerville', 'Alegreya', 'Source Serif Pro'];
  const template = [
    // appMenu exists only on macOS — including it on Windows throws,
    // which is exactly what kept NEO from ever opening a window there
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: isMac ? 'Saving & Recovery…' : 'Saving && Recovery…', click: () => sendToWindow({ type: 'syncSettings' }) },
        {
          label: isMac ? 'Progress & Goals…' : 'Progress && Goals…',
          click: () => sendToWindow({ type: 'stats' })
        },
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            { label: 'Word (.docx)', click: () => sendToWindow({ type: 'export', format: 'docx' }) },
            { label: 'Manuscript Format (.docx)…', click: () => sendToWindow({ type: 'export', format: 'manuscript' }) },
            { label: 'PDF (.pdf)', click: () => sendToWindow({ type: 'export', format: 'pdf' }) },
            { label: 'EPUB (.epub)', click: () => sendToWindow({ type: 'export', format: 'epub' }) },
            { label: 'Plain Text (.txt)', click: () => sendToWindow({ type: 'export', format: 'txt' }) },
            { label: 'Markdown (.md)', click: () => sendToWindow({ type: 'export', format: 'md' }) },
            { label: 'Web Page (.html)', click: () => sendToWindow({ type: 'export', format: 'html' }) }
          ]
        },
        { label: 'Publishing Details…', click: () => sendToWindow({ type: 'publishingDetails' }) },
        { type: 'separator' },
        {
          label: 'Email Draft to Myself…',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendToWindow({ type: 'emailDraft' })
        },
        { label: 'Email Settings…', click: () => sendToWindow({ type: 'emailSettings' }) },
        { type: 'separator' },
        {
          label: 'Import Manuscripts…',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => sendToWindow({ type: 'import' })
        },
        { type: 'separator' },
        { label: 'Reshelve a Book…', click: () => sendToWindow({ type: 'reshelve' }) },
        { label: 'Library Folder…', click: () => { chooseLibraryFolder().catch((err) => logError('library folder', err)); } },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => sendToWindow({ type: 'preferences' }) },
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
        },
        {
          label: 'Spellcheck Language',
          submenu: Object.entries(SPELL_LANGUAGES).map(([code, lang]) => ({
            label: lang.label,
            type: 'radio',
            checked: spelling.language === code,
            click: () => sendToWindow({ type: 'spellLanguage', value: code })
          }))
        },
        {
          label: 'Revision Pass',
          accelerator: 'CmdOrCtrl+Shift+;',
          click: () => sendToWindow({ type: 'revisionPass' })
        },
        {
          label: 'Read Aloud',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => sendToWindow({ type: 'readAloud' })
        },
        { label: 'Voice Settings…', click: () => sendToWindow({ type: 'readAloudSettings' }) }
      ]
    },
    {
      label: 'Format',
      submenu: [
        {
          label: 'Paragraph Alignment',
          submenu: [
            { label: 'Left', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendToWindow({ type: 'align', value: 'left' }) },
            { label: 'Center', accelerator: 'CmdOrCtrl+Shift+C', click: () => sendToWindow({ type: 'align', value: 'center' }) },
            { label: 'Right', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendToWindow({ type: 'align', value: 'right' }) },
            { label: 'Justify', accelerator: 'CmdOrCtrl+Shift+J', click: () => sendToWindow({ type: 'align', value: 'justify' }) }
          ]
        },
        // ticks when the caret sits in a poetry paragraph; ⇧Enter is the
        // editor's own key, so show it without registering a native handler
        {
          label: 'Poetry Paragraph',
          // macOS cannot display an accelerator without registering it.
          accelerator: isMac ? undefined : 'Shift+Enter', registerAccelerator: false,
          type: 'checkbox',
          checked: poetryState,
          click: () => sendToWindow({ type: 'poetry' })
        },
        { type: 'separator' },
        {
          label: 'Manuscript Font',
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
            { label: 'Sci-Fi', click: () => sendToWindow({ type: 'dropCap', value: 'scifi' }) },
            { type: 'separator' },
            { label: 'Off', click: () => sendToWindow({ type: 'dropCap', value: 'none' }) }
          ]
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Larger Text', accelerator: 'CmdOrCtrl-Plus', click: () => sendToWindow({ type: 'fontSize', value: 1 }) },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl-Minus', click: () => sendToWindow({ type: 'fontSize', value: -1 }) },
        { label: 'Reset Text Size', accelerator: 'CmdOrCtrl+0', click: () => sendToWindow({ type: 'fontSize', value: 0 }) },
        { type: 'separator' },
        {
          label: 'Typewriter Scrolling',
          accelerator: 'CmdOrCtrl+Shift+T',
          type: 'checkbox', checked: typewriterState,
          click: () => sendToWindow({ type: 'typewriter' })
        },
        {
          label: 'Focus Mode',
          submenu: [
            { label: 'Cycle', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendToWindow({ type: 'focusCycle' }) },
            { type: 'separator' },
            { label: 'Sentence', click: () => sendToWindow({ type: 'focus', value: 'sentence' }) },
            { label: 'Paragraph', click: () => sendToWindow({ type: 'focus', value: 'paragraph' }) },
            { label: 'Off', click: () => sendToWindow({ type: 'focus', value: 'off' }) }
          ]
        },
        { type: 'separator' },
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
          label: 'Page Appearance',
          submenu: [
            { label: 'Dark Paper', click: () => sendToWindow({ type: 'pageTheme', value: 'night' }) },
            { label: 'Light Paper', click: () => sendToWindow({ type: 'pageTheme', value: 'paper' }) }
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
          label: 'Keyboard Shortcuts…',
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

const { checkForUpdates } = require('./main/updates')({ app, ipcMain, logError });

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
    // the chosen library, or the real Documents folder (handles
    // OneDrive-redirected Windows setups)
    let unavailableLibrary = null;
    try {
      unavailableLibrary = resolveLibraryAtStartup();
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
    try { spelling.reset(); } catch (err) { logError('spell', err); }
    try { buildMenu(); } catch (err) { logError('menu', err); }
    if (unavailableLibrary) {
      dialog.showMessageBox({
        type: 'warning',
        message: 'Your NEO Library isn’t available right now.',
        detail: `NEO opened the default Documents library for this session.\n\nYour library’s usual place:\n${unavailableLibrary}\n\nIf it’s on a sync folder or an external drive, reconnect it and restart NEO. Your setting hasn’t changed.`
      }).catch((err) => logError('library-path-warning', err));
    }
    try { dailyBackup(); } catch (err) { logError('backup', err); }
    setInterval(() => { dailyBackup(); }, 60 * 60 * 1000);
    setTimeout(() => { try { pushLeftovers(); } catch (err) { logError('git-startup', err); } }, 15 * 1000);
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
