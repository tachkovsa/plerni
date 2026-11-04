-- SPDX-License-Identifier: Apache-2.0
-- Fixture schema. Every table name is plugin_fixture_alpha.<table>.
-- The runtime grant is the schema role, not plerni_app. No function, trigger,
-- or DO block. No other plugin schema.

CREATE SCHEMA IF NOT EXISTS plugin_fixture_alpha;

REVOKE ALL ON SCHEMA plugin_fixture_alpha FROM PUBLIC;
GRANT USAGE ON SCHEMA plugin_fixture_alpha TO plerni_plugin_fixture_alpha;

CREATE TABLE IF NOT EXISTS plugin_fixture_alpha.note (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  body text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE plugin_fixture_alpha.note ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_fixture_alpha.note FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON plugin_fixture_alpha.note;
CREATE POLICY tenant_isolation ON plugin_fixture_alpha.note
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE plugin_fixture_alpha.note FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE plugin_fixture_alpha.note TO plerni_plugin_fixture_alpha;
