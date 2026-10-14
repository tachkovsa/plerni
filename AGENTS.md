# AGENTS.md — rules for any AI agent working in this repository

Plerni is a **public** open-source repository. These rules are mandatory.

## 0. Public-repository data policy (the first rule)

This repo is public from day one. Anything committed is permanent and world-readable — treat every commit as publication.

**Never commit, embed, or reference:**
- Secrets of any kind: API keys, tokens, passwords, private keys, certificates, cookie values — real *or* "example-shaped" real ones. Key material enters via environment variables or the operator's secret store only.
- `.env*` files (gitignored), `temp/` (gitignored), session handoffs (they live in `temp/`, never committed — the maintainer's working notes are private), session logs, scratch data, screenshots with real data.
- The maintainer's private tooling: agent CLIs, AI products/models used for authoring or review, API providers. Public files refer to review model families only by pseudonym (α, β, γ, δ); the identity mapping lives in `temp/` and is never committed. Local guard: `.private-markers.local` (gitignored) extends the private-markers gate with the maintainer's own forbidden patterns.
- Real personal data: names, emails beyond the maintainer's public identity, employee records, customer data. (Contributor names and commit emails deliberately supplied for public attribution and DCO certification are fine.)
- Confidential third-party information: customer/company names from deployments or consulting, internal infrastructure details (hosts, IPs, topologies), incident details, vendor pricing, unannounced partnerships.
- The predecessor product's identity, internals, file paths, or tracker contents. The predecessor is referenced only as **"the predecessor"**; its ADR/issue numbers may be cited as evidence IDs, never with names, URLs, or client details.
- Machine-local paths (`/Users/…`, `C:\…`, internal hostnames).

**Mechanical enforcement (fail-closed):** the `secrets` gate (gitleaks) and the `private-markers` gate (repo grep for forbidden patterns) run on every PR and push. A `gate-health` suite proves both gates can fail, via fixtures. Before *every* push: review the **full diff** as if it were a press release. If a secret ever lands in history: rotate it immediately, then rewrite history — never the reverse.

## 1. Product rules (bind all contributors)

Read the spec first: `docs/specs/` is the source of truth. The binding invariants are in §1: equal plugin citizenship, API-first parity, multi-tenant from the first commit, no marketplace before demand, mainstream-only tech, bounded dependency freshness, anti-slop UI, pure OSS, agent-native development, CIS-first/global-ready.

## 2. Engineering rules

- **Compliance lives in code, not prompts.** A convention that can be mechanized must be a gate (spec §12); instructions alone are hallucination-bait.
- **"Done" is never taken on faith** — run the thing, exercise the changed path, observe the result (principle 19).
- **Every bug gets an owner the moment it's seen** — fix it or file a tracked task (principle 20).
- **Generation ≠ verification** — high-risk work (authorization, tenancy, cryptography, plugin admission, migrations, CI/gates, release credentials, policy) is verified by a human or a different model family than every generator, evidenced by a revision-bound review receipt (principle 18; rules in `docs/ai/model-routing.md`). Identities stay private (§0); the commit trailer is role-only (`AI-assisted: yes`).
- File-size ratchet; small files, explicit responsibilities. ADR for any decision a future contributor would reverse-engineer.
- **Library research:** verify library documentation and versions against a live source (a docs MCP server, official docs, web search) — never recall versions from memory; record the sources relied on. Contributors choose their own research and coding tools.

## 3. Process

Spec-driven development → plan → tasks; TDD where it pays; role-chain walkthrough per feature; conventional commits + human DCO sign-off + role-only `AI-assisted: yes` trailer. See CONTRIBUTING.md and GOVERNANCE.md.

## 4. Review guidelines

These guidelines apply to any reviewer, human or agent, reviewing pull requests on this repository.

### 4.1 Source of truth and scope

Review against the PR's task specification (the plan section or issue) and the spec. Flag deviations as blocking issues:

- **BLOCKER:** changes not described in the task's scope; items explicitly on the task's NOT-list; edits to files owned by other tasks (e.g., a spike modifying the test harness owned by another task).
- **MAJOR:** missing deliverables or acceptance criteria from the task; scope creep that adds unrequested features.
- **MINOR:** incomplete references to the source spec or plan sections.

### 4.2 Evidence over claims

Verify every claim in the PR description and commit messages against the diff and real command output:

- **BLOCKER:** commit message describes changes absent from the diff (e.g., claims a test case that doesn't exist in the code); PR body claims "gates pass" without pasted output; tests that pass without exercising the risky path (e.g., a renewal/race path that never fired, with `renewals=0` in the evidence); hardcoded switches or feature flags that bypass the path under test **when that path is the task's acceptance target**.
- **MAJOR:** missing verification commands in the PR body (task requires running specific commands, none pasted); sleeps used as synchronization primitives instead of real wait conditions; recorded bounds/metrics without assertion in the test code **when the bound is a stated acceptance criterion**; hardcoded switches that bypass the code path under test (general case).
- **MINOR:** incomplete command output (truncated).

### 4.3 Correctness hot spots

Focus review effort on codebase-specific risks. When a rule cites a spec section or plan, verify the code against that source; where no citation exists, ask whether the pattern is correct rather than mandating a specific implementation.

**Multi-tenancy and RLS (BLOCKER if violated, spec §5 + plan §2):**
- Tenant context is transaction-local only via `set_config('plerni.tenant_id', value, true)` inside `BEGIN` (plan §2: ordered hygiene protocol).
- Never session-level `SET` through the pool (survives transaction-mode reuse).
- Application-layer tenant guard exists alongside RLS (two-layer fail-closed, spec §5).
- Tenant-domain tables: `tenant_id NOT NULL` + `ENABLE` **and** `FORCE RLS` + exactly one canonical tenant policy (spec §4.6 boundary checker).

**Connection handling (MAJOR if violated, spec §5 + plan §2):**
- Pooled connections (via PgBouncer transaction mode) vs. direct/reserved connections are used correctly (spec §5: no session state on pooled connections).
- No session state (`SET`, `LISTEN`, advisory locks) on pooled connections (spec §5).
- Heartbeat/renewal traffic uses reserved-capacity paths (plan §4 B2: dedicated connection or separate pool).

**State transitions and fencing (BLOCKER if violated, plan §4 B2):**
- Conditional state transitions use `WHERE status='EXPECTED' AND id=:x` predicates (plan B2: atomic state-transition protocol).
- Fencing tokens checked at commit time; stale tokens rejected (plan B2).
- Multi-aggregate WorkUnits lock aggregates in canonical (id-sorted) order (spec §4.3).

**Concurrency and shutdown (MAJOR if violated, plan §4 B2):**
- Race conditions are tested with adversarial timing (not assumed away).
- Shutdown ordering prevents deadlocks (plan B2: stop scheduling renewals before acquiring row locks).
- Sweeper/recovery logic includes lease expiry checks and doesn't rewrite terminal states (plan B2).

**Kernel purity (BLOCKER if violated, spec §3):**
- No domain nouns in the kernel (checked by the kernel-purity gate).
- Plugin-to-plugin dependencies go through public contracts, never tables (spec §4.8).

### 4.4 Security review

This is a defensive review of the project's own code changes. Report concrete findings with file:line, an exploit scenario, and a proposed fix. State explicitly what was checked versus not checked.

**Secrets and credentials (BLOCKER if violated, AGENTS.md §0):**
- No API keys, tokens, passwords, private keys, or "example-shaped" real secrets in commits, logs, error messages, or evidence files.
- No secrets in compose output (use `--no-interpolate`), screenshots with real data, or PR body text.
- Environment variables are the only secret entry path; `.env*` files remain gitignored.

**Injection vulnerabilities (BLOCKER if violated, spec §4.3):**
- No SQL built by string interpolation (intervals, identifiers, dynamic `ORDER BY` columns must use allowlisted/parameterized mechanisms per spec §4.3 bounded grammar).
- No shell command injection (constructed shell commands, unsanitized path inputs).
- Declared query grammars with bounded composition (allowlisted sort columns, declared optional predicates, spec §4.3).

**Authentication and authorization (BLOCKER if violated, spec §6):**
- Session revocation: PostgreSQL is the only revocation authority (spec §6: `sessions` table + `user_auth_state.revocation_epoch`). Authority is the PG session/epoch record, not only cache (spec §6).
- Authorization predicates are injected by the broker before query execution (not filtered after, spec §4.3).
- MCP/agent credentials never bypass human-only step-up (proof-of-human ceremony for sensitive/destructive actions, spec §8).
- Tenant isolation: no cross-tenant reads; RLS policies are `ENABLE` **and** `FORCE RLS` (spec §4.6 boundary checker).

**Plugin isolation and IPC (MAJOR if violated, spec §4.4 + plan §4 B6):**
- Plugin-supplied identity fields are untrusted; identity is stamped by the supervisor from spawn-time credentials (plan B6).
- Frame size limits are enforced; partial-buffer caps prevent unbounded buffering (plan B4).
- Malformed input (never-terminated frames, oversize messages) fails with typed errors, not crashes (plan B4).
- Per-plugin capability credentials bind every IPC call to plugin identity/version/grants (spec §4.4).

**Privilege and roles (MAJOR if violated, spec §4.6):**
- No `SUPERUSER` or `BYPASSRLS` in runtime application roles (spec §5).
- Migration roles have `CREATE` on their own schema only, no kernel-schema grants (spec §4.6).
- `GRANT ALL` is rejected by the grant linter (spec §4.6: runtime-DML-only grants).

**Supply chain (MAJOR if violated, spec §4.1 + §12):**
- New dependencies: check licenses via the license-audit gate; digest-pin containers; **no npm lifecycle scripts at install** (spec §4.1).
- Lockfile changes accompany manifest changes (drift indicates tampering or incomplete update).
- GitHub Actions: pinned to commit SHAs (not tags); untrusted PR input never in `run:` context; `GITHUB_TOKEN` has minimal permissions.

**Unsafe operations (questions, not mandates — check if present, ask if correct):**
- If deserialization of untrusted data: is it safe? (spec §4.4: plugin-supplied schemas are never compiled/executed).
- If timing-sensitive secret comparisons: are they constant-time? (ask, don't mandate a specific function).
- If check-then-act pattern: is the gap closed by transactional check-and-act or fencing tokens? (spec §4.3 WorkUnit conditional semantics).

**Public-data policy (BLOCKER if violated, AGENTS.md §0):**
- No tool/model identities, API providers, or agent CLI names in commits or PR metadata.
- Model families referenced only as α/β/γ/δ; the identity mapping stays in `temp/` (gitignored).
- No machine-local paths (`/Users/…`, `C:\…`, `/home/…`), internal hostnames, or RFC1918 IPs (checked by private-markers gate).
- No predecessor product identity, file paths, or tracker URLs.

### 4.5 Output format and review receipts

Every review ends with a verdict and a receipt:

**Verdict:** `ACCEPT` | `ACCEPT-WITH-CHANGES` (non-blocking findings) | `REJECT` (blocking issues must be fixed).

**Findings grouped by severity:**
- **BLOCKER:** must fix before merge (security, correctness, policy violations).
- **MAJOR:** should fix (maintainability, missed requirements, significant risks).
- **MINOR:** consider fixing (incomplete references, minor gaps).
- **NIT:** optional polish (style preferences, subjective improvements).

Each finding: `[severity] file:line — description (proposed fix or question)`.

**What was verified vs. not verified:** List the subsystems/properties checked (e.g., "verified: tenant isolation in the query layer, fencing token mechanics, session revocation; not checked: backup/restore paths, UI token discipline").

**Reviewed head SHA:** The exact git commit SHA reviewed (receipts are invalid after any new commit).

**High-risk task requirement:** If the task is high-risk (authorization, tenancy, cryptography, plugin admission, migrations, CI/gates, release credentials, policy changes — per CONTRIBUTING.md, GOVERNANCE.md, `docs/ai/model-routing.md`, spec principle 17), the reviewer must be from a different model family than every generator. State the family-separation assertion in the receipt (e.g., "this review by family γ covers code generated by family α").

### 4.6 Reviewer conduct

- **Don't take "done" on faith** — run the commands, observe the output, verify claims (principle 19).
- **Don't rubber-stamp** — every review finding should be specific and actionable; "looks good" without verification is not a review.
- **Don't propose unrequested features** — scope changes belong in a separate task/issue, not in code review.
- **Distinguish blocking issues from preferences** — use severity levels honestly; save BLOCKER for correctness/security/policy violations; style preferences are NITs.
- **When you don't know, verify** — consult the spec, the plan, the gates, or another model family; agreement is not evidence (principle 18).

### 4.7 Handling review comments (PR authors)

Every review comment requires a response in its thread:

- **Fixed:** Reply with the fixing commit SHA and a one-line summary of the change (e.g., "Fixed in abc1234: added the missing tenant guard"). Then resolve the thread.
- **Declined or deferred:** Reply with the reason. If deferred, link the tracking issue. Leave the thread unresolved — the reviewer or maintainer decides whether to accept the response.
- **Questions:** Answer directly. Resolve the thread only when nothing further is needed.
- **Never resolve without replying** — a silently resolved thread wastes the reviewer's time and hides whether the issue was addressed.
- **Never resolve BLOCKER or security findings without the fix commit** — severity matters; a response alone doesn't close a blocking issue.

A PR is not ready for merge while any review thread remains unresolved.
