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
  subscription: {
    id: string;
    last_seq: string;
    status: string;
    park_reason: string | null;
    fence: string;
    filter: unknown;
    created_at: Date;
    exported_at: Date | null;
    released_at: Date | null;
  };
  package: {
    id: string;
    version: string;
    digest: string;
    status: string;
    subscription_id: string;
    requires: unknown;
    optional_requires: unknown;
    exported_at: Date | null;
    installed_at: Date;
  };
  package_enablement: {
    package_id: string;
    tenant_id: string;
    enabled: boolean;
    watermark_seq: string;
    held_since: Date;
    released_at: Date | null;
  };
  quota_warning: {
    id: string;
    package_id: string | null;
    tenant_id: string | null;
    subscription_id: string | null;
    reason: string;
    warned_at: Date;
  };
  delivery: {
    subscription_id: string;
    seq: string;
    idempotency_key: string;
    created_at: Date;
  };
  dead_letter: {
    subscription_id: string;
    seq: string;
    reason: string;
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
}
