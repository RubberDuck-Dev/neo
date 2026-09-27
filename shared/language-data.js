"use strict";
(function (root) {
  const dictionaries = {
    "en-US": { label: "English (US)", pkg: "dictionary-en-us" },
    "en-GB": { label: "English (UK)", pkg: "dictionary-en-gb" },
    "en-CA": { label: "English (Canada)", pkg: "dictionary-en-ca" },
    "en-AU": { label: "English (Australia)", pkg: "dictionary-en-au" },
    fr: { label: "French", pkg: "dictionary-fr" },
    es: { label: "Spanish", pkg: "dictionary-es" },
    de: { label: "German", pkg: "dictionary-de" }
  };
  const api = { dictionaries, manuscriptLanguage: (book) => book?.language || "en" };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NeoLanguage = api;
})(globalThis);
