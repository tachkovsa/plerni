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

-- The pinned search_path is installed as the app role's default (plan §2 / γ-N3):
-- legitimate first-use backends come up clean; the hygiene protocol's step ② compares
-- against exactly this value.
ALTER ROLE plerni_app SET search_path TO "$user", public;

-- Membership fixture: lets the spike inject a leaked SET ROLE plerni_plugin_a
-- (without membership the injection cannot even be built).
GRANT plerni_plugin_a TO plerni_app;
