// pipe_pending.mjs — FIONREAD and F_GETPIPE_SZ for a stdout pipe fd.
// The helper is compiled for this Node ABI on first use. A failed compile or
// a failed ioctl returns null. Callers must not substitute a constant.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL('./pipe_pending.c', import.meta.url));
const cacheDir = join(tmpdir(), `plerni-pipe-pending-${process.versions.modules}`);
const binary = join(cacheDir, 'pipe_pending-v2.node');

let helper = null;
let failed = false;

function headerDir() {
  const prefix = dirname(dirname(process.execPath));
  const bundled = join(prefix, 'include', 'node');
  if (existsSync(join(bundled, 'node_api.h'))) return bundled;
  return null;
}

function loadHelper() {
  if (helper) return helper;
  if (failed) return null;
  const headers = headerDir();
  if (!headers) {
    failed = true;
    return null;
  }
  try {
    if (!existsSync(binary)) {
      mkdirSync(cacheDir, { recursive: true });
      execFileSync('gcc', [
        '-shared',
        '-fPIC',
        `-I${headers}`,
        '-o',
        binary,
        source,
      ], { stdio: 'ignore' });
    }
    helper = require(binary);
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
