"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os");
const { EventEmitter } = require("events");
const { countWords } = require("../../shared/text");
const { dictionaries, manuscriptLanguage } = require("../../shared/language-data");
const defaultPath = require("../../main/library-path");
const createSpellcheck = require("../../plugins/spellcheck/main");

test("word counting shares punctuation rules for editor and import", () => {
  assert.equal(countWords("夜。"), 1);
  assert.equal(countWords("Hello 夜。"), 2);
  assert.equal(countWords("Hello, world!"), 2);
  assert.equal(countWords(""), 0);
  assert.equal(manuscriptLanguage({ language: "de" }), "de");
  assert.equal(manuscriptLanguage({}), "en");
});

test("new Linux libraries avoid spaces; legacy libraries remain in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-path-"));
  assert.equal(defaultPath(dir, "linux"), path.join(dir, "NEO-Library"));
  fs.mkdirSync(path.join(dir, "NEO Library"));
  fs.writeFileSync(path.join(dir, "NEO Library", "library.json"), '{"shelves":[]}');
  assert.equal(defaultPath(dir, "linux"), path.join(dir, "NEO Library"));
});

test("all bundled dictionaries load and recognize representative words", () => {
  const nspell = require("nspell");
  const examples = { "en-US": "hello", "en-GB": "colour", "en-CA": "hello", "en-AU": "hello", fr: "bonjour", es: "hola", de: "Haus", nl: "huis", pl: "dom" };
  for (const [code, entry] of Object.entries(dictionaries)) {
    const dir = path.join(__dirname, "../../node_modules", entry.pkg);
    const spell = nspell({ aff: fs.readFileSync(path.join(dir, "index.aff")), dic: fs.readFileSync(path.join(dir, "index.dic")) });
    assert.equal(spell.correct(examples[code]), true, code);
  }
});

function service({ respond = true, timeoutMs = 100 } = {}) {
  const handlers = {}, children = [], messages = [];
  const utilityProcess = { fork() {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; };
    child.postMessage = (message) => {
      messages.push(message);
      if (respond) queueMicrotask(() => child.emit("message", { id: message.id, ok: true, result: {} }));
    };
    children.push(child); return child;
  } };
  const api = createSpellcheck({ utilityProcess, ipcMain: { handle: (key, fn) => handlers[key] = fn }, preferences: () => ({ spellLanguage: "en-US" }), logError() {}, menuChanged() {}, timeoutMs });
  return { api, children, messages, call: (key, value) => handlers[key]({}, value) };
}

test("spell worker is lazy, language changes serialize, and stop permits restart", async () => {
  const s = service();
  assert.equal(s.children.length, 0);
  await Promise.all([s.call("spell:setLanguage", "fr"), s.call("spell:setLanguage", "de")]);
  assert.equal(s.api.language, "de");
  assert.equal(s.children.length, 1);
  s.api.stop();
  assert.equal(s.children[0].killed, true);
  await s.call("spell:check", ["Haus"]);
  assert.equal(s.children.length, 2);
  s.api.stop();
});

test("unresponsive spell worker times out instead of leaving promises pending", async () => {
  const s = service({ respond: false, timeoutMs: 20 });
  assert.equal(await s.call("spell:check", ["hello"]), null);
  assert.equal(s.children[0].killed, true);
});
