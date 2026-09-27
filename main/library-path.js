"use strict";
const fs = require("fs"), path = require("path");

// Keep existing libraries exactly where they are; new Linux installations
// use a shell-friendly name. A configured directory always takes precedence.
module.exports = function defaultLibraryPath(documents, platform = process.platform) {
  const legacy = path.join(documents, "NEO Library");
  if (platform !== "linux" || fs.existsSync(path.join(legacy, "library.json"))) return legacy;
  return path.join(documents, "NEO-Library");
};
