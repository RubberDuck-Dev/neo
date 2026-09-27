"use strict";
const path = require("path");
const { dictionaries } = require("../../shared/language-data");

module.exports = function createSpellcheck({ utilityProcess, ipcMain, preferences, logError, menuChanged, timeoutMs = 15000 }) {
  let child = null, seq = 0, generation = 0, loaded = null;
  let queue = Promise.resolve();
  let language = preferences().spellLanguage || "en-US";
  const waiting = new Map();
  function finish(id, result) {
    const pending = waiting.get(id);
    if (!pending) return;
    clearTimeout(pending.timer); waiting.delete(id); pending.resolve(result);
  }
  function stop() {
    generation++; loaded = null;
    const old = child; child = null;
    for (const id of waiting.keys()) finish(id, { ok: false, error: "Spellcheck stopped" });
    old?.kill?.();
  }
  function start() {
    if (child) return;
    const process = utilityProcess.fork(path.join(__dirname, "worker.js"), [], { serviceName: "NEO spellcheck" });
    child = process;
    process.on("message", (message) => { if (child === process) finish(message.id, message); });
    process.on("exit", () => { if (child === process) stop(); });
  }
  function request(message) {
    return new Promise((resolve) => {
      try {
        start();
        const id = ++seq;
        const timer = setTimeout(() => { finish(id, { ok: false, error: "Spellcheck timed out" }); stop(); }, timeoutMs);
        waiting.set(id, { resolve, timer });
        child.postMessage({ ...message, id });
      } catch (error) { stop(); resolve({ ok: false, error: String(error) }); }
    });
  }
  async function load(code) {
    const known = dictionaries[code] ? code : "en-US";
    if (loaded === known) return true;
    const result = await request({ type: "load", dir: path.join(__dirname, "../../node_modules", dictionaries[known].pkg), custom: preferences().customWords || [] });
    if (!result.ok) { logError("spell", new Error(result.error)); return false; }
    loaded = known; language = known;
    return true;
  }
  function serial(work) {
    const token = generation;
    const next = queue.then(() => token === generation ? work() : null);
    queue = next.catch((err) => logError("spell", err));
    return next;
  }
  ipcMain.handle("spell:setLanguage", (_event, code) => serial(async () => {
    if (!dictionaries[code]) return false;
    const ok = await load(code);
    if (ok) menuChanged();
    return ok;
  }));
  ipcMain.handle("spell:check", (_event, words) => serial(async () => {
    if (!Array.isArray(words) || !words.every((word) => typeof word === "string")) return null;
    if (!await load(language)) return null;
    const result = await request({ type: "check", words });
    return result.ok ? result.result : null;
  }));
  ipcMain.handle("spell:suggest", (_event, word) => serial(async () => {
    if (typeof word !== "string" || !await load(language)) return [];
    const result = await request({ type: "suggest", word });
    return result.ok ? result.result : [];
  }));
  ipcMain.handle("spell:learn", (_event, word) => serial(async () => {
    if (typeof word !== "string" || !await load(language)) return false;
    return (await request({ type: "add", word })).ok;
  }));
  ipcMain.handle("spell:stop", () => { stop(); return true; });
  return { get language() { return language; }, reset() { stop(); language = preferences().spellLanguage || "en-US"; }, stop };
};
