-- SPDX-License-Identifier: Apache-2.0
-- Directory users, groups, memberships, and typed edges (plan §5.3, K6).
-- Edge types are rows. Registering one does not add another kernel migration.
-- Plugin roles receive no grant. The broker writes edges as plerni_app.
-- The approval for this migration is unsigned. The maintainer signs it.

CREATE TABLE IF NOT EXISTS kernel.directory_user (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT directory_user_name CHECK (char_length(display_name) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS kernel.directory_group (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT directory_group_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT directory_group_name UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS kernel.directory_edge_type (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL,
  plugin_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT directory_edge_type_name_shape CHECK (name ~ '^[a-z][a-z0-9_]{0,40}$'),
  CONSTRAINT directory_edge_type_plugin CHECK (plugin_id ~ '^[a-z][a-z0-9_]{0,40}$'),
  CONSTRAINT directory_edge_type_name UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS kernel.directory_membership (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT directory_membership_once UNIQUE (tenant_id, group_id, user_id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES kernel.directory_group (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES kernel.directory_user (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS kernel.directory_edge (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  type_id uuid NOT NULL,
  subject_user_id uuid NOT NULL,
  object_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT directory_edge_endpoints CHECK (subject_user_id <> object_user_id),
  CONSTRAINT directory_edge_once UNIQUE (tenant_id, type_id, subject_user_id, object_user_id),
  FOREIGN KEY (tenant_id, type_id) REFERENCES kernel.directory_edge_type (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES kernel.directory_user (tenant_id, id),
  FOREIGN KEY (tenant_id, object_user_id) REFERENCES kernel.directory_user (tenant_id, id)
);

ALTER TABLE kernel.directory_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.directory_user FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.directory_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.directory_group FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.directory_edge_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.directory_edge_type FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.directory_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.directory_membership FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.directory_edge ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.directory_edge FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kernel.directory_user;
CREATE POLICY tenant_isolation ON kernel.directory_user
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.directory_group;
CREATE POLICY tenant_isolation ON kernel.directory_group
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.directory_edge_type;
CREATE POLICY tenant_isolation ON kernel.directory_edge_type
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.directory_membership;
CREATE POLICY tenant_isolation ON kernel.directory_membership
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.directory_edge;
CREATE POLICY tenant_isolation ON kernel.directory_edge
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE kernel.directory_user FROM PUBLIC;
REVOKE ALL ON TABLE kernel.directory_group FROM PUBLIC;
REVOKE ALL ON TABLE kernel.directory_edge_type FROM PUBLIC;
REVOKE ALL ON TABLE kernel.directory_membership FROM PUBLIC;
REVOKE ALL ON TABLE kernel.directory_edge FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE kernel.directory_user TO plerni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE kernel.directory_group TO plerni_app;
GRANT SELECT, INSERT ON TABLE kernel.directory_edge_type TO plerni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE kernel.directory_membership TO plerni_app;
GRANT SELECT, INSERT, DELETE ON TABLE kernel.directory_edge TO plerni_app;
