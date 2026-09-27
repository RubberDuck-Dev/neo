"use strict";
const NeoI18n = {
  t(key, locale = library?.uiLanguage || "en") { return NeoLocales[locale]?.[key] ?? NeoLocales.en[key] ?? key; }
};
