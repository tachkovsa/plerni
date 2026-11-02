// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { PINNED_SEARCH_PATH } from '../src/tenancy/constants.ts';
import { findContamination, type SessionState } from '../src/tenancy/hygiene.ts';

const clean: SessionState = {
  tenant_guc: null,
  current_user: 'plerni_app',
  session_user: 'plerni_app',
  search_path: PINNED_SEARCH_PATH,
  pid: 1,
};

test('an empty tenant GUC is absent, not contamination', () => {
  assert.deepEqual(findContamination(clean), []);
  assert.deepEqual(findContamination({ ...clean, tenant_guc: '' }), []);
});

test('a leaked GUC, role, or search_path is contamination', () => {
  const reasons = findContamination({
    tenant_guc: '11111111-1111-1111-1111-111111111111',
    current_user: 'plerni_plugin_a',
    session_user: 'plerni_app',
    search_path: 'pg_catalog',
    pid: 4,
  });
  assert.equal(reasons.length, 3);
  assert.ok(reasons.some((reason) => reason.includes('plerni.tenant_id')));
  assert.ok(reasons.some((reason) => reason.includes('role leaked') && reason.includes('plerni_plugin_a')));
  assert.ok(reasons.some((reason) => reason.includes('search_path') && reason.includes('pg_catalog')));
});
