#!/usr/bin/env bash
# rename-unused-column.sh — the drift gate must fail when an unused column is
# renamed in the committed migration and the interface is left stale.
# created_at is not referenced by gen-corpus.mjs. Band 50 is the smallest band
# that still has the column. Exit 0 only when the gate exits 1 on that interface
# diff. The script restores both files on the way out.
set -euo pipefail
set +x

root=$(git rev-parse --show-toplevel)
bench="$root/tools/spikes/db-invariant/bench"
schema="$bench/.artifacts/band-50/schema.sql"
types="$bench/.artifacts/band-50/database-types.ts"
corpus="$bench/gen-corpus.mjs"
gate="$bench/drift-gate.sh"
schema_rel=${schema#"$root"/}
types_rel=${types#"$root"/}
tmp=$(mktemp)
mutated=0

cleanup() {
  local status=$?
  if [[ -n ${tmp:-} ]]; then
    rm -f "$tmp"
  fi
  if [[ $mutated -eq 1 ]]; then
    git -C "$root" restore --worktree --source=HEAD -- "$schema_rel" "$types_rel" || status=$?
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ ! -f $gate || ! -f $schema || ! -f $types || ! -f $corpus ]]; then
  echo "rename-unused-column: drift gate or band-50 artifacts are missing" >&2
  exit 1
fi
if grep -q 'created_at' "$corpus"; then
  echo "rename-unused-column: created_at is referenced by the corpus generator" >&2
  exit 1
fi
# Worktree vs index, and index vs HEAD. A staged-only edit is invisible to plain git diff.
artifacts_match_head() {
  git -C "$root" --no-pager diff --exit-code --color=never -- "$schema_rel" "$types_rel" >/dev/null \
    && git -C "$root" --no-pager diff --cached --exit-code --color=never -- "$schema_rel" "$types_rel" >/dev/null
}
if ! artifacts_match_head; then
  echo "rename-unused-column: band-50 schema or interface differs from HEAD" >&2
  exit 1
fi

mutated=1
awk '
  BEGIN { done = 0 }
  done == 0 && $0 == "  created_at timestamptz NOT NULL DEFAULT clock_timestamp()" {
    print "  opened_at timestamptz NOT NULL DEFAULT clock_timestamp()"
    done = 1
    next
  }
  { print }
  END { if (done != 1) exit 1 }
' "$schema" >"$tmp"
mv "$tmp" "$schema"
tmp=

if ! grep -q 'opened_at timestamptz' "$schema"; then
  echo "rename-unused-column: schema rename did not land" >&2
  exit 1
fi
if grep -q 'opened_at' "$types"; then
  echo "rename-unused-column: interface was regenerated before the gate" >&2
  exit 1
fi

set +e
output=$(bash "$gate" 50 2>&1)
status=$?
set -e
printf '%s\n' "$output"
printf 'rename-unused-column: drift-gate exit %s\n' "$status"

if [[ $status -eq 0 ]]; then
  echo "rename-unused-column: gate passed; expected a closed failure" >&2
  exit 1
fi
if [[ $status -ne 1 ]]; then
  echo "rename-unused-column: gate exited ${status}, not an interface diff" >&2
  exit 1
fi
if ! printf '%s\n' "$output" | grep -q 'drift-gate: band 50 committed interface drifted'; then
  echo "rename-unused-column: gate did not fail on the band-50 interface" >&2
  exit 1
fi
if ! printf '%s\n' "$output" | grep -E -q '^\+[[:space:]]*opened_at:'; then
  echo "rename-unused-column: diff did not show the renamed column on the interface" >&2
  exit 1
fi

git -C "$root" restore --worktree --source=HEAD -- "$schema_rel" "$types_rel"
if ! artifacts_match_head; then
  echo "rename-unused-column: restore left the band-50 files dirty" >&2
  exit 1
fi
mutated=0
echo "rename-unused-column: gate failed closed and the tree was restored"
