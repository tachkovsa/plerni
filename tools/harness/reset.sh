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
  if [ -n "$P" ] && ! echo "$P" | grep -qv 'healthy'; then break; fi
  if [ "$i" = "60" ]; then echo "reset: services not healthy in 120s" >&2; docker compose ps; exit 1; fi
  sleep 2
done

# Database (idempotent) + schema, applied as the superuser through the direct port.
export PGPASSWORD="$POSTGRES_PASSWORD"
psql "host=localhost port=54320 user=postgres dbname=postgres" -tc \
  "SELECT 1 FROM pg_database WHERE datname='plerni'" | grep -q 1 || \
  psql "host=localhost port=54320 user=postgres dbname=postgres" -c "CREATE DATABASE plerni"

psql "host=localhost port=54320 user=postgres dbname=plerni" --set=ON_ERROR_STOP=1 \
  -v app_password="$PLERNI_APP_PASSWORD" \
  -v migrate_password="$PLERNI_MIGRATE_PASSWORD" \
  -v admin_password="$PLERNI_ADMIN_PASSWORD" \
  -f sql/001_roles.sql -f sql/002_tenant_fixture.sql -f sql/003_fencing_authority.sql

echo "reset: done — direct 54320 · pooled 54321/plerni · admin console 54321/pgbouncer"
