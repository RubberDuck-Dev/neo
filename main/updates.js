"use strict";
module.exports = function createUpdates({ app, ipcMain, logError, sendToWindow }) {
  let updater = null, ready = false, lastReleaseUrl = null;
  const compareVersions = (a, b) => {
    const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
    }
    return 0;
  };
  function getUpdater() {
    if (updater || !app.isPackaged) return updater;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = null;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('download-progress', p => sendToWindow({ type: 'update', state: 'downloading', percent: p.percent, transferred: p.transferred, total: p.total }));
    autoUpdater.on('update-downloaded', info => {
      ready = true;
      sendToWindow({ type: 'update', state: 'ready', version: info?.version });
    });
    autoUpdater.on('error', err => {
      logError('updater', err);
      sendToWindow({ type: 'update', state: 'error', message: String(err?.message || err) });
    });
    updater = autoUpdater;
    return updater;
  }
  async function latestRelease() {
    const res = await fetch('https://api.github.com/repos/hughhowey/neo/releases/latest', {
      headers: { 'User-Agent': 'NEO-App' }
    });
    if (!res.ok) throw new Error('GitHub API returned ' + res.status);
    const data = await res.json();
    lastReleaseUrl = data.html_url || null;
    return String(data.tag_name || '').replace(/^v/, '');
  }
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:check', async () => {
    const currentVersion = app.getVersion();
    try {
      const u = getUpdater();
      if (u) {
        const result = await u.checkForUpdates();
        const latestVersion = result?.updateInfo?.version || '';
        latestRelease().catch(() => {});
        return { hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
          latestVersion, currentVersion, canInstall: true, ready };
      }
    } catch (err) { logError('update', err); }
    try {
      const latestVersion = await latestRelease();
      return { hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
        latestVersion, currentVersion, canInstall: false };
    } catch (err) { logError('update', err); return { error: true }; }
  });
  ipcMain.handle('update:download', async () => {
    const u = getUpdater();
    if (!u) return false;
    if (ready) { sendToWindow({ type: 'update', state: 'ready' }); return true; }
    try { await u.downloadUpdate(); return true; }
    catch (err) {
      logError('updater', err);
      sendToWindow({ type: 'update', state: 'error', message: String(err?.message || err) });
      return false;
    }
  });
  ipcMain.handle('update:install', () => {
    const u = getUpdater();
    if (!u || !ready) return false;
    setImmediate(() => u.quitAndInstall(false, true));
    return true;
  });
  ipcMain.handle('update:openRelease', () => {
    if (lastReleaseUrl && /^https:\/\/github\.com\//.test(lastReleaseUrl)) {
      require('electron').shell.openExternal(lastReleaseUrl);
    }
    return true;
  });
  function checkForUpdates() {
    if (!app.isPackaged) return;
    setTimeout(async () => {
      try {
        const result = await getUpdater().checkForUpdates();
        const version = result?.updateInfo?.version || '';
        if (version && compareVersions(version, app.getVersion()) > 0) {
          sendToWindow({ type: 'update', state: 'available', version });
        }
      } catch (err) { logError('updater', err); }
    }, 8000);
  }
  return { checkForUpdates };
};
