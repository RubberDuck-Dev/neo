"use strict";
NeoPlugins.define("github", { name: "GitHub backup", icon: "⌘", kind: "Backup", description: "Back up the entire library to a private GitHub repository.", scope: "library", requires: ["git"], libraryFields: ["history"], configureLabel: "Open Sync Settings",
  disableSettings(settings) { return { history: { ...settings.history, git: { ...settings.history?.git, enabled: false, autoPush: false } } }; }
}, (ctx) => {
const { escHtml, toast } = ctx;
const ipcErrorText = ctx.ipcErrorText, timeAgo = ctx.timeAgo, optionModal = ctx.optionModal;
const api = ctx.git;
const disposers = new Set();
function syncSettings(bd) {
  const git = ctx.librarySettings.history?.git || {};
  const container = bd.querySelector("[data-plugin-sync]");
  container.innerHTML = `      <div class="stats-section sync-github-section">
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

`;
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
      const current = await api.status();
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


  const readForm = () => ({ ...git,
    enabled: bd.querySelector("#sy-git-enabled").checked,
    autoPush: bd.querySelector("#sy-git-enabled").checked,
    remoteUrl: bd.querySelector("#sy-git-remote").value.trim()
  });
  const saveForm = () => ctx.saveLibrarySettings({ history: { ...ctx.librarySettings.history, git: readForm() } });
  const withBusy = async (button, work) => {
    const buttons = bd.querySelectorAll("#sy-git-connect, #sy-git-push, #sy-git-replace, #sy-git-restore");
    buttons.forEach((b) => (b.disabled = true));
    try { await work(); } finally { buttons.forEach((b) => (b.disabled = false)); }
  };
  bd.querySelector("#sy-git-connect").onclick = (e) => withBusy(e.currentTarget, async () => {
    try {
      const remoteUrl = bd.querySelector("#sy-git-remote").value.trim();
      showGitStatus("Connecting…");
      await api.connect(remoteUrl);
      // Connecting is the request for backups: turn automatic backup on
      // rather than leaving it off because the box wasn't ticked first.
      bd.querySelector("#sy-git-enabled").checked = true;
      await saveForm();
      showGitStatus("Uploading…");
      noteStatus(await api.push());
      showGitStatus("Connected. Automatic backups are on.");
    } catch (err) {
      showGitError(err, "Could not connect GitHub.");
    }
  });
  bd.querySelector("#sy-git-push").onclick = (e) => withBusy(e.currentTarget, async () => {
    try {
      await ctx.flushSaves();
      showGitStatus("Uploading…");
      noteStatus(await api.push());
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
      await ctx.flushSaves();
      showGitStatus("Downloading your library…");
      const result = await api.restore(remoteUrl);
      showGitStatus(`Restored ${result.books} book${result.books === 1 ? "" : "s"}. Opening…`);
      if (result.keptAs) toast(`Your earlier library is kept at ${result.keptAs}`, 8000);
    } catch (err) {
      showGitError(err, "Could not restore from GitHub.");
    }
  });
  replaceBtn.onclick = (e) => withBusy(e.currentTarget, async () => {
    try {
      await ctx.flushSaves();
      showGitStatus("Replacing GitHub’s starter files with your library…");
      noteStatus(await api.replaceStarter());
      showGitStatus("Backed up. GitHub now holds your library.");
    } catch (err) {
      showGitError(err, "Could not replace the GitHub copy.");
    }
  });

  const dispose = () => { clearInterval(lastTimer); container.replaceChildren(); disposers.delete(dispose); };
  disposers.add(dispose);
  return { save: saveForm, dispose };
}
return { configure: ctx.openSyncSettings, syncSettings, dispose() { for (const dispose of [...disposers]) dispose(); } };
});
