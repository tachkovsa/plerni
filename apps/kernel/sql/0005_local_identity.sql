-- SPDX-License-Identifier: Apache-2.0
-- Local accounts, sessions, and the one-time bootstrap marker (spec §6,
-- plan §5.2, ADR-0010). Tenant-domain tables keep tenant_id NOT NULL,
-- ENABLE and FORCE ROW LEVEL SECURITY, and one canonical policy.
-- Passwords and rescue codes are stored as argon2id PHC strings.
-- Session and reset tokens are stored as sha256 hex, never as the secret.
-- The bootstrap credential is not stored. kernel.bootstrap_state records
-- only that the credential has been consumed.
-- The commitment chain is not this migration. auth_audit is append-only
-- at the grant layer (no UPDATE, no DELETE).
-- The approval for this migration is unsigned. The maintainer signs it.

CREATE TABLE IF NOT EXISTS kernel.user_account (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  id uuid NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT user_account_email_once UNIQUE (tenant_id, email),
  CONSTRAINT user_account_kind CHECK (kind IN ('admin', 'member')),
  CONSTRAINT user_account_email CHECK (
    char_length(email) BETWEEN 3 AND 200
    AND email = lower(email)
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
  ),
  CONSTRAINT user_account_password_hash CHECK (
    char_length(password_hash) BETWEEN 40 AND 300
    AND password_hash LIKE '$argon2id$%'
  )
);

CREATE TABLE IF NOT EXISTS kernel.user_auth_state (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  revocation_epoch bigint NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT user_auth_state_epoch CHECK (revocation_epoch >= 0),
  FOREIGN KEY (tenant_id, id) REFERENCES kernel.user_account (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS kernel.session (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  session_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  revoked_at timestamptz,
  issued_epoch bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT session_token_hash UNIQUE (token_hash),
  CONSTRAINT session_kind CHECK (session_kind IN ('admin', 'member')),
  CONSTRAINT session_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT session_epoch CHECK (issued_epoch >= 0),
  FOREIGN KEY (tenant_id, user_id) REFERENCES kernel.user_account (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS session_by_user ON kernel.session (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS kernel.rescue_code (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  code_hash text NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT rescue_code_hash CHECK (
    char_length(code_hash) BETWEEN 40 AND 300
    AND code_hash LIKE '$argon2id$%'
  ),
  FOREIGN KEY (tenant_id, user_id) REFERENCES kernel.user_account (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS kernel.password_reset (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT password_reset_token UNIQUE (token_hash),
  CONSTRAINT password_reset_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (tenant_id, user_id) REFERENCES kernel.user_account (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS kernel.login_throttle (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  id uuid NOT NULL,
  subject_hash text NOT NULL,
  failures integer NOT NULL,
  window_started_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT login_throttle_subject UNIQUE (tenant_id, subject_hash),
  CONSTRAINT login_throttle_subject_shape CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT login_throttle_failures CHECK (failures >= 0)
);

CREATE TABLE IF NOT EXISTS kernel.auth_audit (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  id uuid NOT NULL,
  action text NOT NULL,
  actor_user_id uuid,
  target_user_id uuid,
  session_hash text,
  epoch_before bigint,
  epoch_after bigint,
  reason text NOT NULL,
  decision_basis text NOT NULL DEFAULT 'local',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT auth_audit_action CHECK (action IN (
    'login', 'login_rejected', 'refresh', 'logout',
    'disable', 'rescue', 'reset', 'create'
  )),
  CONSTRAINT auth_audit_basis CHECK (decision_basis = 'local'),
  CONSTRAINT auth_audit_session_hash CHECK (
    session_hash IS NULL OR session_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE IF NOT EXISTS kernel.tenant_auth_policy (
  tenant_id uuid NOT NULL REFERENCES kernel.tenants (id),
  id uuid NOT NULL,
  strict_disable boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT tenant_auth_policy_once UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS kernel.bootstrap_state (
  id boolean PRIMARY KEY DEFAULT true,
  consumed_at timestamptz,
  CONSTRAINT bootstrap_state_singleton CHECK (id)
);

INSERT INTO kernel.bootstrap_state (id)
SELECT true
WHERE NOT EXISTS (SELECT 1 FROM kernel.bootstrap_state);

ALTER TABLE kernel.user_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.user_account FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.user_auth_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.user_auth_state FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.session FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.rescue_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.rescue_code FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.password_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.password_reset FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.login_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.login_throttle FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.auth_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.auth_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.tenant_auth_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.tenant_auth_policy FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kernel.user_account;
CREATE POLICY tenant_isolation ON kernel.user_account
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.user_auth_state;
CREATE POLICY tenant_isolation ON kernel.user_auth_state
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.session;
CREATE POLICY tenant_isolation ON kernel.session
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.rescue_code;
CREATE POLICY tenant_isolation ON kernel.rescue_code
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.password_reset;
CREATE POLICY tenant_isolation ON kernel.password_reset
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.login_throttle;
CREATE POLICY tenant_isolation ON kernel.login_throttle
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.auth_audit;
CREATE POLICY tenant_isolation ON kernel.auth_audit
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON kernel.tenant_auth_policy;
CREATE POLICY tenant_isolation ON kernel.tenant_auth_policy
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE kernel.user_account FROM PUBLIC;
REVOKE ALL ON TABLE kernel.user_auth_state FROM PUBLIC;
REVOKE ALL ON TABLE kernel.session FROM PUBLIC;
REVOKE ALL ON TABLE kernel.rescue_code FROM PUBLIC;
REVOKE ALL ON TABLE kernel.password_reset FROM PUBLIC;
REVOKE ALL ON TABLE kernel.login_throttle FROM PUBLIC;
REVOKE ALL ON TABLE kernel.auth_audit FROM PUBLIC;
REVOKE ALL ON TABLE kernel.tenant_auth_policy FROM PUBLIC;
REVOKE ALL ON TABLE kernel.bootstrap_state FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON TABLE kernel.user_account TO plerni_app;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.user_auth_state TO plerni_app;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.session TO plerni_app;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.rescue_code TO plerni_app;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.password_reset TO plerni_app;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.login_throttle TO plerni_app;
GRANT SELECT, INSERT ON TABLE kernel.auth_audit TO plerni_app;
GRANT SELECT, INSERT, UPDATE ON TABLE kernel.tenant_auth_policy TO plerni_app;
GRANT SELECT, UPDATE ON TABLE kernel.bootstrap_state TO plerni_app;
