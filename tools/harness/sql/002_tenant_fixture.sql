-- 002_tenant_fixture.sql — the tenant-isolation fixture (spec §4.6 shape).
-- One canonical policy on the transaction-local context GUC, ENABLE + FORCE RLS.
-- NULLIF normalization: a warm backend can return '' for a previously-set custom GUC
-- (plan §3.1 A2) — ''::uuid would error instead of denying, so normalize first.

CREATE TABLE IF NOT EXISTS plerni_tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  label text NOT NULL
);

ALTER TABLE plerni_tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE plerni_tenant FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON plerni_tenant;
CREATE POLICY tenant_isolation ON plerni_tenant
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON plerni_tenant TO plerni_app;
