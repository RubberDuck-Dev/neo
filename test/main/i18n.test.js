"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const createI18n = require('../../main/i18n');

test('interface language resolves regional variants and persists separately from book language', () => {
  let settings = { uiLanguage: 'fr_CA' };
  const handlers = {};
  let notified = null;
  const i18n = createI18n({
    app: { getLocale: () => 'de-DE' },
    ipcMain: { on: (name, fn) => { handlers[name] = fn; }, handle: (name, fn) => { handlers[name] = fn; } },
    readSettings: () => settings,
    writeSettings: value => { settings = value; },
    onChange: code => { notified = code; }
  });
  i18n.init();
  assert.equal(i18n.current(), 'fr-CA');
  const event = {};
  handlers['i18n:get'](event);
  assert.equal(event.returnValue.locale, 'fr-CA');
  assert.equal(typeof event.returnValue.dict.File, 'string');
  i18n.choose('nl-NL');
  assert.equal(settings.uiLanguage, 'nl');
  assert.equal(notified, 'nl');
  assert.equal(i18n.current(), 'nl');
});
