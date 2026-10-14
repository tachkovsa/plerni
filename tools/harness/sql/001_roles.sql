-- 001_roles.sql — harness roles. Passwords arrive ONLY via psql -v (never literals).
-- Roles: plerni_app (runtime, NOBYPASSRLS) · plerni_migrate (DDL) · plerni_admin_ro (PgBouncer console)
-- Plus plerni_plugin_a: membership fixture enabling the SET ROLE injection test (plan §2, δ-F1).
-- Idempotent (psql \gexec pattern): re-runs reconcile, never fail.

SELECT 'CREATE ROLE plerni_app LOGIN NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'plerni_app')\gexec
SELECT 'CREATE ROLE plerni_migrate LOGIN'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'plerni_migrate')\gexec
SELECT 'CREATE ROLE plerni_admin_ro LOGIN'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'plerni_admin_ro')\gexec
SELECT 'CREATE ROLE plerni_plugin_a NOLOGIN'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'plerni_plugin_a')\gexec

ALTER ROLE plerni_app PASSWORD :'app_password';
ALTER ROLE plerni_migrate PASSWORD :'migrate_password';
ALTER ROLE plerni_admin_ro PASSWORD :'admin_password';

-- Migration role may create schemas in the harness database only.
GRANT CREATE ON DATABASE plerni TO plerni_migrate;

-- The pinned search_path is installed as the app role's default (plan §2 / γ-N3).
-- MUST be a non-default explicit value (δ-MAJOR-1): "$user", public is PostgreSQL's built-in
-- default — a backend whose role default was never installed would read back the SAME value,
-- making the bring-up check vacuous; and $user-first resolution opens a shadowing path
-- (a schema named after the role can shadow tables past RLS). Pin to exactly `public`.
ALTER ROLE plerni_app SET search_path TO public;

-- Membership fixture: lets the spike inject a leaked SET ROLE plerni_plugin_a.
-- WITH INHERIT FALSE, SET TRUE (δ-MAJOR-2): inherited privileges would make the app role
-- the union of plugin roles (the opposite of spec §5's per-plugin switches) and the
-- leaked-role test would measure an empty difference — it could not fail.
GRANT plerni_plugin_a TO plerni_app WITH INHERIT FALSE, SET TRUE;
