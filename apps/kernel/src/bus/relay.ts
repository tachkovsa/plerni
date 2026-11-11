// SPDX-License-Identifier: Apache-2.0
// One relay process: a direct LISTEN connection plus a poll (plan §4.2).
// Two processes are K15. pg-boss is K14. This module starts neither.
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { POLL_MS } from './constants.ts';
import { deliverAvailable, type DeliveryHandler } from './deliver.ts';
import { listenForOutbox } from './listen.ts';

export async function startRelay(input: {
  db: Kysely<Database>;
  directConnectionString: string;
  pooledConnectionString: string;
  handler: DeliveryHandler;
  terminateBackend: (pid: number) => Promise<void>;
}): Promise<{ stop: () => Promise<void>; alerts: () => readonly string[] }> {
  const alerts: string[] = [];
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  const pump = (): Promise<void> => {
    const run = chain.then(async () => {
      if (stopped) return;
      try {
        const report = await deliverAvailable(input.db, input.handler, input.terminateBackend);
        alerts.push(...report.alerts);
      } catch (error) {
        const name = error instanceof Error ? error.name : 'Error';
        alerts.push(`relay failed: ${name}`);
      }
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const listener = await listenForOutbox(
    input.directConnectionString,
    input.pooledConnectionString,
    () => {
      void pump();
    },
  );
  const timer = setInterval(() => {
    void pump();
  }, POLL_MS);
  timer.unref();
  await pump();
  return {
    alerts: () => alerts,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await chain;
      await listener.close();
    },
  };
}
