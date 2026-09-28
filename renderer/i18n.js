"use strict";
// The UI language is a machine preference, separate from a book's language.
const localeSettings = window.neo.i18n || {};
NeoI18n.setLocale(localeSettings.locale || 'en', localeSettings.dict || {}, localeSettings.base || {});
document.documentElement.lang = NeoI18n.getLocale();

function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll('button, .tab, [title], [placeholder], h1, h2, h3, label, p, span')) {
    if (el.closest('[contenteditable="true"], .chapter-body')) continue;
    for (const attr of ['title', 'placeholder']) {
      const raw = el.getAttribute(attr);
      if (raw) el.setAttribute(attr, NeoI18n.t(raw));
    }
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const raw = node.textContent;
      const trimmed = raw.trim();
      node.textContent = raw.replace(trimmed, NeoI18n.t(trimmed));
    }
  }
}
applyStaticI18n();
new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE && node.matches('.modal-backdrop')) applyStaticI18n(node);
    }
  }
}).observe(document.body, { childList: true });
