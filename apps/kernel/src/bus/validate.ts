// SPDX-License-Identifier: Apache-2.0
// Bounded shapes for log rows and subscription filters (plan §4.1, §4.5).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGGREGATE_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$/;
const SEQ = /^[0-9]+$/;
const IDENT = /^[a-z][a-z0-9_]{0,40}$/;

export interface TypeFilter {
  type: string;
  versions: readonly number[];
}

export function assertUuid(value: string, label: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} rejected`);
}

export function assertAggregateType(value: string): void {
  if (typeof value !== 'string' || value.length > 200 || !AGGREGATE_TYPE.test(value)) {
    throw new Error('aggregate type rejected');
  }
}

export function assertEventType(value: string): void {
  if (typeof value !== 'string' || !EVENT_TYPE.test(value)) throw new Error('event type rejected');
}

export function assertPayloadVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error('payload version rejected');
}

export function assertPayload(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('payload rejected');
  }
}

export function assertSeq(value: string): void {
  if (!SEQ.test(value)) throw new Error('seq rejected');
}

export function assertIdentifier(value: string, label: string): void {
  if (!IDENT.test(value)) throw new Error(`${label} rejected`);
}

export function assertFilter(filter: readonly TypeFilter[]): void {
  if (filter.length > 32) throw new Error('subscription filter rejected');
  const seen = new Set<string>();
  for (const entry of filter) {
    assertEventType(entry.type);
    if (seen.has(entry.type)) throw new Error('subscription filter rejected');
    seen.add(entry.type);
    if (entry.versions.length < 1 || entry.versions.length > 16) {
      throw new Error('subscription filter rejected');
    }
    for (const version of entry.versions) assertPayloadVersion(version);
  }
}

export function parseFilter(value: unknown): TypeFilter[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error('subscription filter is not an array');
  const filter: TypeFilter[] = parsed.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('subscription filter entry rejected');
    }
    const type = 'type' in entry && typeof entry.type === 'string' ? entry.type : '';
    const versions = 'versions' in entry && Array.isArray(entry.versions)
      ? entry.versions
      : [];
    const numbers = versions.map((item: unknown) => {
      if (typeof item !== 'number' || !Number.isInteger(item)) {
        throw new Error('subscription filter version rejected');
      }
      return item;
    });
    return { type, versions: numbers };
  });
  assertFilter(filter);
  return filter;
}

export function decide(
  filter: readonly TypeFilter[],
  type: string,
  version: number,
): 'deliver' | 'skip' | 'park' {
  const match = filter.find((entry) => entry.type === type);
  if (!match) return 'skip';
  if (!match.versions.includes(version)) return 'park';
  return 'deliver';
}
