-- SPDX-License-Identifier: Apache-2.0
-- Negative fixture: tenant_id is nullable and is not part of the primary key.
CREATE TABLE kernel.fixture_nullable (
  tenant_id uuid,
  id uuid NOT NULL,
  marker text NOT NULL,
  PRIMARY KEY (id)
);
ALTER TABLE kernel.fixture_nullable ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.fixture_nullable FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kernel.fixture_nullable
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.fixture_nullable TO plerni_app;
