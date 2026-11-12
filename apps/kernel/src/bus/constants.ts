// SPDX-License-Identifier: Apache-2.0
// Names shared by the log writer and the one relay (plan §4.2, ADR-0003).

/** Zero-payload wake-up. LISTEN uses this identifier; NOTIFY sends ''. */
export const OUTBOX_CHANNEL = 'plerni_outbox';

/** Dedicated direct connection, visible in pg_stat_activity. */
export const LISTEN_APPLICATION = 'plerni_relay_listen';

/** Polling is the correctness net. About once a second. */
export const POLL_MS = 1000;

/** One drain pass stops here so a poll returns while a backlog remains. */
export const DRAIN_LIMIT = 256;

export const PARK_UNKNOWN_VERSION = 'UNKNOWN_EVENT_VERSION';

export const HANDLER_FAILED = 'HANDLER_FAILED';

export const NO_LISTENER_ALERT = 'no relay listener';

/** LISTEN setup failed. Polling still runs. */
export const LISTENER_FAILED = 'relay listener failed';

/** Repeated alerts do not grow the relay process without a bound. */
export const ALERT_CAP = 32;
