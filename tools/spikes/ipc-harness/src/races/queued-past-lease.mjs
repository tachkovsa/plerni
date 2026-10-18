// queued-past-lease (plan B2 / T5c): a QUEUED row whose heartbeat is already
// older than the lease stays QUEUED. An ACTIVE row expired the same way is
// abandoned by the same production sweep, so a no-op sweeper cannot pass.

import { createExecution, dispatch, getStatus, sweepAbandoned } from '../authority.mjs';
import { assertBounds, steps } from './clock.mjs';
import { expireHeartbeat } from './support.mjs';

export async function queuedPastLease() {
  const timing = steps();
  const queuedId = await timing.run(
    () => createExecution('t5c-queued', 'queued-past-lease', true),
    'create queued',
  );
  await timing.run(() => expireHeartbeat(queuedId), 'expire queued');
  const activeId = await timing.run(
    () => createExecution('t5c-queued-active', 'queued-active-control', true),
    'create active',
  );
  await timing.run(() => dispatch(activeId, true), 'dispatch active');
  await timing.run(() => expireHeartbeat(activeId), 'expire active');

  const swept = await timing.run(() => sweepAbandoned(true), 'production sweep');
  const queued = await timing.run(() => getStatus(queuedId, true), 'queued status');
  const active = await timing.run(() => getStatus(activeId, true), 'active status');
  const detail = {
    queuedId,
    activeId,
    queuedSwept: swept.includes(queuedId),
    activeSwept: swept.includes(activeId),
    queuedStatus: queued?.status ?? null,
    activeStatus: active?.status ?? null,
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  const pass = detail.queuedSwept === false
    && detail.queuedStatus === 'QUEUED'
    && detail.activeSwept === true
    && detail.activeStatus === 'ABANDONED';
  return { pass, detail };
}
