#!/usr/bin/env bash
# drift-gate.sh — plan §3.1 A5 drift gate (R1#5).
# Apply the committed per-band schema.sql to the live database spike_bench_<N>,
# regenerate database-types.ts with the pinned kysely-codegen flags, and
# git diff --exit-code HEAD on that interface. A staged copy is not the commit.
# This is not a required check.
# gen-schema.mjs is not used: it rewrites schema.sql from the generator and
# would erase a migration edit before codegen.
set -euo pipefail
set +x

root=$(git rev-parse --show-toplevel)
spike="$root/tools/spikes/db-invariant"
bench="$spike/bench"

host=${BENCH_PG_HOST:-127.0.0.1}
port=${BENCH_PG_PORT:-54320}
user=${BENCH_PG_USER:-postgres}
password=${BENCH_PG_PASSWORD:-${POSTGRES_PASSWORD:-}}

if [[ -z $password ]]; then
  echo "drift-gate: BENCH_PG_PASSWORD or POSTGRES_PASSWORD is required" >&2
  exit 1
fi
if [[ ! $port =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
  echo "drift-gate: BENCH_PG_PORT is not a port" >&2
  exit 1
fi
if [[ ! $host =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "drift-gate: BENCH_PG_HOST must be a hostname" >&2
  exit 1
fi
if [[ ! $user =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "drift-gate: BENCH_PG_USER must be an identifier" >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "drift-gate: psql is required" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "drift-gate: node is required" >&2
  exit 1
fi
password_encoded=$(REDACT_SECRET="$password" node --input-type=module -e '
  process.stdout.write(encodeURIComponent(process.env.REDACT_SECRET ?? ""));
')
redact() {
  REDACT_TEXT="$1" REDACT_SECRET="$password" REDACT_ENCODED="$password_encoded" node --input-type=module -e '
    let text = process.env.REDACT_TEXT ?? "";
    const secret = process.env.REDACT_SECRET ?? "";
    const encoded = process.env.REDACT_ENCODED ?? "";
    if (secret) text = text.split(secret).join("[redacted]");
    if (encoded && encoded !== secret) text = text.split(encoded).join("[redacted]");
    process.stdout.write(text);
    if (!text.endsWith("\n")) process.stdout.write("\n");
  '
}
codegen="$spike/node_modules/.bin/kysely-codegen"
if [[ ! -f $codegen ]]; then
  echo "drift-gate: kysely-codegen is not installed (pnpm install in the spike)" >&2
  exit 1
fi

bands=("$@")
if [[ ${#bands[@]} -eq 0 ]]; then
  bands=(50 75 200 400)
fi

allow_band() {
  case $1 in
    50 | 75 | 200 | 400) ;;
    *)
      echo "drift-gate: band must be one of 50, 75, 200, 400" >&2
      exit 1
      ;;
  esac
}

export PGPASSWORD="$password"
export PGCONNECT_TIMEOUT=10

for band in "${bands[@]}"; do
  allow_band "$band"
  db="spike_bench_${band}"
  schema="$bench/.artifacts/band-${band}/schema.sql"
  types="$bench/.artifacts/band-${band}/database-types.ts"
  rel=${types#"$root"/}
  if [[ ! -f $schema ]]; then
    echo "drift-gate: missing schema for band ${band}" >&2
    exit 1
  fi
  if [[ ! -f $types ]]; then
    echo "drift-gate: missing committed interface for band ${band}" >&2
    exit 1
  fi
  # Index and worktree must both match the commit before codegen overwrites the file.
  # A staged regeneration would otherwise hide a stale HEAD from a worktree-vs-index diff.
  if ! git -C "$root" --no-pager diff --exit-code --color=never HEAD -- "$rel" >/dev/null \
    || ! git -C "$root" --no-pager diff --cached --exit-code --color=never -- "$rel" >/dev/null; then
    echo "drift-gate: band ${band} interface already differs from HEAD" >&2
    exit 1
  fi

  echo "drift-gate: migrate band ${band} onto ${db}"
  psql "host=${host} port=${port} user=${user} dbname=postgres" --no-psqlrc --set=ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" \
    -c "CREATE DATABASE ${db}"
  psql "host=${host} port=${port} user=${user} dbname=${db}" --no-psqlrc --set=ON_ERROR_STOP=1 \
    -f "$schema" >/dev/null

  url=$(
    BENCH_URL_USER=$user \
      BENCH_URL_PASSWORD=$password \
      BENCH_URL_HOST=$host \
      BENCH_URL_PORT=$port \
      BENCH_URL_DB=$db \
      node --input-type=module -e '
        const user = encodeURIComponent(process.env.BENCH_URL_USER ?? "");
        const pass = encodeURIComponent(process.env.BENCH_URL_PASSWORD ?? "");
        const host = process.env.BENCH_URL_HOST ?? "";
        const port = process.env.BENCH_URL_PORT ?? "";
        const db = process.env.BENCH_URL_DB ?? "";
        if (!user || !pass || !/^[A-Za-z0-9._-]+$/.test(host) || !/^[0-9]+$/.test(port) || !/^[A-Za-z0-9_]+$/.test(db)) {
          process.exit(2);
        }
        process.stdout.write("postgres://" + user + ":" + pass + "@" + host + ":" + port + "/" + db);
      '
  )

  echo "drift-gate: regenerate band ${band} interface"
  set +e
  codegen_log=$(
    cd "$spike"
    DATABASE_URL="$url" "$codegen" \
      --dialect postgres \
      --date-parser timestamp \
      --numeric-parser string \
      --default-schema public \
      --log-level silent \
      --out-file "$types" \
      --type-only-imports 2>&1
  )
  codegen_status=$?
  set -e
  if [[ $codegen_status -ne 0 ]]; then
    redact "$codegen_log" >&2
    echo "drift-gate: kysely-codegen failed for band ${band}" >&2
    exit 1
  fi

  set +e
  diff_log=$(git -C "$root" --no-pager diff --exit-code --color=never HEAD -- "$rel" 2>&1)
  diff_status=$?
  set -e
  if [[ $diff_status -eq 0 ]]; then
    echo "drift-gate: band ${band} interface matches"
    continue
  fi
  if [[ $diff_status -eq 1 ]]; then
    printf '%s\n' "$diff_log"
    echo "drift-gate: band ${band} committed interface drifted" >&2
    exit 1
  fi
  printf '%s\n' "$diff_log" >&2
  echo "drift-gate: git diff failed for band ${band} (${diff_status})" >&2
  exit "$diff_status"
done

echo "drift-gate: ok"
