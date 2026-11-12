// SPDX-License-Identifier: Apache-2.0
import { ContractFailure, NOTIFICATION_BODY_MAX, isUuid } from '@plerni/contracts';

export const NOTIFY_SEND = 'notify.send';

function invalid(message: string, nextStep: string): ContractFailure {
  return new ContractFailure({ code: 'VALIDATION', message, next_step: nextStep });
}

export function assertTenantActor(tenantId: string, actorId: string): void {
  if (!isUuid(tenantId)) {
    throw invalid('The tenant id was rejected.', 'Retry with a session tenant id that is a UUID.');
  }
  if (!isUuid(actorId)) {
    throw invalid('The actor id was rejected.', 'Retry with a session actor id that is a UUID.');
  }
}

export function assertSendGrant(grants: readonly string[]): void {
  if (!Array.isArray(grants) || grants.some((grant) => typeof grant !== 'string') || !grants.includes(NOTIFY_SEND)) {
    throw new ContractFailure({
      code: 'FORBIDDEN',
      message: 'The caller does not hold notify.send.',
      next_step: 'Ask the operator to approve the notify.send grant for this plugin.',
    });
  }
}

export function preferenceMissing(): ContractFailure {
  return new ContractFailure({
    code: 'NOT_FOUND',
    message: 'No notification preference is recorded for this recipient.',
    next_step: 'Record the recipient preference for the in_app channel, then send again.',
  });
}

export function deliveryConflict(): ContractFailure {
  return new ContractFailure({
    code: 'CONCURRENCY_CONFLICT',
    message: 'The idempotency key is already bound to a different notification.',
    next_step: 'Retry the original send, or choose a new idempotency key.',
  });
}

export function rejectedPreference(): ContractFailure {
  return invalid(
    'The notification preference was rejected.',
    'Send channel in_app and an enabled flag of true or false.',
  );
}

export function rejectedSend(): ContractFailure {
  return invalid(
    'The notification was rejected.',
    `Send channel in_app, a recipient id, an idempotency key, and a non-empty body of at most ${NOTIFICATION_BODY_MAX} characters.`,
  );
}
