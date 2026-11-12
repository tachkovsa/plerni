// SPDX-License-Identifier: Apache-2.0
// The kernel envelope on every job (plan §4.6, ADR-0003 decision 5).
import { assertPayload, assertPayloadVersion, assertUuid } from './validate.ts';
import { JOB_EXPIRE_SECONDS, JOB_HEARTBEAT_SECONDS } from './job-constants.ts';

const TOKEN = /^[A-Za-z0-9._:-]{1,200}$/;
const NAME = /^[a-z][a-z0-9._:-]{0,63}$/;
const DEADLINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface JobEnvelope {
  tenantId: string;
  plugin: string;
  handler: string;
  payloadVersion: number;
  idempotencyKey: string;
  deadline: string;
  attemptBudget: number;
  trace: string;
  serviceIdentity: string;
  expireInSeconds: number;
  heartbeatSeconds: number;
  payload: Record<string, unknown>;
}

export interface JobRequest {
  plugin: string;
  handler: string;
  payloadVersion: number;
  idempotencyKey: string;
  deadline: string;
  attemptBudget: number;
  trace: string;
  serviceIdentity: string;
  payload: Record<string, unknown>;
  expireInSeconds?: number;
  heartbeatSeconds?: number;
}

function assertToken(value: string, label: string): void {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${label} rejected`);
}

function assertName(value: string, label: string): void {
  if (typeof value !== 'string' || !NAME.test(value)) throw new Error(`${label} rejected`);
}

function assertSeconds(value: number, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} rejected`);
}

export function jobEnvelope(tenantId: string, request: JobRequest): JobEnvelope {
  assertUuid(tenantId, 'tenant id');
  assertName(request.plugin, 'plugin');
  assertName(request.handler, 'handler');
  assertPayloadVersion(request.payloadVersion);
  assertToken(request.idempotencyKey, 'idempotency key');
  if (typeof request.deadline !== 'string' || !DEADLINE.test(request.deadline)) {
    throw new Error('deadline rejected');
  }
  if (Number.isNaN(Date.parse(request.deadline))) throw new Error('deadline rejected');
  assertSeconds(request.attemptBudget, 'attempt budget', 1, 20);
  assertToken(request.trace, 'trace');
  assertName(request.serviceIdentity, 'service identity');
  assertPayload(request.payload);
  const expireInSeconds = request.expireInSeconds ?? JOB_EXPIRE_SECONDS;
  const heartbeatSeconds = request.heartbeatSeconds ?? JOB_HEARTBEAT_SECONDS;
  assertSeconds(expireInSeconds, 'lease', 1, 24 * 60 * 60);
  assertSeconds(heartbeatSeconds, 'heartbeat', 10, 3600);
  return {
    tenantId,
    plugin: request.plugin,
    handler: request.handler,
    payloadVersion: request.payloadVersion,
    idempotencyKey: request.idempotencyKey,
    deadline: request.deadline,
    attemptBudget: request.attemptBudget,
    trace: request.trace,
    serviceIdentity: request.serviceIdentity,
    expireInSeconds,
    heartbeatSeconds,
    payload: request.payload,
  };
}

export function envelopeRecord(envelope: JobEnvelope): Record<string, unknown> {
  return {
    tenantId: envelope.tenantId,
    plugin: envelope.plugin,
    handler: envelope.handler,
    payloadVersion: envelope.payloadVersion,
    idempotencyKey: envelope.idempotencyKey,
    deadline: envelope.deadline,
    attemptBudget: envelope.attemptBudget,
    trace: envelope.trace,
    serviceIdentity: envelope.serviceIdentity,
    expireInSeconds: envelope.expireInSeconds,
    heartbeatSeconds: envelope.heartbeatSeconds,
    payload: envelope.payload,
  };
}

export function readEnvelope(value: unknown, tenantId: string): JobEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('job envelope rejected');
  }
  const row = value as Record<string, unknown>;
  const payload = row.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('job envelope rejected');
  }
  return jobEnvelope(tenantId, {
    plugin: String(row.plugin ?? ''),
    handler: String(row.handler ?? ''),
    payloadVersion: Number(row.payloadVersion),
    idempotencyKey: String(row.idempotencyKey ?? ''),
    deadline: String(row.deadline ?? ''),
    attemptBudget: Number(row.attemptBudget),
    trace: String(row.trace ?? ''),
    serviceIdentity: String(row.serviceIdentity ?? ''),
    payload: payload as Record<string, unknown>,
    expireInSeconds: Number(row.expireInSeconds),
    heartbeatSeconds: Number(row.heartbeatSeconds),
  });
}
