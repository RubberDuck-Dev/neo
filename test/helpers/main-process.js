// Loads main.js outside Electron, with a stand-in `electron` module, a
// throwaway home folder, and Git pointed at a local bare repository instead
// of GitHub. Each test file runs in its own process (node --test), so each
// gets a fresh main.js and a fresh home.
//
//   const neo = await loadMain();
//   await neo.call('git:push');           // any ipcMain.handle channel
//   neo.internals.resolveLibraryAtStartup();
//   neo.libraryDir                        // the current library folder

'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GITHUB_URL = 'https://github.com/test/neo-library.git';

function sh(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
}

function loadMain() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-test-'));
  const remote = path.join(home, 'remote.git');
  sh(['init', '-q', '--bare', '-b', 'main', remote], home);
  // Git: no system or user config but ours, and "GitHub" is the bare repo.
  const gitconfig = path.join(home, '.gitconfig');
  fs.writeFileSync(gitconfig, `[url "${remote.replace(/\\/g, '/')}"]\n\tinsteadOf = ${GITHUB_URL}\n[init]\n\tdefaultBranch = main\n`);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  const handlers = {};
  const dialogLog = [];
  const dialogAnswers = [];
  const sent = [];
  let reloads = 0;
  const win = { id: 1, reload: () => reloads++, webContents: { send: (_c, msg) => sent.push(msg) }, isDestroyed: () => false, on() {} };
  const electron = {
    app: {
      commandLine: { appendSwitch() {} },
      whenReady: () => new Promise(() => {}), // startup never runs; tests drive handlers
      on() {}, quit() {}, exit() {}, relaunch() {},
      requestSingleInstanceLock: () => true,
      getPath: (k) => (k === 'documents' ? path.join(home, 'Documents') : path.join(home, 'userData')),
      getVersion: () => '0.0.0-test',
      getLocale: () => 'en-US',
    },
    ipcMain: { handle: (n, f) => (handlers[n] = f), on: (n, f) => (handlers[n] = f) },
    BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => win, fromWebContents: () => win },
    dialog: {
      showOpenDialog: async () => dialogAnswers.shift() || { canceled: true, filePaths: [] },
      showMessageBox: async (w, o) => { o = o || w; dialogLog.push(o.message); return { response: 1 }; },
      showSaveDialog: async () => ({ canceled: true }),
      showErrorBox() {},
    },
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
    MenuItem: function MenuItem() {},
    shell: { trashItem: async () => {}, openExternal: async () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
    utilityProcess: { fork: () => ({ on() {}, postMessage() {} }) },
    systemPreferences: { setUserDefault() {} },
  };

  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? electron : load.call(this, request, ...rest);
  };
  const file = path.join(ROOT, 'main.js');
  const source = fs.readFileSync(file, 'utf8') + `
module.exports.__test = {
  resolveLibraryAtStartup, ensureLibrary, changeLibraryLocation, chooseLibraryFolder,
  get libraryDir() { return LIBRARY_DIR; },
};`;
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(ROOT);
  m._compile(source, file);
  const internals = m.exports.__test;

  return {
    home, remote, url: GITHUB_URL, handlers, dialogLog, dialogAnswers, sent, internals,
    get reloads() { return reloads; },
    get libraryDir() { return internals.libraryDir; },
    call: (channel, ...args) => {
      if (!handlers[channel]) throw new Error(`no handler for ${channel}`);
      return handlers[channel]({ sender: {} }, ...args);
    },
    // write a file inside the library
    write(rel, content) {
      const p = path.join(internals.libraryDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    },
    git: (args, cwd) => sh(args, cwd || internals.libraryDir),
    remoteGit: (args) => sh(['--git-dir', remote, ...args], home),
  };
}

// Let queued work (git commits, pushes after their debounce) settle.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { loadMain, wait, GITHUB_URL };
