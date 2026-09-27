"use strict";

async function checkForUpdate() {
  const res = await window.neo.checkForUpdate();
  if (res.error) {
    toast("Couldn't check for updates — try again later");
    return;
  }
  if (!res.hasUpdate) {
    toast(`You're on the latest version (${res.currentVersion})`);
    return;
  }
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal" style="width:380px">
      <h2 style="font-size:16px">NEO ${res.latestVersion} is available</h2>
      <p>You have ${res.currentVersion}.</p>
      <div style="text-align:right;margin-top:14px">
        <button class="m-cancel btn-quiet" style="margin-right:10px">Later</button>
        <button class="m-ok btn-gold">View Release</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.querySelector(".m-cancel").onclick = close;
  bd.querySelector(".m-ok").onclick = () => {
    window.neo.openRelease();
    close();
  };
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
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
