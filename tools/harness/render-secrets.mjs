#!/usr/bin/env node
// render-secrets.mjs — generates pgbouncer/userlist.txt from environment variables.
// The output is gitignored. PgBouncer's auth_file accepts plaintext passwords under
// auth_type = scram-sha-256 (pgbouncer.org: SCRAM secrets or plain-text passwords).
// The edoburu image runs as uid/gid 70. The file stays mode 640, owned by the
// invoker and grouped to that gid, so the container can read the mount and
// other local accounts cannot. Mode 644 would expose the throwaway passwords;
// mode 600 owned by the invoker leaves the user list empty inside the image.
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const IMAGE_GID = 70;

const required = ['PLERNI_APP_PASSWORD', 'PLERNI_MIGRATE_PASSWORD', 'PLERNI_ADMIN_PASSWORD'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`render-secrets: missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const dir = dirname(fileURLToPath(import.meta.url));
const target = join(dir, 'pgbouncer', 'userlist.txt');
const lines = [
  `"plerni_app" "${process.env.PLERNI_APP_PASSWORD}"`,
  `"plerni_migrate" "${process.env.PLERNI_MIGRATE_PASSWORD}"`,
  `"plerni_admin_ro" "${process.env.PLERNI_ADMIN_PASSWORD}"`,
];
writeFileSync(target, lines.join('\n') + '\n', { mode: 0o640 });
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
try {
  chownSync(target, uid, IMAGE_GID);
} catch (err) {
  if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
  execFileSync('sudo', ['chgrp', String(IMAGE_GID), target], { stdio: ['ignore', 'inherit', 'inherit'] });
}
chmodSync(target, 0o640);
console.log(`render-secrets: wrote ${target} (mode 640, group ${IMAGE_GID}, gitignored)`);
