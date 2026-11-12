-- SPDX-License-Identifier: Apache-2.0
-- OIDC provider configuration and one in-flight authorization (plan §5.2, K4).
-- The client secret is stored for the token request and is not a session
-- token. Login rows keep the PKCE verifier only until the code is consumed.
-- The approval for these bytes is not in the tree. The maintainer signs them.

ALTER TABLE kernel.auth_audit DROP CONSTRAINT auth_audit_action;
ALTER TABLE kernel.auth_audit ADD CONSTRAINT auth_audit_action CHECK (action IN (
  'login', 'login_rejected', 'refresh', 'logout',
  'disable', 'rescue', 'reset', 'create', 'oidc_configure'
));

ALTER TABLE kernel.auth_audit DROP CONSTRAINT auth_audit_basis;
ALTER TABLE kernel.auth_audit ADD CONSTRAINT auth_audit_basis CHECK (
  decision_basis IN ('local', 'idp-confirmed')
);

CREATE TABLE IF NOT EXISTS kernel.oidc_provider (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id) ON DELETE CASCADE,
  id uuid NOT NULL,
  issuer text NOT NULL,
  client_id text NOT NULL,
  client_secret text NOT NULL,
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT oidc_provider_once UNIQUE (tenant_id),
  CONSTRAINT oidc_provider_issuer CHECK (char_length(issuer) BETWEEN 12 AND 300),
  CONSTRAINT oidc_provider_client CHECK (client_id ~ '^[A-Za-z0-9._~-]{1,200}$'),
  CONSTRAINT oidc_provider_secret CHECK (
    char_length(client_secret) BETWEEN 16 AND 200
    AND client_secret !~ '[[:space:]]'
  ),
  CONSTRAINT oidc_provider_redirect CHECK (char_length(redirect_uri) BETWEEN 12 AND 300)
);

CREATE TABLE IF NOT EXISTS kernel.oidc_login (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id) ON DELETE CASCADE,
  id uuid NOT NULL,
  state_hash text NOT NULL,
  nonce text NOT NULL,
  code_verifier text,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT oidc_login_state UNIQUE (state_hash),
  CONSTRAINT oidc_login_state_shape CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oidc_login_nonce CHECK (nonce ~ '^[A-Za-z0-9_-]{43,128}$'),
  CONSTRAINT oidc_login_verifier CHECK (
    (consumed_at IS NULL AND code_verifier IS NOT NULL)
    OR (consumed_at IS NOT NULL AND code_verifier IS NULL)
  ),
  CONSTRAINT oidc_login_verifier_shape CHECK (
    code_verifier IS NULL OR code_verifier ~ '^[A-Za-z0-9_-]{43,128}$'
  ),
  CONSTRAINT oidc_login_redirect CHECK (char_length(redirect_uri) BETWEEN 12 AND 300)
);

CREATE TABLE IF NOT EXISTS kernel.oidc_link (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id) ON DELETE CASCADE,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT oidc_link_subject_once UNIQUE (tenant_id, issuer, subject),
  CONSTRAINT oidc_link_user_once UNIQUE (tenant_id, user_id),
  CONSTRAINT oidc_link_issuer CHECK (char_length(issuer) BETWEEN 12 AND 300),
  CONSTRAINT oidc_link_subject CHECK (
    char_length(subject) BETWEEN 1 AND 200
    AND subject !~ '[[:space:]]'
  ),
  FOREIGN KEY (tenant_id, user_id) REFERENCES kernel.user_account (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE kernel.oidc_provider ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.oidc_provider FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.oidc_login ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.oidc_login FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.oidc_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.oidc_link FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kernel.oidc_provider;
CREATE POLICY tenant_isolation ON kernel.oidc_provider
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.oidc_login;
CREATE POLICY tenant_isolation ON kernel.oidc_login
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.oidc_link;
CREATE POLICY tenant_isolation ON kernel.oidc_link
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE kernel.oidc_provider FROM PUBLIC;
REVOKE ALL ON TABLE kernel.oidc_login FROM PUBLIC;
REVOKE ALL ON TABLE kernel.oidc_link FROM PUBLIC;

GRANT SELECT, INSERT, DELETE ON TABLE kernel.oidc_provider TO plerni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE kernel.oidc_login TO plerni_app;
GRANT SELECT, INSERT ON TABLE kernel.oidc_link TO plerni_app;
