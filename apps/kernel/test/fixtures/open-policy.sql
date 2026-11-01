-- SPDX-License-Identifier: Apache-2.0
-- Negative fixture: one policy exists, and its text is not the canonical predicate.
CREATE TABLE kernel.fixture_open_policy (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  marker text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE kernel.fixture_open_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.fixture_open_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kernel.fixture_open_policy
  USING (true)
  WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.fixture_open_policy TO plerni_app;
