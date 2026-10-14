#!/usr/bin/env bash
# reset.sh — full harness reset: secrets → compose → database → schema. Idempotent, fail-loud.
set -euo pipefail
cd "$(dirname "$0")"

: "${POSTGRES_PASSWORD:?unset}"  # compose superuser + admin credential for applying sql/
node render-secrets.mjs

docker compose up -d
echo "reset: waiting for healthy services…"
for i in $(seq 1 60); do
  P=$(docker compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null)
  # δ-MINOR-1: "unhealthy" contains "healthy" — require every line to end with exactly " healthy".
  if [ -n "$P" ] && ! echo "$P" | grep -qvx '.* healthy'; then break; fi
  if [ "$i" = "60" ]; then echo "reset: services not healthy in 120s" >&2; docker compose ps; exit 1; fi
  sleep 2
done

# Ephemeral database per run (plan §2): DROP … WITH (FORCE) kills pooled backends on the PG side,
# and the pgbouncer restart recycles its server-connection pool — no stale session state survives.
export PGPASSWORD="$POSTGRES_PASSWORD"
psql "host=localhost port=54320 user=postgres dbname=postgres" --set=ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS plerni WITH (FORCE)" \
  -c "CREATE DATABASE plerni"
docker compose restart pgbouncer >/dev/null
for i in $(seq 1 30); do
  H=$(docker compose ps --format '{{.Service}} {{.Health}}' | awk '$2=="healthy"' | wc -l | tr -d ' ')
  [ "$H" = "2" ] && break
  [ "$i" = "30" ] && { echo "reset: pgbouncer not healthy after restart" >&2; exit 1; }
  sleep 2
done

psql "host=localhost port=54320 user=postgres dbname=plerni" --set=ON_ERROR_STOP=1 \
  -v app_password="$PLERNI_APP_PASSWORD" \
  -v migrate_password="$PLERNI_MIGRATE_PASSWORD" \
  -v admin_password="$PLERNI_ADMIN_PASSWORD" \
  -f sql/001_roles.sql -f sql/002_tenant_fixture.sql -f sql/003_fencing_authority.sql

echo "reset: done — direct 54320 · pooled 54321/plerni · admin console 54321/pgbouncer"
