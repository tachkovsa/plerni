-- SPDX-License-Identifier: Apache-2.0
-- Per-tenant audit commitment chain (spec §11, plan K8).
-- Each row stores the hash of the action payload, never the payload.
-- entry_hash links that hash to the previous row of the same tenant.
-- The head row is the per-tenant lock. A global chain is not used.
-- The commitment table is append-only at the grant layer.
-- The approval for this migration is unsigned. The maintainer signs it.

CREATE TABLE IF NOT EXISTS kernel.audit_chain_head (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  id uuid NOT NULL,
  seq bigint NOT NULL,
  head_hash text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT audit_chain_head_tenant UNIQUE (tenant_id),
  CONSTRAINT audit_chain_head_seq CHECK (seq >= 0),
  CONSTRAINT audit_chain_head_hash CHECK (head_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS kernel.audit_commitment (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  id uuid NOT NULL,
  seq bigint NOT NULL,
  action text NOT NULL,
  payload_hash text NOT NULL,
  previous_hash text NOT NULL,
  entry_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT audit_commitment_seq UNIQUE (tenant_id, seq),
  CONSTRAINT audit_commitment_seq_positive CHECK (seq > 0),
  CONSTRAINT audit_commitment_action CHECK (action ~ '^[a-z][a-z0-9_.]{1,80}$'),
  CONSTRAINT audit_commitment_payload_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_commitment_previous_hash CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_commitment_entry_hash CHECK (entry_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE kernel.audit_chain_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.audit_chain_head FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.audit_commitment ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.audit_commitment FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kernel.audit_chain_head;
CREATE POLICY tenant_isolation ON kernel.audit_chain_head
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.audit_commitment;
CREATE POLICY tenant_isolation ON kernel.audit_commitment
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE kernel.audit_chain_head FROM PUBLIC;
REVOKE ALL ON TABLE kernel.audit_commitment FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.audit_chain_head TO plerni_app;
GRANT SELECT, INSERT ON TABLE kernel.audit_commitment TO plerni_app;
