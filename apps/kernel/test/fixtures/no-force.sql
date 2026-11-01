-- SPDX-License-Identifier: Apache-2.0
-- Negative fixture: RLS enabled, not forced, so the owner bypasses the policy.
CREATE TABLE kernel.fixture_no_force (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  marker text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE kernel.fixture_no_force ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kernel.fixture_no_force
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.fixture_no_force TO plerni_app;
