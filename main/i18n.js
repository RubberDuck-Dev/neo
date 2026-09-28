"use strict";

const fs = require('fs');
const path = require('path');
const NeoI18n = require('../i18n');

module.exports = function createI18n({ app, ipcMain, readSettings, writeSettings, onChange }) {
  const dir = path.join(__dirname, '..', 'locales');
  const codes = fs.readdirSync(dir).filter(name => /^[a-z]{2}(?:-[A-Za-z]{2})?\.json$/.test(name))
    .map(name => name.slice(0, -5));
  const read = code => {
    if (!codes.includes(code)) return {};
    try { return JSON.parse(fs.readFileSync(path.join(dir, code + '.json'), 'utf8')); }
    catch { return {}; }
  };
  const resolve = requested => {
    const code = String(requested || '').replace(/_/g, '-').toLowerCase();
    return codes.find(item => item.toLowerCase() === code) ||
      codes.find(item => item.toLowerCase() === code.split('-')[0]) || 'en';
  };
  let language = 'en';
  const dictionary = code => {
    const base = code.includes('-') ? read(code.split('-')[0]) : {};
    return { ...base, ...read(code) };
  };
  function set(code) {
    language = resolve(code);
    NeoI18n.setLocale(language, dictionary(language), read('en'));
  }
  set(language);
  ipcMain.on('i18n:get', event => {
    event.returnValue = { locale: language, dict: dictionary(language), base: read('en') };
  });
  ipcMain.handle('i18n:reload', event => { event.sender.reload(); return true; });
  function choose(code) {
    set(code);
    writeSettings({ ...readSettings(), uiLanguage: language });
    onChange(language);
  }
  return {
    t: NeoI18n.t,
    init: () => set(readSettings().uiLanguage || app.getLocale()),
    current: () => language,
    choices: () => codes.map(code => ({ code, name: read(code)._meta?.name || code })),
    choose
  };
};
