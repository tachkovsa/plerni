// queued-past-lease (plan B2 / T5c): a QUEUED row whose heartbeat is already
// older than the lease stays QUEUED. An ACTIVE row expired the same way is
// abandoned by the same production sweep, so a no-op sweeper cannot pass.

import { createExecution, dispatch, getStatus, sweepAbandoned } from '../authority.mjs';
import { expireHeartbeat } from './support.mjs';

export async function queuedPastLease() {
  const queuedId = await createExecution('t5c-queued', 'queued-past-lease', true);
  await expireHeartbeat(queuedId);
  const activeId = await createExecution('t5c-queued-active', 'queued-active-control', true);
  await dispatch(activeId, true);
  await expireHeartbeat(activeId);

  const swept = await sweepAbandoned(true);
  const queued = await getStatus(queuedId, true);
  const active = await getStatus(activeId, true);
  const detail = {
    queuedId,
    activeId,
    queuedSwept: swept.includes(queuedId),
    activeSwept: swept.includes(activeId),
    queuedStatus: queued?.status ?? null,
    activeStatus: active?.status ?? null,
  };
  const pass = detail.queuedSwept === false
    && detail.queuedStatus === 'QUEUED'
    && detail.activeSwept === true
    && detail.activeStatus === 'ABANDONED';
  return { pass, detail };
}
