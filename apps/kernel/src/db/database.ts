// SPDX-License-Identifier: Apache-2.0
// Kernel tables only. Plugin schemas stay out of this interface (ADR-0002).

export interface Database {
  scoped_row: {
    tenant_id: string;
    id: string;
    marker: string;
  };
  scoped_link: {
    tenant_id: string;
    id: string;
    row_id: string;
    marker: string;
  };
  tenants: {
    id: string;
    kind: 'operator' | 'customer';
    aggregate_version: string;
    created_at: Date;
  };
  tenant_idempotency: {
    idempotency_key: string;
    tenant_id: string;
    created_at: Date;
  };
  outbox: {
    seq: string;
    tenant_id: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: string;
    type: string;
    version: number;
    payload: unknown;
    created_at: Date;
  };
  audit_record: {
    tenant_id: string;
    id: string;
    action: string;
    target_tenant_id: string;
    created_at: Date;
  };
  plugin_grant: {
    plugin_id: string;
    grant_name: string;
  };
  plugin_migration: {
    plugin_id: string;
    version: string;
    applied_at: Date;
  };
  principal_grant: {
    tenant_id: string;
    id: string;
    principal_id: string;
    plugin_id: string;
    resource: string;
    action: string;
  };
  user_account: {
    tenant_id: string;
    id: string;
    email: string;
    password_hash: string;
    kind: 'admin' | 'member';
    created_at: Date;
  };
  user_auth_state: {
    tenant_id: string;
    id: string;
    revocation_epoch: string;
    disabled_at: Date | null;
  };
  session: {
    tenant_id: string;
    id: string;
    user_id: string;
    token_hash: string;
    session_kind: 'admin' | 'member';
    created_at: Date;
    last_seen_at: Date;
    idle_expires_at: Date;
    absolute_expires_at: Date;
    fresh_until: Date;
    revoked_at: Date | null;
    issued_epoch: string;
  };
  rescue_code: {
    tenant_id: string;
    id: string;
    user_id: string;
    code_hash: string;
    consumed_at: Date | null;
    created_at: Date;
  };
  password_reset: {
    tenant_id: string;
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: Date;
    consumed_at: Date | null;
    created_at: Date;
  };
  login_throttle: {
    tenant_id: string;
    id: string;
    subject_hash: string;
    failures: number;
    window_started_at: Date;
  };
  auth_audit: {
    tenant_id: string;
    id: string;
    action: string;
    actor_user_id: string | null;
    target_user_id: string | null;
    session_hash: string | null;
    epoch_before: string | null;
    epoch_after: string | null;
    reason: string;
    decision_basis: 'local';
    created_at: Date;
  };
  tenant_auth_policy: {
    tenant_id: string;
    id: string;
    strict_disable: boolean;
    created_at: Date;
  };
  bootstrap_state: {
    id: boolean;
    consumed_at: Date | null;
  };
}
