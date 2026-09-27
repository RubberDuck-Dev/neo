"use strict";
// Run with Electron, not Node: exercises the real utility process and its
// on-disk dictionary paths without opening the user's NEO library or window.
const { app, utilityProcess } = require("electron");
const assert = require("node:assert/strict");
const path = require("path");
const createSpellcheck = require(path.join(process.env.NEO_TEST_APP_ROOT || path.resolve(__dirname, "../.."), "plugins/spellcheck/main.js"));
app.whenReady().then(async () => {
  const handlers = {};
  const errors = [];
  const service = createSpellcheck({ utilityProcess,
    ipcMain: { handle: (key, fn) => handlers[key] = fn },
    preferences: () => ({ spellLanguage: "en-US", customWords: ["Neotestword"] }),
    logError: (_source, error) => errors.push(String(error)), menuChanged() {}
  });
  try {
    const started = performance.now();
    for (const [code, word] of Object.entries({ "en-US": "hello", "en-GB": "colour", "en-CA": "hello", "en-AU": "hello", fr: "bonjour", es: "hola", de: "Haus" })) {
      assert.equal(await handlers["spell:setLanguage"]({}, code), true, code);
      const checked = await handlers["spell:check"]({}, [word, "Neotestword"]);
      assert.equal(checked[word], true, word);
      assert.equal(checked.Neotestword, true, "custom dictionary survives language change");
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ realWorker: "passed", dictionaries: 7, elapsedMs: Math.round(performance.now() - started) }));
    service.stop(); app.exit(0);
  } catch (error) { console.error(error); service.stop(); app.exit(1); }
}).catch((error) => { console.error(error); app.exit(1); });
