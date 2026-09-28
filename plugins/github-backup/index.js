"use strict";
NeoPlugins.define("github", { name: "GitHub backup", icon: "⌘", kind: "Backup", description: "Back up the entire library to a private GitHub repository.", scope: "library", requires: ["git"], libraryFields: ["history"], configureLabel: "Open backup settings",
  disableSettings(settings) { return { history: { ...settings.history, git: { ...settings.history?.git, enabled: false, autoPush: false } } }; }
}, (ctx) => {
  const { escHtml, toast, ipcErrorText, timeAgo } = ctx;
  const api = ctx.git;
  let active = null;
  function configure({ onLocal, host } = {}) {
    if (active) return;
    let git = ctx.librarySettings.history?.git || {};
    let busy = true, connected = false, editingConnection = false, available = false, lastPushAt = null;
    let timer;
    const { bd, close, switchTo } = ctx.settingsDialog({
      title: onLocal ? "Saving & recovery" : "GitHub backup", scope: "Entire library · all authors", className: `github-settings-modal${onLocal ? ' saving-tabs-modal' : ''}`, host,
      tabs: onLocal ? [{ label: 'Local saving', select: () => switchTo(onLocal) }, { label: 'GitHub backup', active: true }] : [],
      back: onLocal ? null : ctx.openLibrary, canClose: () => !busy,
      onClose: () => { clearInterval(timer); active = null; },
      content: `
        <p>Keep a copy of your library on GitHub. Your writing always autosaves locally, whether or not backup is connected.</p>
        <p id="sy-git-status" class="sync-status-line" role="status" aria-live="polite">Checking connection…</p>
        <p id="sy-git-last" class="sync-detail" hidden></p>
        <section id="git-setup" hidden>
          <p>Create an empty private repository on GitHub, then paste its HTTPS address.</p>
          <label>GitHub repository address<input id="sy-git-remote" value="${escHtml(git.remoteUrl || '')}" placeholder="https://github.com/you/neo-library.git"/></label>
          <button id="sy-git-connect" class="btn-gold">Connect &amp; back up</button><button id="git-cancel-connection" class="btn-quiet" hidden>Keep current connection</button>
          <p class="sync-detail">Connecting turns on automatic backups. Git may ask you to sign in.</p>
        </section>
        <section id="git-connected" hidden>
          <label>Connected repository<input id="git-repository" readonly aria-label="Connected repository"/></label>
          <button id="git-change-connection" class="btn-quiet">Change repository…</button>
          <label class="sync-switch"><input id="sy-git-enabled" type="checkbox" ${git.enabled && git.autoPush !== false ? 'checked' : ''}/><span>Back up automatically after each version</span></label>
          <p class="sync-detail">This preference saves immediately. Automatic backups run when NEO creates a local version.</p>
          <button id="sy-git-push" class="btn-gold">Back up now</button>
        </section>
        <section id="git-conflict" class="stats-section" hidden><h3>Repository has starter files</h3><p>Replace GitHub’s starter files with this library only if you no longer need them.</p><button id="sy-git-replace" class="btn-danger">Replace GitHub copy…</button></section>
        <section class="stats-section"><h3>Recovery</h3><button id="sy-git-restore" class="btn-quiet">Set up this computer from a backup…</button></section>`,
      actions: '<button class="m-ok btn-quiet">Done</button>'
    });
    // The backdrop can be handed back to Local saving; own only this panel.
    ctx.own(bd.firstElementChild);
    active = { close: () => { busy = false; close(); } };
    const $ = selector => bd.querySelector(selector);
    const status = (message, error = false) => { $('#sy-git-status').textContent = message; $('#sy-git-status').classList.toggle('dialog-error', error); };
    const failure = (err, fallback) => {
      const { text, starter } = ipcErrorText(err, fallback);
      status(text, true); $('#git-conflict').hidden = !starter;
    };
    const last = () => {
      const ago = timeAgo(lastPushAt); $('#sy-git-last').hidden = !ago;
      if (ago) $('#sy-git-last').textContent = `Last successful backup ${ago}.`;
    };
    const controls = () => {
      if (busy) bd.firstElementChild.focus();
      bd.querySelectorAll('button, input').forEach(el => el.disabled = busy);
      $('#sy-git-connect').disabled = busy || !available;
      $('#sy-git-restore').disabled = busy || !available;
      $('#sy-git-push').disabled = busy || !connected;
      $('#sy-git-enabled').disabled = busy || !connected;
      $('#git-setup').hidden = (connected && !editingConnection) || !available;
      $('#git-connected').hidden = !connected || editingConnection;
      $('#git-cancel-connection').hidden = !connected;
    };
    const note = current => { if (current?.lastPushAt) lastPushAt = current.lastPushAt; last(); };
    const save = async patch => {
      const next = { ...git, ...patch };
      await ctx.saveLibrarySettings({ history: { ...ctx.librarySettings.history, git: next } });
      git = next;
    };
    const work = async fn => {
      if (busy) return;
      busy = true; controls(); $('#git-conflict').hidden = true;
      try { await fn(); } catch (err) { failure(err, 'Could not complete the backup operation.'); }
      finally { busy = false; controls(); }
    };
    $('.m-ok').onclick = close;
    $('#git-change-connection').onclick = () => { editingConnection = true; $('#sy-git-remote').value = $('#git-repository').value; controls(); $('#sy-git-remote').focus(); };
    $('#git-cancel-connection').onclick = () => { editingConnection = false; controls(); };
    $('#sy-git-connect').onclick = () => work(async () => {
      const remoteUrl = $('#sy-git-remote').value.trim();
      status('Connecting…');
      await ctx.flushSaves(); await api.connect(remoteUrl);
      connected = true; editingConnection = false; $('#git-repository').value = remoteUrl;
      await save({ enabled: true, autoPush: true, remoteUrl });
      $('#sy-git-enabled').checked = true;
      status('Uploading…'); note(await api.push());
      status('Backup complete. Automatic backups are on.');
    });
    $('#sy-git-push').onclick = () => work(async () => {
      await ctx.flushSaves(); status('Uploading…'); note(await api.push()); status('Backup complete.');
    });
    $('#sy-git-enabled').onchange = () => work(async () => {
      const enabled = $('#sy-git-enabled').checked;
      try { await save({ enabled, autoPush: enabled }); status(enabled ? 'Automatic backups are on.' : 'Automatic backups are off. You can still back up now.'); }
      catch (err) { $('#sy-git-enabled').checked = !!(git.enabled && git.autoPush !== false); throw err; }
    });
    $('#sy-git-replace').onclick = () => work(async () => {
      const choice = await ctx.optionModal('Replace GitHub’s starter files?', 'The starter files in the connected repository will be replaced by this library.', [{ label: 'Replace starter files', desc: 'Use the library on this computer as the backup.', value: 'replace' }]);
      if (choice !== 'replace') { $('#git-conflict').hidden = false; return; }
      await ctx.flushSaves(); status('Replacing starter files…'); note(await api.replaceStarter()); status('Backup complete.');
    });
    $('#sy-git-restore').onclick = () => {
      const url = connected ? $('#git-repository').value : $('#sy-git-remote').value;
      if (close()) recovery(url, onLocal);
    };
    timer = setInterval(last, 30000);
    controls();
    (async () => {
      try {
        const current = await api.status();
        if (!bd.isConnected) return;
        available = !!current.available; connected = !!(current.initialized && current.remote);
        note(current); $('#git-repository').value = current.remote || '';
        status(!available ? 'Git is not installed. Install Git to use this plugin.' : connected ? (lastPushAt ? 'Repository connected.' : 'Repository connected. No successful backup recorded yet.') : 'Not connected yet.');
      } catch (err) { failure(err, 'Could not check the connection.'); }
      finally { busy = false; controls(); }
    })();
  }
  function recovery(remoteUrl, onLocal) {
    let busy = false;
    const { bd, close } = ctx.settingsDialog({
      title: 'Restore from GitHub', scope: 'Entire library · all authors', canClose: () => !busy,
      onClose: () => { active = null; },
      content: `<p>Download a backed-up library and use it on this computer. Any existing library is kept in a separate folder.</p><label>Backup repository address<input id="git-restore-url" value="${escHtml(remoteUrl || '')}" placeholder="https://github.com/you/neo-library.git"/></label><p class="dialog-error" role="status"></p>`,
      actions: '<button class="recovery-back btn-quiet">← GitHub backup</button><button class="restore-confirm btn-gold">Download and use backup…</button>'
    });
    ctx.own(bd); active = { close: () => { busy = false; close(); } };
    bd.querySelector('.recovery-back').onclick = () => { if (close()) configure({ onLocal }); };
    bd.querySelector('.restore-confirm').onclick = async () => {
      const url = bd.querySelector('input').value.trim();
      const status = bd.querySelector('[role="status"]');
      if (!url) { status.textContent = 'Enter a repository address.'; return; }
      busy = true; bd.querySelectorAll('button,input').forEach(el => el.disabled = true);
      try {
        const choice = await ctx.optionModal('Use the backed-up library here?', 'This switches the entire library on this computer. Your current library will be kept beside it.', [{ label: 'Download and use it', desc: 'Keep the current library in a separate folder and open the backup.', value: 'restore' }]);
        if (choice !== 'restore') return;
        await ctx.flushSaves(); status.textContent = 'Downloading…';
        const result = await api.restore(url);
        status.textContent = `Restored ${result.books} books. Opening…`;
        if (result.keptAs) toast(`Your earlier library is kept at ${result.keptAs}`, 8000);
      } catch (err) { status.textContent = ipcErrorText(err, 'Could not restore the backup.').text; }
      finally { busy = false; bd.querySelectorAll('button,input').forEach(el => el.disabled = false); }
    };
  }
  return { configure, dispose() { active?.close(); } };
});
