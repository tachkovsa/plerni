// SPDX-License-Identifier: Apache-2.0
// The frozen error envelope (plan §6, convention R3). `message` is the human
// message the plan names without a JSON key (ADR-0014).
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ERROR_CODES, ERROR_REASONS, type ErrorCode, type ErrorReason } from './codes.ts';

extendZodWithOpenApi(z);

export const errorEnvelopeSchema = z.strictObject({
  code: z.enum(ERROR_CODES),
  message: z.string().min(1),
  next_step: z.string().min(1),
  reason: z.enum(ERROR_REASONS).optional(),
});

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  next_step: string;
  reason?: ErrorReason;
}

export function errorEnvelope(input: {
  code: ErrorCode;
  message: string;
  next_step: string;
  reason?: ErrorReason;
}): ErrorEnvelope {
  const parsed = errorEnvelopeSchema.parse(input);
  const envelope: ErrorEnvelope = {
    code: parsed.code,
    message: parsed.message,
    next_step: parsed.next_step,
  };
  if (parsed.reason !== undefined) envelope.reason = parsed.reason;
  return envelope;
}

export class ContractFailure extends Error {
  readonly code: ErrorCode;
  readonly next_step: string;
  readonly reason?: ErrorReason;

  constructor(input: {
    code: ErrorCode;
    message: string;
    next_step: string;
    reason?: ErrorReason;
  }) {
    const envelope = errorEnvelope(input);
    super(envelope.message);
    this.name = 'ContractFailure';
    this.code = envelope.code;
    this.next_step = envelope.next_step;
    if (envelope.reason !== undefined) this.reason = envelope.reason;
  }
}

/** MCP tool result. The envelope is the structured payload, not a JSON-RPC error. */
export interface McpToolResult {
  isError: true;
  structuredContent: ErrorEnvelope;
  content: [{ type: 'text'; text: string }];
}

export function toMcpToolResult(input: ErrorEnvelope): McpToolResult {
  const envelope = errorEnvelope(input);
  return {
    isError: true,
    structuredContent: envelope,
    content: [{ type: 'text', text: `${envelope.message} ${envelope.next_step}` }],
  };
}
