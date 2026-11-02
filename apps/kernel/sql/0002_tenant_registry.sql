-- SPDX-License-Identifier: Apache-2.0
-- Tenant registry, create-tenant idempotency, and the append-only log.
-- kernel.tenants is kernel-internal (ADR-0010): no row security and no tenant
-- policy. Plugin roles and PUBLIC receive no grant. The operator count is
-- held at one by a partial unique index.
-- kernel.outbox is the log from ADR-0003 and plan §4.1. seq is allocated with
-- nextval inside the business transaction. This file takes no advisory lock
-- and does not start a relay.

CREATE TABLE IF NOT EXISTS kernel.tenants (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  aggregate_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tenants_kind CHECK (kind IN ('operator', 'customer')),
  CONSTRAINT tenants_aggregate_version_nonnegative CHECK (aggregate_version >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_operator
  ON kernel.tenants (kind)
  WHERE kind = 'operator';

REVOKE ALL ON TABLE kernel.tenants FROM PUBLIC;
-- UPDATE is required for FOR UPDATE on the aggregate row and for the
-- version increment. DELETE is not granted: the app role cannot remove a tenant.
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.tenants TO plerni_app;

-- One idempotency key resolves to one customer tenant. A repeat call returns
-- that row and does not append another log record.
CREATE TABLE IF NOT EXISTS kernel.tenant_idempotency (
  idempotency_key text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tenant_idempotency_key_shape CHECK (
    idempotency_key ~ '^[A-Za-z0-9._:-]{1,200}$'
  )
);

REVOKE ALL ON TABLE kernel.tenant_idempotency FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE kernel.tenant_idempotency TO plerni_app;

CREATE SEQUENCE IF NOT EXISTS kernel.outbox_seq AS bigint;

CREATE TABLE IF NOT EXISTS kernel.outbox (
  seq bigint PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL,
  type text NOT NULL,
  version integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT outbox_seq_positive CHECK (seq > 0),
  CONSTRAINT outbox_aggregate_version_positive CHECK (aggregate_version > 0),
  CONSTRAINT outbox_payload_version_positive CHECK (version > 0),
  CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

REVOKE ALL ON SEQUENCE kernel.outbox_seq FROM PUBLIC;
GRANT USAGE, SELECT ON SEQUENCE kernel.outbox_seq TO plerni_app;
REVOKE ALL ON TABLE kernel.outbox FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE kernel.outbox TO plerni_app;

-- Actor-scoped audit row committed with the registry write. The per-tenant
-- commitment chain is not this table. The session tenant is the actor.
CREATE TABLE IF NOT EXISTS kernel.audit_record (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  id uuid NOT NULL,
  action text NOT NULL,
  target_tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE kernel.audit_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.audit_record FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kernel.audit_record;
CREATE POLICY tenant_isolation ON kernel.audit_record
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE kernel.audit_record FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE kernel.audit_record TO plerni_app;
