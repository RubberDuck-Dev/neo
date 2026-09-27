"use strict";
// A small ASAR fixture tests packaging paths without building an installer.
const fs = require("fs"), os = require("os"), path = require("path");
const { spawnSync } = require("child_process");
const { createPackage } = require("@electron/asar");
const { dictionaries } = require("../../shared/language-data");
const root = path.resolve(__dirname, "../..");
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "neo-spell-package-"));
  const source = path.join(temp, "app");
  for (const dir of ["plugins/spellcheck", "shared", "node_modules/nspell", "node_modules/is-buffer", ...Object.values(dictionaries).map((d) => "node_modules/" + d.pkg)]) {
    fs.cpSync(path.join(root, dir), path.join(source, dir), { recursive: true });
  }
  const archive = path.join(temp, "app.asar");
  await createPackage(source, archive);
  const result = spawnSync(require("electron"), [path.join(__dirname, "spell-worker.cjs")], {
    env: { ...process.env, NEO_TEST_APP_ROOT: archive }, windowsHide: true, encoding: "utf8", timeout: 90000
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
