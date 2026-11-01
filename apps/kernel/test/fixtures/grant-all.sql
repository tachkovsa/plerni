-- SPDX-License-Identifier: Apache-2.0
-- Negative fixture: GRANT ALL includes TRUNCATE and TRIGGER, which escape RLS.
CREATE TABLE kernel.fixture_grant_all (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  marker text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE kernel.fixture_grant_all ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.fixture_grant_all FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kernel.fixture_grant_all
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);
GRANT ALL ON kernel.fixture_grant_all TO plerni_app;
