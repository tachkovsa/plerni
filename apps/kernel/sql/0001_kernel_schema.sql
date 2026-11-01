-- SPDX-License-Identifier: Apache-2.0
-- Kernel schema. Tenant-domain tables carry tenant_id NOT NULL, ENABLE and
-- FORCE ROW LEVEL SECURITY, and exactly one canonical policy (spec §4.6, §5).
-- The migration journal is kernel-internal and has no tenant policy.
-- Roles and the pinned search_path come from the database bootstrap. This
-- file does not set passwords and does not issue session SET.

CREATE SCHEMA IF NOT EXISTS kernel;

CREATE TABLE IF NOT EXISTS kernel.schema_migration (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON TABLE kernel.schema_migration FROM PUBLIC;

CREATE TABLE IF NOT EXISTS kernel.scoped_row (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  marker text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS kernel.scoped_link (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  row_id uuid NOT NULL,
  marker text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, row_id) REFERENCES kernel.scoped_row (tenant_id, id)
);

ALTER TABLE kernel.scoped_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.scoped_row FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.scoped_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.scoped_link FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kernel.scoped_row;
CREATE POLICY tenant_isolation ON kernel.scoped_row
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.scoped_link;
CREATE POLICY tenant_isolation ON kernel.scoped_link
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

GRANT USAGE ON SCHEMA kernel TO plerni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.scoped_row TO plerni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.scoped_link TO plerni_app;
REVOKE ALL ON TABLE kernel.schema_migration FROM plerni_app;
