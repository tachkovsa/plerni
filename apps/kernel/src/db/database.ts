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
  notification_preference: {
    tenant_id: string;
    id: string;
    recipient_id: string;
    channel: string;
    enabled: boolean;
  };
  notification_delivery: {
    tenant_id: string;
    id: string;
    idempotency_key: string;
    recipient_id: string;
    channel: string;
    body: string;
    outcome: string;
    created_at: Date;
  };
}
