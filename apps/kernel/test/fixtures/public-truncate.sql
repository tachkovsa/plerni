-- SPDX-License-Identifier: Apache-2.0
-- Negative fixture: TRUNCATE granted to PUBLIC. TRUNCATE bypasses row security.
-- The grantor here is not the migration role. role_table_grants hides that row
-- from the migration role; the ACL does not.
CREATE TABLE kernel.fixture_public_truncate (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  marker text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE kernel.fixture_public_truncate ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.fixture_public_truncate FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kernel.fixture_public_truncate
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.fixture_public_truncate TO plerni_app;
GRANT TRUNCATE ON kernel.fixture_public_truncate TO PUBLIC;
