// SPDX-License-Identifier: Apache-2.0
// Job pin and the cold lease (plan §4.6, ADR-0003 decision 5).
// pg-boss 12.38.2. LISTEN stays off. The sweeper below is ours: the library
// monitor reclaims on lease expiry alone, and this task does not.

/** Library schema. Created by the migrate role on a direct connection. */
export const JOB_SCHEMA = 'pgboss';

/** One queue. Jobs are unordered. */
export const JOB_QUEUE = 'kernel.job';

export const JOB_EVENT_TYPE = 'kernel.job.requested';

export const JOB_AGGREGATE = 'kernel.job';

/** Cold default until a measured p99 exists (plan §4.6). Seconds. */
export const JOB_EXPIRE_SECONDS = 60;

/**
 * Missed-heartbeat window. The library rejects a value under 10.
 * Shorter than the cold lease, so a live heartbeat still covers the lease.
 */
export const JOB_HEARTBEAT_SECONDS = 20;

/** Pooled claim, send, and complete. */
export const POOLED_APPLICATION = 'plerni_job_pool';

/** Reserved direct connection. Never the pooler. */
export const HEARTBEAT_APPLICATION = 'plerni_job_heartbeat';

export const SERVICE_IDENTITY = 'job-runner';
