// SPDX-License-Identifier: Apache-2.0
// One relay process: a direct LISTEN connection plus a poll (plan §4.2).
// Polling starts even when LISTEN cannot. Wake-ups coalesce into the active
// pass plus one rerun. Two processes are K15. pg-boss is K14.
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { ALERT_CAP, LISTENER_FAILED, POLL_MS } from './constants.ts';
import {
  createFailureGate,
  deliverAvailable,
  RelayDeliveryError,
  type DeliveryHandler,
} from './deliver.ts';
import { listenForOutbox } from './listen.ts';

export function rememberAlert(alerts: string[], message: string): void {
  if (alerts.at(-1) === message) return;
  alerts.push(message);
  if (alerts.length > ALERT_CAP) alerts.splice(0, alerts.length - ALERT_CAP);
}

export function createPassScheduler(run: () => Promise<void>): {
  kick: () => void;
  idle: () => Promise<void>;
  stop: () => void;
} {
  let stopped = false;
  let running = false;
  let pending = false;
  let tail: Promise<void> = Promise.resolve();
  const kick = (): void => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    tail = tail.then(async () => {
      try {
        do {
          pending = false;
          if (stopped) return;
          await run();
        } while (pending && !stopped);
      } finally {
        running = false;
        if (pending && !stopped) {
          pending = false;
          kick();
        }
      }
    });
  };
  return {
    kick,
    idle: () => tail,
    stop: () => {
      stopped = true;
    },
  };
}

export async function startRelay(input: {
  db: Kysely<Database>;
  directConnectionString: string;
  pooledConnectionString: string;
  handler: DeliveryHandler;
  terminateBackend: (pid: number) => Promise<void>;
}): Promise<{ stop: () => Promise<void>; alerts: () => readonly string[] }> {
  const alerts: string[] = [];
  const gate = createFailureGate();
  const scheduler = createPassScheduler(async () => {
    try {
      const report = await deliverAvailable(
        input.db,
        input.handler,
        input.terminateBackend,
        gate,
      );
      for (const alert of report.alerts) rememberAlert(alerts, alert);
    } catch (error) {
      const cause = error instanceof RelayDeliveryError ? error.cause : error;
      if (error instanceof RelayDeliveryError) {
        for (const alert of error.alerts) rememberAlert(alerts, alert);
      }
      const name = cause instanceof Error ? cause.name : 'Error';
      rememberAlert(alerts, `relay failed: ${name}`);
    }
  });
  const timer = setInterval(() => {
    scheduler.kick();
  }, POLL_MS);
  timer.unref();
  let listener: { close: () => Promise<void> } | null = null;
  try {
    listener = await listenForOutbox(
      input.directConnectionString,
      input.pooledConnectionString,
      () => {
        scheduler.kick();
      },
    );
  } catch {
    rememberAlert(alerts, LISTENER_FAILED);
  }
  scheduler.kick();
  return {
    alerts: () => alerts,
    stop: async () => {
      scheduler.stop();
      clearInterval(timer);
      await scheduler.idle();
      if (listener) await listener.close();
    },
  };
}
