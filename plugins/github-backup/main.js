"use strict";
const fs = require("fs"), path = require("path");
const { execFile } = require("child_process");
module.exports = function createGitBackup({ getLibraryDir, getLibraryFile, readJSON, writeJSON, atomicWrite, drainBookWrites, logError, samePath, sendToWindow, writeCatalog, quietLibrary, ipcMain, reloadWindows }) {
// Git runs without a terminal. Prompts are disabled so a missing credential
// fails fast instead of waiting forever on a TTY, and every call has a
// timeout so a dead network can never wedge the queue behind it.
const GIT_TIMEOUT_MS = 30 * 1000;
const GIT_PUSH_TIMEOUT_MS = 90 * 1000;
function gitEnv() {
  const extra = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const parts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  return { ...process.env, PATH: parts.join(path.delimiter), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'auto' };
}

function runGit(args, { timeout = GIT_TIMEOUT_MS, cwd = getLibraryDir() } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout, env: gitEnv() }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        if (error.killed) error.message = `git ${args[0]} timed out`;
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
    // Only a repository rooted at the library counts. A repo in a parent
    // folder (dotfiles in ~, a Documents repo) must never receive NEO's
    // commits or have its origin rewritten.
    const top = await runGit(['rev-parse', '--show-toplevel']);
    if (!top.stdout || !samePath(top.stdout, getLibraryDir())) {
      return { available: true, initialized: false, parentRepo: top.stdout || null };
    }
    const [branch, remote, status] = await Promise.all([
      runGit(['branch', '--show-current']),
      runGit(['remote', 'get-url', 'origin']).catch(() => ({ stdout: '' })),
      runGit(['status', '--porcelain'])
    ]);
    return { available: true, initialized: true, branch: branch.stdout || 'main', remote: remote.stdout || null, clean: !status.stdout, lastPushAt: readLastPush() };
  } catch {
    return { available: true, initialized: false };
  }
}

// Files that stay on this computer. library.json holds the email address,
// email method, and GitHub address; a scrubbed copy is committed instead so
// shelves and authors can still be restored from the backup.
const GIT_IGNORE_LINES = [
  '.neo-history/',
  'Backups/',
  'Exports/',
  'neo-errors.log',
  'library.json',
  '*.tmp',
  '.DS_Store'
];
const LIBRARY_BACKUP_FILE = 'library.backup.json';
const PRIVATE_LIBRARY_KEYS = ['emailAddress', 'emailMethod'];

function ensureGitIgnore() {
  const file = path.join(getLibraryDir(), '.gitignore');
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const have = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = GIT_IGNORE_LINES.filter((line) => !have.has(line));
  if (!missing.length) return;
  const header = current ? '' : '# NEO keeps these on this computer only. Git commits are the portable history.\n';
  const base = current && !current.endsWith('\n') ? current + '\n' : current;
  atomicWrite(file, header + base + missing.join('\n') + '\n');
}

function writeLibraryBackup() {
  const lib = readJSON(getLibraryFile(), null);
  if (!lib) return;
  const copy = JSON.parse(JSON.stringify(lib));
  for (const key of PRIVATE_LIBRARY_KEYS) delete copy[key];
  if (copy.history && copy.history.git) delete copy.history.git.remoteUrl;
  // submission contact details (legal name, address, phone) stay local
  for (const author of copy.authors || []) delete author.submission;
  const next = JSON.stringify(copy, null, 2);
  const file = path.join(getLibraryDir(), LIBRARY_BACKUP_FILE);
  let prev = null;
  try { prev = fs.readFileSync(file, 'utf8'); } catch { /* first write */ }
  if (prev !== next) atomicWrite(file, next);
}

// Commits need an identity. When the library repo has none (and no global
// one is set), fall back to a neutral identity instead of failing silently.
async function ensureGitIdentity() {
  const has = async (key) => runGit(['config', key]).then((r) => !!r.stdout, () => false);
  if (!(await has('user.name'))) await runGit(['config', 'user.name', 'NEO Writer']);
  if (!(await has('user.email'))) await runGit(['config', 'user.email', 'writer@neo.local']);
}

async function stageLibrary() {
  await ensureGitIdentity();
  ensureGitIgnore();
  writeLibraryBackup();
  // Libraries connected before library.json was ignored still track it.
  await runGit(['rm', '--cached', '--quiet', '--ignore-unmatch', 'library.json']);
  await runGit(['add', '--all']);
}

async function commitStaged(message) {
  try {
    await runGit(['diff', '--cached', '--quiet']);
    return false;
  } catch (err) {
    if (err.code !== 1) throw err;
  }
  await runGit(['commit', '--quiet', '-m', message]);
  return true;
}

async function initializeLibraryGit(authorName = 'NEO Writer', authorEmail = 'writer@neo.local') {
  const status = await libraryGitStatus();
  if (!status.available) throw new Error('Git is not installed');
  if (!status.initialized) await runGit(['init', '-b', 'main']);
  if (authorName) await runGit(['config', 'user.name', authorName]);
  if (authorEmail) await runGit(['config', 'user.email', authorEmail]);
  await stageLibrary();
  await commitStaged('NEO library baseline');
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
  return queueGit(async () => {
    let status = await libraryGitStatus();
    if (!status.initialized) status = await initializeLibraryGit();
    status = await ensureLibraryGitMainBranch();
    if (status.remote) await runGit(['remote', 'set-url', 'origin', remoteUrl]);
    else await runGit(['remote', 'add', 'origin', remoteUrl]);
    return libraryGitStatus();
  });
}

// When the last successful upload happened. Kept inside .git so it never
// becomes part of the backup itself.
const LAST_PUSH_FILE = () => path.join(getLibraryDir(), '.git', 'neo-last-push');
function readLastPush() {
  try { return fs.readFileSync(LAST_PUSH_FILE(), 'utf8').trim() || null; } catch { return null; }
}
function recordLastPush() {
  try { fs.writeFileSync(LAST_PUSH_FILE(), new Date().toISOString()); } catch (err) { logError('git-last-push', err); }
}

// A repository GitHub seeded with only its starter files (README, LICENSE,
// .gitignore) can safely be replaced by the library. Anything else might be
// real writing from another computer, so NEO never overwrites it.
const STARTER_FILE = /^(readme|license|licence|copying)(\.[\w.-]+)?$|^\.git(ignore|attributes)$/i;
const STARTER_MARK = '[starter-files] ';

async function remoteStarterOnly() {
  try {
    await runGit(['fetch', '--quiet', 'origin', 'main'], { timeout: GIT_PUSH_TIMEOUT_MS });
    const sha = (await runGit(['rev-parse', 'FETCH_HEAD'])).stdout;
    const count = Number((await runGit(['rev-list', '--count', sha])).stdout);
    const files = (await runGit(['ls-tree', '-r', '--name-only', sha])).stdout.split('\n').filter(Boolean);
    if (count > 5 || files.some((file) => file.includes('/') || !STARTER_FILE.test(file))) return null;
    return { sha, files };
  } catch {
    return null;
  }
}

function explainPushError(err) {
  const text = String((err && (err.stderr || err.message)) || '');
  if (/non-fast-forward|fetch first|rejected/i.test(text)) {
    return 'GitHub has commits this library doesn’t (a README, or another computer backing up here). Use a new, completely empty repository for each computer.';
  }
  if (/could not read Username|terminal prompts disabled|Authentication failed|Permission denied|403/i.test(text)) {
    return 'GitHub needs you to sign in. Set up Git credentials (GitHub Desktop or `gh auth login`), then try again.';
  }
  if (/timed out|Could not resolve host|unable to access/i.test(text)) {
    return 'Could not reach GitHub. NEO will try again after your next version.';
  }
  return text.split('\n').filter(Boolean).pop() || 'GitHub push failed';
}

async function pushNow() {
  const status = await ensureLibraryGitMainBranch();
  if (!status.remote) throw new Error('Connect a GitHub repository first');
  try {
    await runGit(['push', '--set-upstream', 'origin', 'HEAD'], { timeout: GIT_PUSH_TIMEOUT_MS });
  } catch (err) {
    logError('git-push', err);
    const message = explainPushError(err);
    if (/non-fast-forward|fetch first|rejected/i.test(String(err.stderr || '')) && await remoteStarterOnly()) {
      throw new Error(STARTER_MARK + 'This GitHub repository only has the starter files GitHub adds (like a README). Replace them with your library?');
    }
    throw new Error(message);
  }
  recordLastPush();
  return libraryGitStatus();
}

// Replace a starter-only GitHub repository with the library. The lease pins
// the exact commit we inspected, so anything pushed since then is never lost.
async function replaceStarterRemote() {
  await drainBookWrites();
  return queueGit(async () => {
    const status = await ensureLibraryGitMainBranch();
    if (!status.initialized || !status.remote) throw new Error('Connect a GitHub repository first');
    const starter = await remoteStarterOnly();
    if (!starter) throw new Error('GitHub has more than starter files now, so NEO won’t replace it. Use a new, empty repository.');
    await stageLibrary();
    await commitStaged('NEO backup');
    try {
      await runGit(['push', `--force-with-lease=main:${starter.sha}`, '--set-upstream', 'origin', 'HEAD:main'], { timeout: GIT_PUSH_TIMEOUT_MS });
    } catch (err) {
      logError('git-replace', err);
      throw new Error(explainPushError(err));
    }
    recordLastPush();
    return libraryGitStatus();
  });
}

// "Back up now": commit whatever is on disk, then push it.
async function pushLibraryGit() {
  await drainBookWrites();
  return queueGit(async () => {
    const status = await ensureLibraryGitMainBranch();
    if (!status.initialized) throw new Error('Connect a GitHub repository first');
    await stageLibrary();
    await commitStaged('NEO backup');
    return pushNow();
  });
}

// One git operation at a time. Nothing on the book write queue ever waits for
// this queue, so a slow network can't hold up saving.
let libraryGitQueue = Promise.resolve();
function queueGit(work) {
  const next = libraryGitQueue.catch(() => {}).then(work);
  libraryGitQueue = next.catch((err) => logError('git-history', err));
  return next;
}

function gitPrefs() {
  return readJSON(getLibraryFile(), {}).history?.git || {};
}

// Pushes are batched: a burst of versions becomes one upload.
const PUSH_DELAY_MS = 60 * 1000;
let pushTimer = null;
let pushPending = false;
function schedulePush(delay = PUSH_DELAY_MS) {
  pushPending = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; runPendingPush(); }, delay);
}

function runPendingPush({ quiet = false } = {}) {
  clearTimeout(pushTimer);
  pushTimer = null;
  if (!pushPending) return Promise.resolve(null);
  pushPending = false;
  return queueGit(async () => {
    const prefs = gitPrefs();
    if (!prefs.enabled || prefs.autoPush === false) return null;
    const status = await libraryGitStatus();
    if (!status.initialized || !status.remote) return null;
    try {
      return await pushNow();
    } catch (err) {
      if (!quiet) sendToWindow({ type: 'gitAutoPushError', message: err.message });
      return null;
    }
  });
}

function queueGitCommit(reason, after = Promise.resolve()) {
  return queueGit(async () => {
    await Promise.resolve(after).catch(() => {});
    const prefs = gitPrefs();
    if (!prefs.enabled) return null;
    const status = await ensureLibraryGitMainBranch();
    if (!status.initialized) return null;
    await stageLibrary();
    const committed = await commitStaged(`NEO checkpoint: ${reason}`);
    // Older settings only had `git.enabled`; treat those as automatic backups.
    if (committed && prefs.autoPush !== false && status.remote) schedulePush();
    return committed;
  });
}

// At launch, upload anything a previous session committed but never pushed.
function pushLeftovers() {
  const prefs = gitPrefs();
  if (!prefs.enabled || prefs.autoPush === false) return;
  pushPending = true;
  runPendingPush({ quiet: true });
}

// On quit: let the final commit land and try one push, but never hold the
// window hostage for more than a few seconds.
function settleGit(limitMs = 8000) {
  const done = libraryGitQueue.then(() => runPendingPush({ quiet: true })).catch(() => {});
  return Promise.race([done, new Promise((resolve) => setTimeout(resolve, limitMs))]);
}

const GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;

function hasBooks(dir) {
  try { return fs.readdirSync(dir).some((name) => name.startsWith('book-')); } catch { return false; }
}

async function restoreLibraryFromGit(remoteUrl) {
  if (!/^(https:\/\/github\.com\/|git@github\.com:)[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(String(remoteUrl || ''))) {
    throw new Error('Enter a GitHub repository URL');
  }
  if (!(await libraryGitStatus()).available) throw new Error('Git is not installed');
  const parent = path.dirname(getLibraryDir());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const incoming = path.join(parent, `.neo-restore-${stamp}`);
  try {
    try {
      await runGit(['clone', '--quiet', '--branch', 'main', remoteUrl, incoming], { cwd: parent, timeout: GIT_CLONE_TIMEOUT_MS });
    } catch (err) {
      logError('git-restore-clone', err);
      if (/Remote branch main not found|not found in upstream/i.test(String(err.stderr))) {
        throw new Error('That repository has no NEO backup on its main branch.');
      }
      if (/could not read Username|terminal prompts disabled|Authentication failed|not found|403/i.test(String(err.stderr))) {
        throw new Error('NEO couldn’t download that repository. Check the address, and that this computer is signed in to GitHub (GitHub Desktop or `gh auth login`).');
      }
      throw new Error(explainPushError(err));
    }
    const backup = readJSON(path.join(incoming, LIBRARY_BACKUP_FILE), null) || readJSON(path.join(incoming, 'library.json'), null);
    if (!backup || !Array.isArray(backup.shelves)) {
      throw new Error('That repository doesn’t look like a NEO Library backup.');
    }
    // This computer's private settings (email) stay; the backup brings
    // shelves, authors and preferences. Backups resume automatically.
    const local = readJSON(getLibraryFile(), {}) || {};
    const restored = { ...backup };
    for (const key of PRIVATE_LIBRARY_KEYS) if (local[key] !== undefined) restored[key] = local[key];
    restored.plugins = { ...backup.plugins, github: true };
    restored.history = { ...(backup.history || {}) };
    restored.history.git = { ...(restored.history.git || {}), enabled: true, autoPush: true, remoteUrl };
    writeJSON(path.join(incoming, 'library.json'), restored);

    // Swap in. Whatever was here is kept beside it, renamed.
    let keptAs = null;
    if (fs.existsSync(getLibraryDir())) {
      keptAs = path.join(parent, `${path.basename(getLibraryDir())} (before restore ${stamp.slice(0, 10)})`);
      let n = 2;
      while (fs.existsSync(keptAs)) keptAs = keptAs.replace(/( \d+)?\)$/, ` ${n++})`);
      try {
        await fs.promises.rename(getLibraryDir(), keptAs);
      } catch (err) {
        logError('git-restore-swap', err);
        throw new Error('NEO couldn’t set your current library aside (a file in it may be open in another app). Nothing was changed.');
      }
    }
    try {
      await fs.promises.rename(incoming, getLibraryDir());
    } catch (err) {
      logError('git-restore-swap', err);
      if (keptAs) await fs.promises.rename(keptAs, getLibraryDir()).catch((e) => logError('git-restore-undo', e));
      throw new Error('NEO couldn’t move the restored library into place. Your library is as it was.');
    }
    // A brand-new computer's empty starter library isn't worth keeping.
    if (keptAs && !hasBooks(keptAs)) {
      await fs.promises.rm(keptAs, { recursive: true, force: true }).catch(() => {});
      keptAs = null;
    }
    try { recordLastPush(); } catch { /* cosmetic */ }
    writeCatalog();
    return { keptAs, books: fs.readdirSync(getLibraryDir()).filter((n) => n.startsWith('book-')).length };
  } finally {
    await fs.promises.rm(incoming, { recursive: true, force: true }).catch(() => {});
  }
}

ipcMain.handle('git:restore', async (_e, remoteUrl) => {
  await quietLibrary();
  const result = await queueGit(() => restoreLibraryFromGit(remoteUrl));
  // reload after the reply lands, so the renderer can show what happened
  setTimeout(() => { reloadWindows(); }, 3500);
  return result;
});

ipcMain.handle('git:status', () => libraryGitStatus());
ipcMain.handle('git:initialize', (_e, authorName, authorEmail) => queueGit(async () => {
  await initializeLibraryGit(authorName, authorEmail);
  return ensureLibraryGitMainBranch();
}));
ipcMain.handle('git:connectRemote', (_e, remoteUrl) => connectLibraryGitRemote(remoteUrl));
ipcMain.handle('git:push', () => pushLibraryGit());
ipcMain.handle('git:replaceStarter', () => replaceStarterRemote());


return { queueGitCommit, settleGit, pushLeftovers };
};
