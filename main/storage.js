"use strict";
const fs = require("fs"), path = require("path");
module.exports = function createStorage({ logError }) {
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWrite(file, data) {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

async function atomicWriteAsync(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(tmp, 'w');
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  try {
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

function writeJSON(file, data) {
  atomicWrite(file, JSON.stringify(data, null, 2));
}

// Calls from a renderer are asynchronous. Serializing every write for a book
// prevents an older debounce from landing after a newer edit, and gives a
// checkpoint a coherent point in the book's on-disk history.
const bookWriteQueues = new Map();
function queueBookWrite(bookId, work) {
  const previous = bookWriteQueues.get(bookId) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  bookWriteQueues.set(bookId, next);
  next.catch((err) => logError('book-save', err));
  return next;
}

async function drainBookWrites() {
  await Promise.allSettled([...bookWriteQueues.values()]);
}

return { readJSON, writeJSON, atomicWrite, atomicWriteAsync, queueBookWrite, drainBookWrites };
};
