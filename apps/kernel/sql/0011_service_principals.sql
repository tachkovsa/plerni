-- SPDX-License-Identifier: Apache-2.0
-- Service principals (plan §5.2, K5). A principal is tenant-scoped.
-- The credential is a 256-bit token stored as sha256 hex. The scope rows
-- are the permissions the caller declared, and nothing else.
-- A sensitive or destructive denial for this credential is K7.
-- The approval for this migration is unsigned. The maintainer signs it.

CREATE TABLE IF NOT EXISTS kernel.service_principal (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  id uuid NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS kernel.service_credential (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  principal_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT service_credential_token UNIQUE (token_hash),
  CONSTRAINT service_credential_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES kernel.service_principal (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS service_credential_one_active
  ON kernel.service_credential (tenant_id, principal_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS kernel.service_principal_scope (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  principal_id uuid NOT NULL,
  permission text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT service_principal_scope_permission CHECK (
    char_length(permission) BETWEEN 2 AND 201
    AND permission ~ '^[a-z][a-z0-9_.:-]+$'
  ),
  CONSTRAINT service_principal_scope_once UNIQUE (tenant_id, principal_id, permission),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES kernel.service_principal (tenant_id, id)
);

ALTER TABLE kernel.service_principal ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.service_principal FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.service_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.service_credential FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.service_principal_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.service_principal_scope FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kernel.service_principal;
CREATE POLICY tenant_isolation ON kernel.service_principal
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.service_credential;
CREATE POLICY tenant_isolation ON kernel.service_credential
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.service_principal_scope;
CREATE POLICY tenant_isolation ON kernel.service_principal_scope
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE kernel.service_principal FROM PUBLIC;
REVOKE ALL ON TABLE kernel.service_credential FROM PUBLIC;
REVOKE ALL ON TABLE kernel.service_principal_scope FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON TABLE kernel.service_principal TO plerni_app;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.service_credential TO plerni_app;
GRANT SELECT, INSERT ON TABLE kernel.service_principal_scope TO plerni_app;
