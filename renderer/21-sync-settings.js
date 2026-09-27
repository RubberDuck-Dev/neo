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

      <div data-plugin-sync></div>
      <div class="sync-footer">
        <button class="m-cancel">Cancel</button><button class="m-ok btn-gold">Save settings</button>
      </div>
    </div>`;
  document.body.appendChild(bd);

  const extension = NeoPlugins.contribute("syncSettings", bd);
  const close = () => { extension?.dispose(); bd.remove(); };
  bd.querySelectorAll(".m-cancel").forEach((button) => button.onclick = close);
  bd.querySelector(".m-ok").onclick = async () => {
    library.history = {
      ...(library.history || {}),
      enabled: bd.querySelector("#sy-history-enabled").checked,
      intervalMinutes: Number(bd.querySelector("#sy-history-interval").value),
      retentionDays: Number(bd.querySelector("#sy-history-retention").value)
    };
    await window.neo.writeLibrary(library);
    await extension?.save();
    close(); toast("Sync settings saved");
  };
  const versions = bd.querySelector("#sy-history-versions");
  if (versions) versions.onclick = () => openVersionHistory(book.id);
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
}
