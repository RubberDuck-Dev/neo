"use strict";

function openBookSettings() {
  if (!book) return toast('Open a book to change its settings');
  const target = book;
  const { bd, close } = settingsDialog({
    title: 'Book settings', scope: `This book · ${book.title}`,
    content: `<label>Manuscript language<input id="st-language" value="${escHtml(NeoLanguage.manuscriptLanguage(book))}" placeholder="en, fr, de, zh-Hans"/></label><p class="sync-detail">Used in exports. Dictionary and interface language are separate settings.</p><p class="dialog-error" role="status"></p>`,
    actions: '<button class="m-cancel btn-quiet">Cancel</button><button class="m-ok btn-gold">Save</button>'
  });
  bd.querySelector('.m-cancel').onclick = close;
  bd.querySelector('.m-ok').onclick = () => {
    const input = bd.querySelector('#st-language');
    try { target.language = Intl.getCanonicalLocales(input.value.trim() || 'en')[0]; }
    catch { bd.querySelector('[role="status"]').textContent = 'Use a language tag such as en, fr, or zh-Hans.'; input.focus(); return; }
    scheduleMetaSave(); close(); toast('Book settings saved');
  };
}

function openPreferences() {
  let saving = false;
  const { bd, close } = settingsDialog({
    title: 'Preferences', scope: 'Entire library · all authors', canClose: () => !saving,
    content: `<label>My writing day ends at<select id="st-dayends">${[0,1,2,3,4,5,6].map(h => `<option value="${h}"${(library.dayEndsAt || 0) === h ? ' selected' : ''}>${h ? h + ' am' : 'midnight'}</option>`).join('')}</select></label><p class="sync-detail">Writing after midnight can count toward the previous day.</p>
    <section class="stats-section"><h3>New-book starting point</h3><label>Start each new book in<select id="pref-writing-style"><option value="pantser"${library.writingStyle !== 'plotter' ? ' selected' : ''}>The blank page (Pantser)</option><option value="plotter"${library.writingStyle === 'plotter' ? ' selected' : ''}>The outline (Plotter)</option></select></label></section><p class="dialog-error" role="status"></p>`,
    actions: '<button class="m-cancel btn-quiet">Cancel</button><button class="m-ok btn-gold">Save</button>'
  });
  bd.querySelector('.m-cancel').onclick = close;
  bd.querySelector('.m-ok').onclick = async () => {
    saving = true; bd.querySelector('.m-ok').disabled = true;
    const day = Number(bd.querySelector('#st-dayends').value);
    const next = { ...library, dayEndsAt: day, writingStyle: bd.querySelector('#pref-writing-style').value };
    try { await window.neo.writeLibrary(next); library.writingStyle = next.writingStyle; setWritingDayEnd(day); saving = false; close(); if (book) updateCounters(); toast('Preferences saved'); }
    catch (err) { bd.querySelector('[role="status"]').textContent = ipcErrorText(err, 'Could not save preferences').text; }
    finally { saving = false; bd.querySelector('.m-ok').disabled = false; }
  };
}

function openReadAloudSettings() {
  let finish = () => {}, saving = false;
  const { bd, close } = settingsDialog({
    title: 'Read Aloud settings', scope: 'Entire library · all authors', className: 'stats-modal', canClose: () => !saving,
    onClose: () => finish(false),
    content: readAloudSettingsHtml() + '<p class="dialog-error" role="status"></p>',
    actions: '<button class="m-cancel btn-quiet">Cancel</button><button class="m-ok btn-gold">Save</button>'
  });
  finish = bindReadAloudSettings(bd);
  bd.querySelector('.m-cancel').onclick = close;
  bd.querySelector('.m-ok').onclick = async () => {
    const voice = bd.querySelector('#ra-voice'), rate = bd.querySelector('#ra-rate');
    if (!voice) return close();
    saving = true; bd.querySelector('.m-ok').disabled = true;
    const next = { ...library, readAloudVoice: voice.value || '', readAloudRate: Number(rate.value) || 1 };
    try { await window.neo.writeLibrary(next); library.readAloudVoice = next.readAloudVoice; library.readAloudRate = next.readAloudRate; saving = false; close(); toast('Read Aloud settings saved'); }
    catch (err) { bd.querySelector('[role="status"]').textContent = ipcErrorText(err, 'Could not save voice settings').text; }
    finally { saving = false; bd.querySelector('.m-ok').disabled = false; }
  };
}
