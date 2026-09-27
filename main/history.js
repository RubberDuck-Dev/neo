"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
module.exports = function createHistory({ bookDir, getLibraryFile, readJSON, atomicWriteAsync, writeCatalog }) {
const HISTORY_DIR = '.neo-history';
function historyDir(bookId) {
  return path.join(bookDir(bookId), HISTORY_DIR);
}

async function copyCheckpointTree(source, destination, relative = '', files = []) {
  for (const name of await fs.promises.readdir(source)) {
    if (name === HISTORY_DIR || name.endsWith('.tmp')) continue;
    const from = path.join(source, name);
    const rel = relative ? path.join(relative, name) : name;
    const to = path.join(destination, rel);
    const stat = await fs.promises.stat(from);
    if (stat.isDirectory()) {
      await fs.promises.mkdir(to, { recursive: true });
      await copyCheckpointTree(from, destination, rel, files);
      continue;
    }
    const content = await fs.promises.readFile(from);
    await atomicWriteAsync(to, content);
    files.push({ path: rel.replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  return files;
}

async function pruneCheckpoints(dir) {
  const now = Date.now();
  const seenQuarters = new Set();
  const seenHours = new Set();
  const seenDays = new Set();
  const retentionDays = Math.max(1, Number(readJSON(getLibraryFile(), {}).history?.retentionDays) || 90);
  const snapshots = (await fs.promises.readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      const manifest = readJSON(path.join(full, 'manifest.json'), null);
      return { full, created: Date.parse(manifest && manifest.createdAt) || fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.created - a.created);
  for (const [index, snapshot] of snapshots.entries()) {
    const age = now - snapshot.created;
    const stamp = new Date(snapshot.created);
    const quarter = Math.floor(snapshot.created / (15 * 60 * 1000));
    const hour = stamp.toISOString().slice(0, 13);
    const day = stamp.toISOString().slice(0, 10);
    const keep = index < 20 ||
      (age <= 24 * 60 * 60 * 1000 && !seenQuarters.has(quarter)) ||
      (age <= 30 * 24 * 60 * 60 * 1000 && !seenHours.has(hour)) ||
      (age <= retentionDays * 24 * 60 * 60 * 1000 && !seenDays.has(day));
    seenQuarters.add(quarter);
    seenHours.add(hour);
    seenDays.add(day);
    if (!keep) await fs.promises.rm(snapshot.full, { recursive: true, force: true });
  }
}

async function createCheckpoint(bookId, reason = 'writing') {
  const source = bookDir(bookId);
  if (!fs.existsSync(source)) return null;
  const dir = historyDir(bookId);
  await fs.promises.mkdir(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const safeReason = String(reason).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'writing';
  const name = `${createdAt.replace(/[:.]/g, '-')}-${safeReason}-${Math.random().toString(36).slice(2, 7)}`;
  const pending = path.join(dir, `.${name}.pending`);
  const target = path.join(dir, name);
  await fs.promises.mkdir(pending, { recursive: true });
  try {
    const files = await copyCheckpointTree(source, pending);
    await atomicWriteAsync(path.join(pending, 'manifest.json'), JSON.stringify({ version: 1, createdAt, reason: safeReason, files }, null, 2));
    await fs.promises.rename(pending, target);
    await pruneCheckpoints(dir);
    return { id: name, createdAt };
  } catch (err) {
    await fs.promises.rm(pending, { recursive: true, force: true });
    throw err;
  }
}

function checkpointPath(bookId, checkpointId) {
  if (!/^[a-z0-9-]+$/i.test(checkpointId)) throw new Error('Invalid checkpoint id');
  return path.join(historyDir(bookId), checkpointId);
}

async function verifyCheckpoint(bookId, checkpointId) {
  const dir = checkpointPath(bookId, checkpointId);
  const manifest = readJSON(path.join(dir, 'manifest.json'), null);
  if (!manifest || !Array.isArray(manifest.files)) return { valid: false, manifest: null };
  try {
    for (const file of manifest.files) {
      const rel = String(file.path || '');
      if (!rel || rel.includes('..') || path.isAbsolute(rel)) throw new Error('Unsafe checkpoint path');
      const content = await fs.promises.readFile(path.join(dir, rel));
      if (crypto.createHash('sha256').update(content).digest('hex') !== file.sha256) throw new Error(`Checksum mismatch: ${rel}`);
    }
    return { valid: true, manifest };
  } catch (err) {
    return { valid: false, manifest, error: String(err.message || err) };
  }
}

async function listCheckpoints(bookId) {
  const dir = historyDir(bookId);
  if (!fs.existsSync(dir)) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const list = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const checked = await verifyCheckpoint(bookId, entry.name);
    list.push({ id: entry.name, valid: checked.valid, error: checked.error || null, ...(checked.manifest || {}) });
  }
  return list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function restoreCheckpoint(bookId, checkpointId) {
  const checked = await verifyCheckpoint(bookId, checkpointId);
  if (!checked.valid) throw new Error(`Checkpoint cannot be restored: ${checked.error || 'invalid manifest'}`);
  await createCheckpoint(bookId, 'before-restore');
  const target = bookDir(bookId);
  for (const name of await fs.promises.readdir(target)) {
    if (name !== HISTORY_DIR) await fs.promises.rm(path.join(target, name), { recursive: true, force: true });
  }
  for (const file of checked.manifest.files) {
    const destination = path.join(target, file.path);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await atomicWriteAsync(destination, await fs.promises.readFile(path.join(checkpointPath(bookId, checkpointId), file.path)));
  }
  writeCatalog();
  return { restored: checkpointId };
}

return { createCheckpoint, listCheckpoints, restoreCheckpoint, verifyCheckpoint, checkpointPath, HISTORY_DIR };
};
