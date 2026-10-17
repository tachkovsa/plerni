#!/usr/bin/env node
// render-secrets.mjs — generates pgbouncer/userlist.txt from environment variables.
// The output is gitignored. PgBouncer's auth_file accepts plaintext passwords under
// auth_type = scram-sha-256 (pgbouncer.org: SCRAM secrets or plain-text passwords).
// The file is mode 644: the image runs as uid 70 and the compose mount hides
// the image's own /etc/pgbouncer. A mode-600 file owned by the invoker is
// unreadable there, the user list stays empty, and the healthcheck fails SASL.
import { writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
writeFileSync(target, lines.join('\n') + '\n', { mode: 0o644 });
chmodSync(target, 0o644);
console.log(`render-secrets: wrote ${target} (mode 644, gitignored)`);
