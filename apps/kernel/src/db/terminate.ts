// SPDX-License-Identifier: Apache-2.0
import pg from 'pg';

const TERMINATE_DEADLINE_MS = 2000;

/**
 * Privileged terminator. The app role cannot kill its own backend after a
 * leaked SET ROLE, so this runs on a separate connection. The caller supplies
 * that connection string. It is never logged.
 */
export function terminateBackendByPid(rootDsn: string): (pid: number) => Promise<void> {
  return async (pid: number) => {
    const client = new pg.Client({ connectionString: rootDsn });
    client.on('error', () => undefined);
    await client.connect();
    try {
      await client.query('SELECT pg_terminate_backend($1)', [pid]);
      const deadline = performance.now() + TERMINATE_DEADLINE_MS;
      for (;;) {
        const alive = await client.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
        if (alive.rows.length === 0) return;
        if (performance.now() >= deadline) {
          throw new Error(`backend ${pid} still present after terminate`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await client.end();
    }
  };
}
