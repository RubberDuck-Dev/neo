"use strict";

let updateDialog = null;
function showUpdateState(state, info = {}) {
  if (!updateDialog) return;
  const bd = updateDialog;
  const message = bd.querySelector('.up-text');
  const bar = bd.querySelector('.up-bar');
  const fill = bd.querySelector('.up-fill');
  const action = bd.querySelector('.m-ok');
  bar.hidden = true;
  action.hidden = false;
  if (state === 'offer') {
    message.textContent = NeoI18n.t('You have {version}.', { version: info.currentVersion });
    action.textContent = NeoI18n.t('Download');
    action.onclick = () => { showUpdateState('starting'); window.neo.downloadUpdate(); };
  } else if (state === 'starting' || state === 'downloading') {
    bar.hidden = false;
    action.hidden = true;
    const percent = Math.max(0, Math.min(100, info.percent || 0));
    fill.style.width = percent.toFixed(1) + '%';
    message.textContent = info.total
      ? NeoI18n.t('Downloading… {done} of {total} MB', { done: (info.transferred / 1048576).toFixed(0), total: (info.total / 1048576).toFixed(0) })
      : NeoI18n.t('Downloading…');
  } else if (state === 'ready') {
    message.textContent = NeoI18n.t('Downloaded. NEO will save your work and restart.');
    action.textContent = NeoI18n.t('Restart to update');
    action.onclick = async () => {
      flushAllSaves();
      await waitForBookWrites();
      await NeoPlugins.flush();
      await window.neo.installUpdate();
    };
  } else if (state === 'error' || state === 'release') {
    message.textContent = state === 'error'
      ? NeoI18n.t('The update couldn’t be installed from here: {message}', { message: info.message || 'unknown error' })
      : NeoI18n.t('You have {version}.', { version: info.currentVersion });
    action.textContent = NeoI18n.t('View Release');
    action.onclick = () => { window.neo.openRelease(); bd.remove(); updateDialog = null; };
  }
}
async function checkForUpdate() {
  if (updateDialog) { updateDialog.focus(); return; }
  const res = await window.neo.checkForUpdate();
  if (res.error) { toast(NeoI18n.t('Couldn’t check for updates — try again later')); return; }
  if (!res.hasUpdate) { toast(NeoI18n.t('You’re on the latest version ({version})', { version: res.currentVersion })); return; }
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.tabIndex = -1;
  bd.innerHTML = `<div class="modal" style="width:400px">
    <h2 style="font-size:16px">${escHtml(NeoI18n.t('NEO {version} is available', { version: res.latestVersion }))}</h2>
    <p class="up-text"></p><div class="up-bar" hidden><div class="up-fill"></div></div>
    <div style="text-align:right;margin-top:14px"><button class="m-cancel btn-quiet" style="margin-right:10px">${NeoI18n.t('Later')}</button><button class="m-ok btn-gold"></button></div>
    </div>`;
  document.body.appendChild(bd);
  updateDialog = bd;
  const close = () => { bd.remove(); updateDialog = null; };
  bd.querySelector('.m-cancel').onclick = close;
  bd.onclick = e => { if (e.target === bd) close(); };
  bd.onkeydown = e => { if (e.key === 'Escape') close(); };
  showUpdateState(res.canInstall ? (res.ready ? 'ready' : 'offer') : 'release', res);
  bd.focus();
}
function updateMessage(msg) {
  if (msg.state === 'available') {
    if (updateDialog || localStorage.getItem('neo-update-hinted') === msg.version) return;
    localStorage.setItem('neo-update-hinted', msg.version);
    toast(NeoI18n.t('NEO {version} is available — Help → Check for Update… installs it', { version: msg.version }), 7000);
  } else showUpdateState(msg.state, msg);
}

// Help → About NEO: the version, plainly
async function showAbout() {
  const v = await window.neo.appVersion();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal" style="width:340px;text-align:center">
      <h2 style="font-size:22px;letter-spacing:6px">NEO</h2>
      <p style="color:#999">Version ${v}</p>
      <p style="font-size:13px;color:#777">A word processor for authors.</p>
      <div style="margin-top:16px">
        <button class="m-ok btn-gold">Back to writing</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.querySelector(".m-ok").onclick = close;
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  bd.querySelector(".m-ok").focus();
}
