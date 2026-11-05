-- SPDX-License-Identifier: Apache-2.0
-- Approved plugin grants and the principal grant that gates a plugin read
-- (ADR-0008). Package SQL is journaled here. The plugin schema is not.
-- The plugin role is not created in this file. plerni_migrate has no
-- CREATEROLE, and CREATE ROLE cannot run inside the journal transaction.
-- The approval for this migration is unsigned. The maintainer signs it.

CREATE TABLE IF NOT EXISTS kernel.plugin_migration (
  plugin_id text NOT NULL,
  version text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (plugin_id, version),
  CONSTRAINT plugin_migration_id CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,40}$'),
  CONSTRAINT plugin_migration_version CHECK (version ~ '^[0-9]{4}_[a-z0-9_]+\.sql$')
);

REVOKE ALL ON TABLE kernel.plugin_migration FROM PUBLIC;
REVOKE ALL ON TABLE kernel.plugin_migration FROM plerni_app;

-- Install-time grants. A tenant enablement row cannot insert here: the app
-- role has SELECT only. The migration role owns the table.
CREATE TABLE IF NOT EXISTS kernel.plugin_grant (
  plugin_id text NOT NULL,
  grant_name text NOT NULL,
  PRIMARY KEY (plugin_id, grant_name),
  CONSTRAINT plugin_grant_id CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,40}$'),
  -- 2..201 matches GRANT_NAME_MAX in the grant vocabulary checker.
  CONSTRAINT plugin_grant_name CHECK (
    char_length(grant_name) BETWEEN 2 AND 201
    AND grant_name ~ '^[a-z][a-z0-9_.:-]+$'
  )
);

REVOKE ALL ON TABLE kernel.plugin_grant FROM PUBLIC;
GRANT SELECT ON TABLE kernel.plugin_grant TO plerni_app;

-- Tenant-domain. The principal id is synthetic until identity exists (K17 has
-- no K3 dependency). RLS is the tenant wall. The row is the object grant.
CREATE TABLE IF NOT EXISTS kernel.principal_grant (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  principal_id uuid NOT NULL,
  plugin_id text NOT NULL,
  resource text NOT NULL,
  action text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT principal_grant_plugin_id CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,40}$'),
  CONSTRAINT principal_grant_resource CHECK (resource ~ '^[a-z][a-z0-9_]{0,40}$'),
  CONSTRAINT principal_grant_action CHECK (action ~ '^[a-z][a-z0-9_]{0,40}$'),
  CONSTRAINT principal_grant_once UNIQUE (tenant_id, principal_id, plugin_id, resource, action)
);

ALTER TABLE kernel.principal_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.principal_grant FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kernel.principal_grant;
CREATE POLICY tenant_isolation ON kernel.principal_grant
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE kernel.principal_grant FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE kernel.principal_grant TO plerni_app;
