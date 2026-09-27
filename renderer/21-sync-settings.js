"use strict";

/* ================================================================== */
/*  SYNC SETTINGS — versions and GitHub backup                        */
/* ================================================================== */

// Electron wraps errors from the main process as
// "Error invoking remote method 'x': Error: <message>". Writers only need the message.
const STARTER_MARK = "[starter-files] ";
function ipcErrorText(err, fallback) {
  const raw = String((err && err.message) || err || "");
  const text = raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(\w*Error):\s*/, "").trim();
  return { text: (text || fallback).replace(STARTER_MARK, ""), starter: text.startsWith(STARTER_MARK) };
}

function timeAgo(iso) {
  const then = Date.parse(iso || "");
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(then).toLocaleString();
}

function openSyncSettings() {
  const settings = historySettings();
  const git = settings.git || {};
  const hasBook = !!book;
  const saveTime = lastSavedAt || (hasBook && book.modified ? new Date(book.modified) : null);
  const saveLabel = saveTime && !Number.isNaN(saveTime.getTime()) ? saveTime.toLocaleString() : "not yet recorded";
  const checkpointLabel = lastCheckpointAt ? lastCheckpointAt.toLocaleString() : "not yet this session";
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal stats-modal sync-settings-modal">
      <div class="stats-modal-head"><h2 style="font-size:17px">Sync settings</h2><button class="m-cancel btn-quiet" title="Close">×</button></div>
      <p class="sync-intro">NEO saves your writing locally as you type. These controls keep recovery copies and, if you choose, a private GitHub backup.</p>

      <div class="stats-section">
        <h3>Local saving</h3>
        <p class="sync-status-line">Autosave is on · latest save <strong>${escHtml(saveLabel)}</strong></p>
        <label class="sync-switch"><input id="sy-history-enabled" type="checkbox" ${settings.enabled !== false ? "checked" : ""}/> <span>Keep automatic versions</span></label>
        <div class="stats-row sync-options-row">
          <label>Make a version every
            <select id="sy-history-interval">
              ${[5, 10, 15, 30, 60].map((minutes) => `<option value="${minutes}"${(Number(settings.intervalMinutes) || 5) === minutes ? " selected" : ""}>${minutes} minutes</option>`).join("")}
            </select>
          </label>
          <label>Keep daily versions for
            <select id="sy-history-retention">
              ${[30, 90, 180, 365].map((days) => `<option value="${days}"${(Number(settings.retentionDays) || 90) === days ? " selected" : ""}>${days} days</option>`).join("")}
            </select>
          </label>
        </div>
        <p class="sync-detail">Latest version: ${escHtml(checkpointLabel)}.${hasBook ? " You can restore an earlier version of this book at any time." : " Open a book to browse its versions."}</p>
        ${hasBook ? '<div class="sync-actions"><button id="sy-history-versions" class="btn-quiet">Browse this book’s versions…</button></div>' : ""}
      </div>

      <div class="stats-section sync-github-section">
        <h3>GitHub backup <span class="soft">(optional)</span></h3>
        <p class="sync-detail">Back up the entire NEO Library—not just this book. Create an empty private repository on GitHub, then paste its HTTPS address below.</p>
        <label class="sync-switch"><input id="sy-git-enabled" type="checkbox" ${git.enabled && git.autoPush !== false ? "checked" : ""}/> <span>Back up automatically after each version</span></label>
        <p class="sync-detail">NEO creates a private local commit and uploads it in the background. You do not need to run Git commands.</p>
        <div class="sync-connect-row">
          <label>GitHub repository address <input id="sy-git-remote" value="${escHtml(git.remoteUrl || "")}" placeholder="https://github.com/you/neo-library.git"/></label>
          <button id="sy-git-connect" class="btn-gold">Connect &amp; back up</button>
        </div>
        <p class="sync-detail">The first backup may ask GitHub to sign you in through your installed Git credentials.</p>
        <div class="sync-actions"><button id="sy-git-push" class="btn-quiet">Back up now</button><button id="sy-git-replace" class="btn-gold" hidden>Replace GitHub copy</button><span id="sy-git-status" class="sync-git-status"></span></div>
        <p id="sy-git-last" class="sync-detail" hidden></p>
        <div class="sync-actions"><button id="sy-git-restore" class="btn-quiet">Set up this computer from a GitHub backup…</button></div>
      </div>

      <div class="sync-footer">
        <button class="m-cancel">Cancel</button><button class="m-ok btn-gold">Save settings</button>
      </div>
    </div>`;
  document.body.appendChild(bd);

  const status = bd.querySelector("#sy-git-status");
  const replaceBtn = bd.querySelector("#sy-git-replace");
  const lastLine = bd.querySelector("#sy-git-last");
  let lastPushAt = null;
  const showLastPush = () => {
    const ago = timeAgo(lastPushAt);
    lastLine.hidden = !ago;
    if (ago) lastLine.textContent = `Last backed up to GitHub ${ago}.`;
  };
  const lastTimer = setInterval(() => {
    if (!bd.isConnected) return clearInterval(lastTimer);
    showLastPush();
  }, 30000);
  const showGitStatus = (message, isError = false) => {
    status.textContent = message;
    status.style.color = isError ? "var(--red, #b44)" : "";
    replaceBtn.hidden = true;
  };
  const showGitError = (err, fallback) => {
    const { text, starter } = ipcErrorText(err, fallback);
    showGitStatus(text, true);
    replaceBtn.hidden = !starter;
  };
  const noteStatus = (current) => {
    if (current && current.lastPushAt) lastPushAt = current.lastPushAt;
    showLastPush();
  };
  const refreshGitStatus = async () => {
    try {
      const current = await window.neo.gitStatus();
      noteStatus(current);
      if (!current.available) return showGitStatus("Git is not installed.", true);
      if (!current.initialized) return showGitStatus(current.parentRepo ? "Not connected yet. (Your library sits inside another Git repository; NEO will make its own.)" : "Not connected yet.");
      const remote = current.remote ? "GitHub connected." : "Local history ready; GitHub not connected.";
      const auto = git.enabled && git.autoPush !== false;
      showGitStatus(`${remote} ${current.remote && !auto ? "Automatic backup is off." : current.clean ? "Up to date." : "New writing will be backed up with the next version."}`);
    } catch (err) {
      showGitError(err, "Could not check Git status.");
    }
  };
  refreshGitStatus();

  bd.querySelectorAll(".m-cancel").forEach((button) => {
    button.onclick = () => bd.remove();
  });
  // Everything the dialog shows, as settings; used by Save and by Connect.
  const readForm = () => {
    const auto = bd.querySelector("#sy-git-enabled").checked;
    return {
      ...(library.history || {}),
      enabled: bd.querySelector("#sy-history-enabled").checked,
      intervalMinutes: Number(bd.querySelector("#sy-history-interval").value),
      retentionDays: Number(bd.querySelector("#sy-history-retention").value),
      git: {
        ...((library.history && library.history.git) || {}),
        enabled: auto,
        autoPush: auto,
        remoteUrl: bd.querySelector("#sy-git-remote").value.trim()
      }
    };
  };
  const saveForm = async () => {
    library.history = readForm();
    await window.neo.writeLibrary(library);
  };
  const withBusy = async (button, work) => {
    const buttons = bd.querySelectorAll("#sy-git-connect, #sy-git-push, #sy-git-replace, #sy-git-restore");
    buttons.forEach((b) => (b.disabled = true));
    try { await work(); } finally { buttons.forEach((b) => (b.disabled = false)); }
  };
  bd.querySelector(".m-ok").onclick = async () => {
    await saveForm();
    bd.remove();
    toast("Sync settings saved");
  };
  bd.querySelector("#sy-git-connect").onclick = (e) => withBusy(e.currentTarget, async () => {
    try {
      const remoteUrl = bd.querySelector("#sy-git-remote").value.trim();
      showGitStatus("Connecting…");
      await window.neo.connectGitRemote(remoteUrl);
      // Connecting is the request for backups: turn automatic backup on
      // rather than leaving it off because the box wasn't ticked first.
      bd.querySelector("#sy-git-enabled").checked = true;
      await saveForm();
      showGitStatus("Uploading…");
      noteStatus(await window.neo.pushGit());
      showGitStatus("Connected. Automatic backups are on.");
    } catch (err) {
      showGitError(err, "Could not connect GitHub.");
    }
  });
  bd.querySelector("#sy-git-push").onclick = (e) => withBusy(e.currentTarget, async () => {
    try {
      flushAllSaves();
      showGitStatus("Uploading…");
      noteStatus(await window.neo.pushGit());
      showGitStatus("Backed up to GitHub.");
    } catch (err) {
      showGitError(err, "Could not back up to GitHub.");
    }
  });
  bd.querySelector("#sy-git-restore").onclick = (e) => withBusy(e.currentTarget, async () => {
    const remoteUrl = bd.querySelector("#sy-git-remote").value.trim();
    if (!remoteUrl) {
      showGitStatus("Paste the backup repository’s address above first.", true);
      bd.querySelector("#sy-git-remote").focus();
      return;
    }
    const choice = await optionModal("Set up this computer from GitHub?", `NEO will download the library backed up at ${escHtml(remoteUrl)} and use it here.`, [
      { label: "Download and use it", desc: "If this computer already has books, they’re kept beside it in a folder named “NEO Library (before restore …)”. Nothing is deleted.", value: "restore" },
    ]);
    if (choice !== "restore") return;
    try {
      flushAllSaves();
      showGitStatus("Downloading your library…");
      const result = await window.neo.restoreFromGit(remoteUrl);
      showGitStatus(`Restored ${result.books} book${result.books === 1 ? "" : "s"}. Opening…`);
      if (result.keptAs) toast(`Your earlier library is kept at ${result.keptAs}`, 8000);
    } catch (err) {
      showGitError(err, "Could not restore from GitHub.");
    }
  });
  replaceBtn.onclick = (e) => withBusy(e.currentTarget, async () => {
    try {
      flushAllSaves();
      showGitStatus("Replacing GitHub’s starter files with your library…");
      noteStatus(await window.neo.replaceGitStarter());
      showGitStatus("Backed up. GitHub now holds your library.");
    } catch (err) {
      showGitError(err, "Could not replace the GitHub copy.");
    }
  });
  const versions = bd.querySelector("#sy-history-versions");
  if (versions) versions.onclick = () => openVersionHistory(book.id);
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      bd.remove();
    }
  });
}
