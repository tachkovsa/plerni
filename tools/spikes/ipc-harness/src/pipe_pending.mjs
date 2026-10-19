// pipe_pending.mjs — FIONREAD and the buffer capacity of a stdout fd.
// Node's public fs API has no ioctl, so a small N-API helper is compiled for
// this ABI on first use. The binary is published into a 0700 directory this
// user owns (a per-user cache, or a fresh private directory when that cache
// cannot be made private). Ownership and mode are checked again before
// require(). A failed compile, a failed check, or a failed ioctl returns null.
// Callers must not turn that null into a scored bound.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL('./pipe_pending.c', import.meta.url));

let helper = null;
let failed = false;

function headerDir() {
  const version = process.version.startsWith('v') ? process.version.slice(1) : process.version;
  const candidates = [
    join(dirname(dirname(process.execPath)), 'include', 'node'),
    join(homedir(), '.cache', 'node-gyp', version, 'include', 'node'),
    join(homedir(), '.nvm', 'versions', 'node', process.version, 'include', 'node'),
  ];
  for (const dir of candidates) {
    try {
      const st = lstatSync(join(dir, 'node_api.h'));
      if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) continue;
      if (!st.isFile()) continue;
      return dir;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

// `kind` is 'file' or 'dir'. Group and other permission bits must be clear,
// the entry must be owned by `uid`, and a symlink is never accepted.
export function entryIsPrivate(st, uid, kind) {
  if (!st || typeof uid !== 'number') return false;
  if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) return false;
  if (kind === 'file' && !st.isFile()) return false;
  if (kind === 'dir' && !st.isDirectory()) return false;
  if (st.uid !== uid) return false;
  if ((st.mode & 0o077) !== 0) return false;
  return true;
}

function prepareDir(dir) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid == null) return false;
  try {
    const existing = lstatSync(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory() || existing.uid !== uid) return false;
  } catch (err) {
    if (err.code !== 'ENOENT') return false;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
  }
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) return false;
    chmodSync(dir, 0o700);
    return entryIsPrivate(lstatSync(dir), uid, 'dir');
  } catch {
    return false;
  }
}

export function resolveCacheDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid == null) return null;
  const home = homedir();
  if (home) {
    const root = join(home, '.cache', 'plerni-pipe-pending');
    const dir = join(root, String(process.versions.modules));
    if (prepareDir(root) && prepareDir(dir)) return dir;
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), 'plerni-pipe-pending-'));
    chmodSync(dir, 0o700);
    if (entryIsPrivate(lstatSync(dir), uid, 'dir')) return dir;
  } catch {
    return null;
  }
  return null;
}

function publishBinary(dir, headers) {
  const uid = process.getuid();
  const finalName = join(dir, 'pipe_pending.node');
  const tmpName = join(dir, `.pipe_pending.${process.pid}.${randomBytes(8).toString('hex')}.node`);
  try {
    execFileSync('gcc', [
      '-shared',
      '-fPIC',
      `-I${headers}`,
      '-o',
      tmpName,
      source,
    ], { stdio: 'ignore' });
    chmodSync(tmpName, 0o700);
    if (!entryIsPrivate(lstatSync(tmpName), uid, 'file')) {
      rmSync(tmpName, { force: true });
      return null;
    }
    renameSync(tmpName, finalName);
    chmodSync(finalName, 0o700);
    if (!entryIsPrivate(lstatSync(finalName), uid, 'file')) return null;
    return finalName;
  } catch {
    try { rmSync(tmpName, { force: true }); } catch { /* the compiler never created it */ }
    return null;
  }
}

function loadHelper() {
  if (helper) return helper;
  if (failed) return null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const headers = headerDir();
  const dir = uid == null || !headers ? null : resolveCacheDir();
  if (!headers || !dir) {
    failed = true;
    return null;
  }
  const binary = join(dir, 'pipe_pending.node');
  try {
    let target = null;
    try {
      if (entryIsPrivate(lstatSync(binary), uid, 'file')) target = binary;
    } catch {
      target = null;
    }
    if (!target) target = publishBinary(dir, headers);
    if (!target || !entryIsPrivate(lstatSync(target), uid, 'file')) {
      failed = true;
      return null;
    }
    helper = require(target);
    return helper;
  } catch {
    failed = true;
    return null;
  }
}

export function pipePending(fd) {
  if (!Number.isInteger(fd) || fd < 0) return null;
  const fn = loadHelper();
  if (!fn) return null;
  try {
    const row = fn(fd);
    if (!row || !Number.isInteger(row.unread) || !Number.isInteger(row.capacity)) return null;
    if (row.unread < 0 || row.capacity <= 0) return null;
    return { unread: row.unread, capacity: row.capacity };
  } catch {
    return null;
  }
}
