-- SPDX-License-Identifier: Apache-2.0
-- Negative fixture: a second permissive policy. PostgreSQL OR-combines them.
CREATE TABLE kernel.fixture_second_policy (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  marker text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE kernel.fixture_second_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.fixture_second_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kernel.fixture_second_policy
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_open ON kernel.fixture_second_policy
  USING (true)
  WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.fixture_second_policy TO plerni_app;
