"use strict";
(function (root) {
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
  function countWords(text) {
    const s = String(text || "");
    const cjk = s.match(CJK);
    if (!cjk) return (s.trim().match(/\S+/g) || []).length;
    const rest = s.replace(CJK, " ").replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
    return cjk.length + (rest ? rest.split(" ").length : 0);
  }
  // The same exclusions for spelling and revision; tokenization is feature-specific.
  function proseNodes(el) {
    const nodes = [];
    const walker = el.ownerDocument.createTreeWalker(el, 4);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement?.closest(".scene-break, .ghost, .ph-mark")) nodes.push(node);
    }
    return nodes;
  }
  const api = { countWords, proseNodes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NeoText = api;
})(globalThis);
