"use strict";

/* ================================================================== */
/*  SAVING & RECOVERY — local preferences                        */
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

function openSyncSettings(draft = null) {
  const settings = draft || historySettings();
  const saveTime = lastSavedAt || (book?.modified ? new Date(book.modified) : null);
  const saveLabel = saveTime && !Number.isNaN(saveTime.getTime()) ? saveTime.toLocaleString() : "not yet recorded";
  let saving = false;
  const { bd, close } = settingsDialog({
    title: "Saving & recovery", scope: "Entire library · all authors", className: "sync-settings-modal",
    canClose: () => !saving,
    tabs: NeoPlugins.enabled('github') ? [
      { label: 'Local saving', active: true },
      { label: 'GitHub backup', select: () => {
        const draft = { enabled: bd.querySelector('#sy-history-enabled').checked, intervalMinutes: Number(bd.querySelector('#sy-history-interval').value), retentionDays: Number(bd.querySelector('#sy-history-retention').value) };
        if (close()) NeoPlugins.call('github', 'configure', { onLocal: () => openSyncSettings(draft) });
      } }
    ] : [],
    content: `
      <p>NEO saves your writing on this computer as you type.</p>
      <p class="sync-status-line">Autosave is on · latest save <strong>${escHtml(saveLabel)}</strong></p>
      <section class="stats-section"><h3>Local versions</h3>
        <label class="sync-switch"><input id="sy-history-enabled" type="checkbox" ${settings.enabled !== false ? "checked" : ""}/> <span>Keep automatic versions</span></label>
        <div class="stats-row sync-options-row">
          <label>Make a version every<select id="sy-history-interval">${[5,10,15,30,60].map(n => '<option value="'+n+'"'+((Number(settings.intervalMinutes)||5)===n?' selected':'')+'>'+n+' minutes</option>').join('')}</select></label>
          <label>Keep daily versions for<select id="sy-history-retention">${[30,90,180,365].map(n => '<option value="'+n+'"'+((Number(settings.retentionDays)||90)===n?' selected':'')+'>'+n+' days</option>').join('')}</select></label>
        </div>
        <p class="sync-detail">Local versions let you recover earlier writing. Turning them off does not turn off autosave.</p>
      </section>
      <section class="stats-section"><h3>${book ? 'This book · '+escHtml(book.title) : 'Book recovery'}</h3>
        ${book ? '<button id="sy-history-versions" class="btn-quiet">Browse this book’s versions…</button>' : '<p>Open a book to browse its versions.</p>'}
      </section>
      <p class="dialog-error" role="status"></p>`,
    actions: '<button class="m-cancel btn-quiet">Cancel</button><button class="m-ok btn-gold">Save settings</button>'
  });
  bd.querySelector('.m-cancel').onclick = close;
  const enabled = bd.querySelector('#sy-history-enabled');
  const availability = () => bd.querySelectorAll('select').forEach(el => el.disabled = !enabled.checked);
  enabled.onchange = availability; availability();
  bd.querySelector('#sy-history-versions')?.addEventListener('click', () => { if (close()) openVersionHistory(book.id); });
  bd.querySelector('.m-ok').onclick = async () => {
    saving = true;
    const button = bd.querySelector('.m-ok'); button.disabled = true;
    const next = { ...library.history, enabled: enabled.checked,
      intervalMinutes: Number(bd.querySelector('#sy-history-interval').value),
      retentionDays: Number(bd.querySelector('#sy-history-retention').value) };
    try { await window.neo.writeLibrary({ ...library, history: next }); library.history = next; saving = false; close(); toast('Saving preferences saved'); }
    catch (err) { bd.querySelector('.dialog-error').textContent = ipcErrorText(err, 'Could not save preferences').text; }
    finally { saving = false; button.disabled = false; }
  };
}
