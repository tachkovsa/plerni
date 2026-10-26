# P0 Implementation Plan — Foundations (v12)

- **Status:** v12 — final revision of the reviewed plan. γ confirmation on v11: ACCEPT WITH CHANGES, 2 one-clause MINORs (genesis wording; γ-naming in §9(a)) — fixed here; plus the δ-M2 regression catch (second-executor case restored to B2, §11.11). Trail: β rounds 1–7 (§11.1–§11.6, ACCEPT on v7) · δ blind pass (§11.7) · γ passes on v8/v9/v10/v11 (§11.8–§11.12). · **Date:** 2026-10-13
- **Amendment (2026-10-25, [issue #15](https://github.com/tachkovsa/plerni/issues/15)):** maintainer decision. Plerni is an open experiment with no delivery deadline. Deliverable 5 is the contributor roadmap ([`../ROADMAP.md`](../ROADMAP.md)), not a capacity annex. The schedule model below in §5 (stated team, calendar formula, Monte Carlo P80, nine-month bar, cut ladder) is withdrawn and is not an exit criterion. The same change updates spec §15, §1 principle 4(c), and §17.9, and the D23 summary in the decision register, so those texts no longer assign the bar. The §5 text stays so the review trail in §11 still has its referent. It is history, not work.
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §15 (P0 row), §4.3/§5 (data), §4.4 (IPC), §12 (gates), §16 (acceptance)
- **Register:** D06 (ORM), D10 (outbox), D11 (isolation), D13/D14 (UI kit + tokens)
- **Exit criteria (binding for execution; spec §15 except the withdrawn schedule bar):** each P0 gate blocks its deliberately-bad fixture PR · spike reports filed with pass/fail verdicts · contributor roadmap published ([`../ROADMAP.md`](../ROADMAP.md)). The protected set (contract layer, tenancy floor, blocking CI core — spec §17.9) stays intact. There is no nine-month arithmetic bar.

## 0. Purpose and non-goals

P0 turns the approved design (spec v6 + register D01–D32 + ADR-0001) into a verified execution substrate: two load-bearing technical hypotheses get proven or falsified *before* any schema or platform work, the four pending architecture ADRs get written against evidence, and contributors get a plain-language roadmap ([`../ROADMAP.md`](../ROADMAP.md)) instead of a schedule model.

**Non-goals for P0:** no product schema, no kernel services, no SDK surface, no UI. Spike code lives in `tools/spikes/`; the Spike B harness is written to be promoted into the P2 conformance-suite skeleton.

**Founder constraints applied to this plan** (maintainer direction, 2026-10-13):

1. **Learning interop (SCORM, xAPI, LRS, LTI) = plugin-delivered adapters, never kernel** (spec §3). P0 consequence, precisely scoped: the event log (spec §7) is **delivery machinery** with cursor-driven retention — *not* the statement store; a future LRS plugin owns durable statement storage in its own plugin schema. P0 freezes only a **workload assumption** (Annex L, §6): payload size, write rate, retention class of an xAPI-shaped stream, materialized as a *separate plugin-owned durable table* in Spike A's benchmark schema. Contract conventions reserve generic event-envelope taxonomy + semver namespacing. (Review R1#17: clean.)
2. **Integration ease** — REST/OpenAPI from P1, MCP read P1, MCP write with the proposal ceremony P3 (spec §10; R1: no finding). P0 fixes the one-registry layout (zod → OpenAPI + MCP).
3. **AI-optional by construction** — deterministic outcomes via deterministic code; AI never in a correctness path. P0 delivers: zero AI deps in spikes/harness; conventions define an **executable no-AI workflow inventory** — every workflow names its no-AI completion path, blocking acceptance tests assigned to the introducing phase, assistant-absent UI state in the fixture gallery (R1#18: clean).

## 1. Deliverables and PR structure

| # | Deliverable | Path | Depends on |
|---|---|---|---|
| 1 | This plan (incl. Annex L, §6) | `docs/plans/2026-10-13-p0-implementation-plan.md` | — |
| 2 | Dev harness | `tools/harness/` | 1 |
| 3 | Spike A: DB invariant | `tools/spikes/db-invariant/` + report | 2, Annex L frozen in 1 |
| 4 | Spike B: IPC harness | `tools/spikes/ipc-harness/` + report | 2 (fencing authority uses harness PG) |
| 5 | Contributor roadmap (replaces the withdrawn capacity annex) | `docs/ROADMAP.md` | 1 |
| 6 | ADR-0002 ORM/data layer (D06) | `docs/adr/0002-orm-data-layer.md` | 3 verdict |
| 7 | ADR-0003 outbox + pg-boss (D10) | `docs/adr/0003-outbox-pgboss.md` | 1 |
| 8 | ADR-0004 plugin isolation topology (D11) | `docs/adr/0004-plugin-isolation-topology.md` | 4 verdict |
| 9 | ADR-0005 UI kit + token compiler (D13+D14) | `docs/adr/0005-ui-kit-token-compiler.md` | 1 + default-theme discovery note (§12) |
| 10 | Contract conventions | `docs/specs/contract-conventions.md` | 1 (formalizes Annex L) |
| 11 | Gate fixture PRs — **all six implemented gates** | bad PRs through the real PR/check path | 1 |

ADR mapping confirmed against the register; all other decisions recorded (ADR-0001) or later-phase. Stated explicitly in the plan PR body.

**Sequencing (R1#15):** Annex L freezes inside deliverable 1 before Spike A fixtures exist; any change to the frozen workload shape invalidates affected Spike A results and forces a rerun. Documentation parallelizes; evidence-dependent finalization never does.

## 2. Dev harness (deliverable 2 — blocks both spikes)

- **Services:** PostgreSQL 18 (newest stable major 2026-10-13; 19 is beta; spec floor 16; digest-pinned) + PgBouncer 1.26.0 (digest-pinned), `pool_mode = transaction`, `max_prepared_statements = 0` (R2#2: this setting governs *named* client statements — it is not a fallback for unnamed-traffic overhead; see A4). No Valkey/S3 — no P0 consumer. *(Versions verified against live sources 2026-10-13: postgresql.org, pgbouncer.org, npm registry.)*
- **Datasources (three, R2#10):** (a) direct PG; (b) PgBouncer app endpoint — every Spike A test runs against both; (c) **PgBouncer admin console connection (read-only)** for effective-config evidence: `SHOW CONFIG`, `SHOW DATABASES`, `SHOW USERS`, tied to the tested endpoint/database/role (admin commands are only valid on the special admin database — `SHOW` through the app datasource is forwarded to PG and fails). PG-side settings are collected through the actual test transaction.
- **Reset/seed:** ephemeral DB per run; ≥2 tenants, overlapping domain identifiers; schema generator (N tables).
- **RLS fixture roles:** app role `NOBYPASSRLS`, migration role, canonical tenant policy — plain SQL.
- **Connection-hygiene protocol (R4#1 — ordered statements, because `current_setting` returns the *effective* value and a transaction-local override masks the session value; custom GUCs are also not enumerable via `pg_settings`; extended per δ-F1/F2):** inside the pinned transaction, in this exact order: ① `BEGIN`; ② **inspect explicitly named** session state **before any local override** — the `plerni.*` context GUCs via `current_setting(name, true)` (normalizing `''` as absent, same rule as A2(c) — a warm backend reads back `''` after a local-only set, and treating that as contamination would self-terminate every reuse and thrash the pool) **plus** `current_user = session_user` (a leaked session-level `SET ROLE` survives transaction-mode reuse exactly like a GUC, and the broker's per-plugin role switches (spec §5) make the app role a member of plugin roles — a leaked role is a cross-plugin privilege path) **plus** `search_path` equals its pinned value (same persistence class, same argument). The pinned value is stated: the harness installs it as the app role's default (`ALTER ROLE plerni_app SET search_path …` in `sql/001_roles.sql`), so legitimate first-use backends come up already clean — ② compares against exactly that default, and a backend whose default was never installed fails ② on first use, which the terminations==injected assertion catches during harness bring-up, not in production-like runs; at this point effective = session, so contamination is readable; ③ contaminated → terminate own backend (`pg_terminate_backend(pg_backend_pid())` as the terminal statement; the connection error is the *designed* outcome — PgBouncer evicts the dead server connection) → security alert → bounded retry ≤2 on a fresh connection, then loud failure; ④ clean → install the transaction-local context via `set_config(…, true)` **and verify the effective value equals the authorized tenant** (guards against silent wrong-value install); ⑤ only then tenant data access. Backend-assignment gap is closed by construction (②–⑤ run on the one backend pinned by the transaction); first-use and default-injected (`ALTER ROLE … SET`) contamination covered; cleanup cost measured in the A-series benchmarks, **and the benchmark asserts terminations == injected contaminations** (no thrash from false positives, δ-F2).
- **Fencing authority (for Spike B):** PG table with one authority row per execution (`id, plugin_id, token, status ∈ {QUEUED, ACTIVE, COMMITTED, CANCELLED, ABANDONED}, heartbeat_at, …`) + broker stub whose commit path performs the **atomic status transition** (§4, B2). Lifecycle: created `QUEUED` at submission (the sweeper never touches QUEUED rows — work that waits longer than the lease is *queued*, not abandoned, δ-F6); the dispatch transition `QUEUED→ACTIVE` stamps `heartbeat_at`; effects + `ACTIVE→COMMITTED` commit in one transaction; revocation is the competing `ACTIVE→CANCELLED`; the sweeper settles crashed executors via conditional `ACTIVE→ABANDONED` (expired lease).
- **Honesty note:** single-host compose relaxes the egress-denied production topology and says so.

## 3. Spike A — DB-invariant spike (D06; gates all schema work)

**Question:** can Kysely over node-postgres carry the tenancy substrate (transaction-local RLS context on pooled connections through PgBouncer transaction mode) with type-checking costs that keep agent-authored code fail-closed?

### 3.0 Mandatory causal-diagnosis protocol (precedes any verdict mapping)

No assertion failure is labeled until diagnosed: ① minimal raw-`pg` control (Kysely-misuse ≠ driver failure); ② effective-config evidence via the **admin-console datasource** (R2#10) plus PG settings through the test transaction; ③ ≥3 runs, environment recorded; ④ the oracle is a hypothesis too. Destinations apply only to *established* causes: driver-level → redesign tenancy substrate (not ORM); type-ergonomics → Drizzle fallback, never Prisma; oracle/config → fix and rerun; **environmental noise → invalid run, rerun, no verdict** (this outcome now exists for both spikes, R2#6).

### 3.1 Hypotheses and pass/fail criteria

| ID | Hypothesis | Pass criterion (measured) | Fail → after §3.0 |
|---|---|---|---|
| A1 | `transaction().execute` pins one server connection per transaction | `pg_backend_pid()` constant across ≥3 statements under concurrent load, both datasources; raw-`pg` control identical | driver-level |
| A2 | Transaction-local context cannot leak across pool reuse, and its absence fails closed | **Three distinct cases (R2#1):** (a) *clean-deny* — a transaction deliberately missing context reads **zero rows** from tenant tables and the app guard raises; (b) *valid-context positive control* — a correctly initialized tenant-B transaction reads exactly B's rows (proves the fixture isn't just denying everything); (c) *contaminated reuse* — after commit/abort, `NULLIF(current_setting('plerni.tenant_id', true), '') IS NULL` on the reused connection (empty-string vs NULL is representation, not leakage) **and** zero rows for a context-less follow-up | driver-level |
| A3 | Full pinned flow through PgBouncer transaction mode | A1+A2 green via PgBouncer incl. mid-transaction error → rollback → context absent. **Contamination lifecycle (R3#1):** a committed session-level `SET` *survives* a later transaction-local setting (PG restores session state at tx end; PgBouncer skips reset queries) — therefore hygiene is enforced **inside the pinned transaction** per the §2 ordered protocol (inspect *before* local override — `current_setting` would otherwise mask the session value, R4#1): the test proves (i) contamination is detected on the *executing* backend before tenant access, (ii) the contaminated backend is physically terminated (`pg_terminate_backend(pg_backend_pid())`) and evicted from the pool — verified by backend identity, (iii) A2(c)'s absence check runs on the **replacement** session (the contaminated original is never assumed emptied), (iv) authorized rows remain readable through the whole recovery path (positive controls), (v) termination+retry stays within the bounded budget | driver-level |
| A4 | Unnamed-statement discipline (extended protocol, empty names) holds; overhead measured honestly | Driver instrumentation asserts every outbound statement name is empty under full load (never `pg_prepared_statements` sampling — per-backend, pooled inspection can miss); benchmark = unnamed parameterized extended-protocol vs named on a *direct* connection. **No config fallback (R2#2):** `max_prepared_statements` caches *named* client statements and cannot help mandated unnamed traffic. Overhead >20% → opens **A4b**: a separately validated named-statement branch (client-side change, its own criterion, full pooled rerun) — a new experiment, not a config flip. **A4b runs with `max_prepared_statements > 0` and reruns A1–A3 under that config** (δ-F3: at 0, PgBouncer does not track named statements, so the branch is unrunnable — and a "prepared statement does not exist" failure must never be filed as driver-level via §3.0) | driver-level if unnamed discipline itself fails |
| A5 | Kysely generics typecheck affordably at representative size **and workload** | **Frozen workload with representativeness contract (R3#3 + R4#3 + R5#2):** schema bands 50/75/200/400 tables; corpus 5×N instantiated queries per band with fixed S/M/L distribution — **integer allocation rule: S=3N, M=⌊1.5N⌋, L=5N−S−M** (remainder deterministically lands in L). **Shape definitions (restored; the integer rule allocates among these, never instead of them):** **S** = single-table CRUD (select by PK, insert, update by PK); **M** = 2–3 joins + declared optional predicates + keyset pagination; **L** = CTE (incl. data-modifying CTE) + conditional query composition + reusable generic helper functions with inferred result types. At the acceptance band N=75: **S=225, M=112, L=38 (total 375)**. Per-band floors M≥20, L≥10 so shape coverage cannot be diluted by trivial queries. **No type escape hatches (δ-F4):** a corpus lint rejects `sql` fragments (except the `set_config` call), `as`/`any`, explicit result generics, and `$castTo` — each would push inference cost toward the raw-`sql` baseline and let A5 pass while real agent-written Kysely code overruns; every corpus query additionally carries a type-level assertion of its inferred row type. **Acceptance point vs stress points, explicitly separated:** the P1 kernel estimate is ≈15 tables / 60–80 typed queries → 5× headroom = **75 tables / 300–400 queries** = the *acceptance point* where the ceiling binds: `tsc --noEmit` ≤4 GB RSS, ≤120 s on the CI runner class. The 200/400-table bands are **stress points** characterizing the scaling curve (26.7× baseline at 400) — overruns there trigger §3.0 diagnosis and feed the budget ADR, they do not auto-trigger the ORM fallback. Compiler flags frozen; baseline = same corpus via raw `sql`. **Drift gate (R1#5):** regeneration against the live migrated DB + committed-output diff, proven by two drift fixtures (rename unused column; SQL change without regeneration) | ergonomics-level (acceptance point only) |

### 3.2 Adversarial battery

1. Pool reuse after abort (A2 case c; two-layer fail-closed: RLS + app guard).
2. Interleaved tenants on a pool of size 1 — visibility tracks transaction-local context (with positive controls both ways).
3. Contaminated session baseline — full lifecycle per A3: detection **inside the pinned transaction on the executing backend** → own-backend termination + pool eviction (verified by backend identity) → alert → bounded retry on a replacement session → A2(c) absence check runs on the replacement. Injected contamination variants: tenant GUC, **`SET ROLE`**, **`search_path`** (δ-F1: all three persist across transaction-mode reuse; role leakage is the cross-plugin privilege path), first-use connections, and default-injected (`ALTER ROLE … SET`). Cleanup cost measured; **the run asserts terminations == injected contaminations** (δ-F2: zero false-positive self-terminations on warm backends).
4. **GUC-forgery at the real boundary** (R1#2: PostgreSQL offers no role privilege to deny session-setting an ordinary custom GUC — the containment boundary is admission parsing + broker-owned context, spec §4.3): (a) declared query smuggling `set_config` → rejected by a **prototype** allowlist classifier — explicitly labeled prototype evidence scoped to "classifier shape"; phase attribution corrected (γ-N6): the admission-parser *machinery* lands in P2 (spec §4.3), the tenancy-gate GUC-forgery suite row is §12 (lands with P1's isolation suite), and the §16.13 acceptance test runs at P3; (b) plugin SQL never executes raw; (c) hostile session-level `SET` by the app role is proven harmless *given the §2 protocol* — and the spike documents that session-GUC denial is unavailable as a mechanism, so P1 never designs as if it existed.
5. Typecheck memory honesty — heap logging, full curve, recorded environment.

**Method notes:** Node ≥22 (v22.22.0), `pg` 8.23.1 · `kysely` 0.29.6 · `kysely-codegen` 0.20.0 (npm-verified 2026-10-13); `set_config` via Kysely `sql` template only; raw-`pg` controls exist inside the spike for §3.0 diagnosis. Output: suite + logs + verdict report per hypothesis; the reviewer reruns it (principle 19).

## 4. Spike B — IPC harness spike (D11, spec §4.4)

**Question:** does framed NDJSON over stdio carry the port-call protocol with cancellation, backpressure, boundedness — including over the shared multiplexed runner↔kernel channel? (TLS crypto excluded as boring; multiplexing, identity binding, and cancellation are not.)

| ID | Hypothesis | Pass criterion | Fail |
|---|---|---|---|
| B1 | Framed req/res/cancel with correlation IDs sustains the target shape | ≥5,000 round-trip/s, 1 KiB payloads, p99 ≤10 ms, zero corruption — under the measurement contract | redesign before P2 |
| B2 | Cancellation is commit-safe under race, with **defined outcome arbitration and settlement** | **Atomic state-transition protocol (R3#2, δ-F6):** one authority row per execution, `status ∈ {QUEUED, ACTIVE, COMMITTED, CANCELLED, ABANDONED}`. Created `QUEUED` at submission — **the sweeper never touches QUEUED rows** (work waiting longer than the lease is queued, not abandoned; δ-F6); dispatch performs `QUEUED→ACTIVE` and stamps `heartbeat_at`. Executor commit = effects + `UPDATE … SET status='COMMITTED' WHERE id=:x AND status='ACTIVE'` in one PG transaction — 0 rows ⇒ abort, `FENCED`. Revocation = `UPDATE … SET status='CANCELLED' WHERE id=:x AND status='ACTIVE'` — 1 row ⇒ acknowledged; 0 rows ⇒ lost, reported as lost, never as cancelled. PG's conflicting-update serialization (wait + predicate recheck) means exactly one transition wins; the harness lets the executor finish while the revoker waits (deadlock-free). Terminal states retained for the stated window for retries/reconciliation; ACTIVE/QUEUED are live states, never outcomes. **Heartbeat/lease contract (R5#1, δ-F7/F8):** the **executor renews** via `UPDATE … SET heartbeat_at = clock_timestamp() WHERE id=:x AND status='ACTIVE'` on a **separate reserved-capacity path** — either a dedicated unpooled connection or a distinct PgBouncer db/user pool with its own server-connection budget (δ-F7: renewals sharing the main pool can starve under load — long effects transactions hold every server connection, heartbeats queue, leases expire, healthy work gets fenced in a livelock; the control below runs at **concurrency ≥ pool size** to prove the reservation). Heartbeats never travel inside the effects transaction (invisible until commit). Cadence (e.g., 5 s); **lease ≥ 3× cadence + max scheduling delay**. Sweeper: `UPDATE … SET status='ABANDONED' WHERE id=:x AND status='ACTIVE' AND heartbeat_at < now() − lease` — conditional, competes safely with a live COMMITTED (exactly one wins; ABANDONED never rewrites a terminal state). **ABANDONED = lease loss = outcome unknown** (spec §4.4), explicitly *not* proven death; resubmission = fresh row/id. **Shutdown ordering (R6#2, δ-F8):** renewal scheduling stops **immediately before the conditional COMMITTED update is issued** (not earlier — a slow effects tail after the last renewal must never outlive the lease; the interval from the last renewal to acquiring the authority row lock is bounded and recorded); the completing transaction never awaits a renewal blocked by its own row lock — stop scheduling → resolve the effects transaction → drain outstanding renewals. **Race battery:** death-before-commit (ABANDONED after lease, zero effects) · commit-success-lost-reply (retry reads COMMITTED) · recovery-vs-live-commit (exactly one wins) · **healthy-long-execution control crossing the lease** (duration > 1× lease, sweeper active; independent connection asserts multiple durable heartbeat advances during uncommitted effects; COMMITTED with effects intact; renewal-suppressed variant MUST fail) · **healthy control at concurrency ≥ pool size** (δ-F7: no starvation fencing) · **queued-longer-than-lease** (δ-F6: QUEUED work is never abandoned) · heartbeat-behind-commit boundedness (deterministic placement behind the uncommitted COMMITTED update; bounded completion asserted) · **second-executor takeover** (restored per δ-M2 — present in v7, dropped by the v8 rewrite): after an execution is settled (COMMITTED/CANCELLED/ABANDONED), a second executor holding the stale token attempts the conditional COMMITTED update → 0 rows → FENCED, zero effects, verified via independent connection. Renewal traffic recorded as ≈ `active executions / cadence` UPDATE tx/s (operations sizing; the schedule annex that would have consumed it is withdrawn, issue #15). Evidence label: transport + minimal-real-authority; full broker proof remains P2 acceptance | redesign; fencing non-negotiable |
| B3 | Backpressure real in both directions, at every queue | Named caps per buffer (pending-call map, per-connection partial-frame buffer, total buffered bytes); sustained **open-loop** overload until caps trip; RSS growth ≤64 MiB over ≥60 s | redesign flow control |
| B4 | Messages bounded | >1 MiB → typed error; incremental oversize (byte-by-byte past cap) and never-terminated frame rejected without unbounded buffering; malformed NDJSON kills only the offending child | redesign |
| B5 | Crash semantics clean | Child exit mid-call → pending calls typed errors; fencing token not reusable by the respawned child | redesign |
| B6 | Shared-channel integrity **and identity binding** (R2#5) | N children → one mux → kernel stub: responses route to the correct plugin identity; **flood bound is numeric (δ-F9):** under one child's sustained flood, a sibling's cancel frame is delivered with p99 ≤ 500 ms (measurement contract applies). **Hostile battery:** forged sibling `plugin_id` → rejected; credential mismatch → rejected; cross-child correlation-ID collision → rejected/isolated; stale credential after respawn → rejected. Identity is **stamped by the supervisor from the spawn-time credential before multiplexing** — child-supplied identity fields are untrusted hints (spec §4.3/§4.4 boundary) | redesign bridge |

**Measurement contract (R2#6):** concurrency and resource assumptions frozen (child count, in-flight window); latency measurement endpoints defined (send → supervisor ingress → child egress → return); environment recorded with a **pre-flight resource check** (a CPU-throttled runner invalidates the run); open-loop fixed-rate arrival model for *all* performance tests (closed-loop under-reports stalls); warm-up ≥5 s, window ≥60 s, ≥3 repetitions; **invalid-run outcome exists** — threshold failure under a violated environment assumption → rerun, not redesign. Deterministic correctness assertions stay environment-independent.

**Method:** plain Node 22 `child_process.spawn` + stdio pipes; bridge = length-prefixed mux over one socket pair (no TLS in spike). Adversarial children: ignore-cancel, flood, malformed-frame, never-terminating-frame, crash-mid-call, identity-forger. Harness written for promotion into the P2 conformance-suite skeleton.

## 5. Capacity annex — withdrawn (historical method)

**Withdrawn 2026-10-25 ([issue #15](https://github.com/tachkovsa/plerni/issues/15)).** Do not write `docs/plans/capacity-annex.md`. Do not score a nine-month bar. Deliverable 5 is [`../ROADMAP.md`](../ROADMAP.md). The method below is the text the review dispositions in §11 cite (§5.2, §5.6, human-maintainer routing). It is not an open task.

Historical method, as reviewed in v12. **Review routing, as written then:** the annex would have been reviewed at its PR time by a reviewer different from every material generator of *its* content (§9(a)) — and since β (method text), γ (adopted N1/N5 fixes), and δ (adopted F10 requirements) all have material authorship in this method, that reviewer would have been **the human maintainer**. That review does not take place, because the annex was withdrawn before it was written.

1. **Work packages from exit criteria:** P1/P2/P3 exit criteria (spec §15–16) → work packages with effort ranges in PRs + risk class. Spikes calibrate the cost model, not 15 subsystems.
2. **The stated team, stated (δ-F10a):** 1 human maintainer — assumption to confirm: ~20 h/week on review/escalation/policy, i.e. ~25–40 review events/week by risk class; agent fleet authoring throughput prior: 8–12 PRs/week *authored*, bounded by review capacity, not generation speed. Priors are recorded as priors. **Telemetry that replaces them, pinned (γ-N1):** for every P0 PR the annex collects (i) cycle time open→merge, (ii) review round-trip hours, (iii) CI run durations per job (the §5 CI model's inputs), and (iv) rework ratio (revisions per PR) — a stated collection sheet, not "whatever seems measurable".
3. **Service capacity:** maintainer review service-rate by risk class is a first-class constraint (turnaround ≠ throughput).
4. **Critical path** named explicitly; parallel tracks fill around it.
5. **Calendar honesty:** maintenance per spec §14 as 10–15% **of calendar time** — the formula is stated: `calendar = feature_weeks / 0.85` (δ-F10c; 32–40 feature weeks → **37.6–47.1 calendar weeks = 8.7–10.8 months**). Review round-trips and pilot external wait are calendar time.
6. **Decision rule for a range straddling the bar (δ-F10b):** the annex reports the P50 and the **P80 estimate**; the bar is met iff **P80 ≤ 9 months**. A point estimate inside the range never claims the bar. **Aggregation method pinned (γ-N5):** per-package effort distributions → joint distribution via Monte Carlo (10,000 samples) under a stated independence assumption between work packages; P80 read off the joint distribution of total calendar weeks (the correlation caveat is written next to the number — never silently independent if the telemetry shows coupling). If P80 > 9: Class-A cuts, then maintainer-approved Class-B amendments, else the annex reports the gap.
7. **CI consumption model (R2#7 + R3#4):** aggregate runner-minutes over **all workflow invocations**: (merged + non-merging/abandoned PRs) × mean revisions × mean job-minutes + post-merge runs + retries. Recalculated band (arithmetic verified by two reviewer families): 20 PR attempts/week × 4 runs × 45 min = **3,600 min/week**; post-merge 10 × 45 = 450 min/week; total ≈ **4,050 min/week ≈ 17,500 min/calendar-month** (×4.33). Public-repo honesty: minutes unmetered on public repos; the real constraint is the **concurrency ceiling and queueing** (~20 concurrent jobs), modeled as elapsed-time risk. All bands are **scenarios** until bounded by measured CI telemetry collected from P0's own PRs.
8. **Cut ladder v4 (R2#8 + R3#5 — two classes, honestly separated):**
   - **Class A — criteria-preserving cuts** (each mapped to the binding criteria it provably leaves intact): conformance-suite language coverage reduced to TypeScript-only fixtures (reviewer-verified clean, *provided* required workflows stay covered). **Honest finding from the review: Class A is nearly empty** — spec §11 explicitly binds the audit *and* error *and* job/outbox-health viewers, and §15 P2 already says only "minimal author docs" (no savings vs spec). The annex must not manufacture Class A savings.
   - **Class B — spec-amendment cuts** (priced but **never counted by default**; each requires an explicit maintainer-approved spec edit before entering the arithmetic): MCP write tools P3→P4 (amends §16.11/16 MCP replay); single AI provider adapter (amends §15 P3 contents); declarative-UI widget deferral (amends §16 acid test); admin viewers reduced to audit-only (amends §11's three-viewer requirement — and any such amendment must still preserve §16.16 admin reflection/confirmation and §16.18 operator-visible recovery).
   - **If Class A alone doesn't fit the bar, the annex reports the gap honestly** — the options are maintainer-approved Class-B amendments or a failed bar, never silent scope erosion. Retaining the protected subsystems does not authorize dropping other hard invariants.

## 6. Contract conventions (deliverable 10) + Annex L (frozen in deliverable 1)

**Annex L — learning-interop workload freeze (in this plan; R1#15 clean; δ-F12 consumer named):**

| Assumption | Frozen value | Used by |
|---|---|---|
| xAPI statement payload | JSON, 0.5–4 KiB typical, p99 ≤32 KiB | Spike A benchmark table shape — **owner: the Spike A benchmark's schema generator** (`gen-schema`, materializes this as the `plugin_lrs_statement` table; the rerun rule diffs against that generator's output) |
| Write rate class | 10⁴–10⁵ statements/hour/tenant (burst ×10) | Spike A volume class · **P1 retention sizing: the §4.5 parked-cursor backlog quota (30-day default) × this rate bounds the worst-case parked backlog if LRS ingest flows through the event log** — the concrete consumer that makes the freeze load-bearing |
| Retention class | durable, years — plugin-owned store, *not* the event log | keeps event-log retention honest |
| Event-envelope needs | tenant-scoped, semver-typed, keyset-paginated reads | conventions taxonomy |

The values are **frozen upon maintainer confirmation at plan merge** (the "draft" label ends there — an unconfirmed-but-called-frozen input is neither, δ-F12). Changing Annex L after Spike A starts invalidates affected results and forces a rerun.

`docs/specs/contract-conventions.md` (deliverable 10) fixes: one registry → REST/OpenAPI/MCP; four version axes + per-artifact "breaking" definition; error envelope with a **transport-neutral code set** (δ-F13: `CONCURRENCY_CONFLICT` is a *code*, its HTTP mapping is 409, and its MCP mapping — tool result `isError: true` with the code in the structured payload, not a JSON-RPC protocol error — is fixed now, since §16.19 requires identical behavior over REST and MCP and MCP read ships in P1); mandatory `next_step`; action classification `routine|sensitive|destructive` lint-verified; event taxonomy + semver namespacing reserved for interop adapters (no xAPI nouns in kernel contracts); the **executable no-AI workflow inventory** with its gate mechanism named (δ-F14): the inventory is a machine-readable registry (JSON in `packages/contracts` at introduction time), and a CI check — landing in P1 with the first workflows — verifies every inventory entry references an existing no-AI acceptance-test ID (compliance lives in code, spec §12; spec §12's table gains the row when the mechanism lands).

## 7. Gate fixtures for P0 exit

Spec §15 binds: "each P0 gate blocks its deliberately-bad fixture PR."

- **All six implemented gates** (secrets, private-markers, license-audit, kernel-purity, commit-policy, SCA) get a deliberately-bad fixture PR through the real PR → required-check path (opened, shown red, closed unmerged; links in the P0 exit note).
- **Fixture safety rule (δ-F17):** closed PRs keep `refs/pull/N/head` world-readable **forever** — so fixture content must be safe-permanent: random synthetics and patterns from the *governed* (repo-tracked) lists only. A private-markers fixture never uses `.private-markers.local` patterns — that would *publish* the maintainer's private marker (and CI wouldn't even block it: the local file is gitignored, so the gate can't see it — a leak without proof). Each fixture PR body states this rule was followed.
- **Two wiring defects found in review are tracked as plan tasks 13–14** (assignee: maintainer until delegated; issue links recorded in the P0 exit note once filed — the plan claims tracking, not completion, R2#9):
  - `secrets` CI negative check accepts **any nonzero exit**, including scanner failure — must assert the specific finding (fail-open risk; verified twice by reviewer reruns: gate-health 9 cases pass but cover 4 gates, no SCA fixture; `.github/workflows/p0-gates.yml` negative step accepts any failure).
  - gate-health suite lacks an **SCA fixture** — add one.

## 8. Task breakdown → GitHub issues (milestone: P0 Foundations)

1. `docs: P0 implementation plan` — this PR, incl. Annex L + review receipts.
2. `chore: dev harness — PG 18 + PgBouncer 1.26 txn, three datasources (incl. admin console), checkout hygiene, fencing-authority stub`.
3. `spike: DB invariant` (A1–A4, §3.0 diagnosis protocol).
4. `spike: typecheck benchmark` (A5: schema bands × frozen query corpus + drift fixtures).
5. `spike: IPC harness` (B1–B6 incl. mux channel + hostile identity battery).
6. `docs: spike verdict reports with evidence`.
7. `docs: contributor roadmap` — [`../ROADMAP.md`](../ROADMAP.md), linked from the README and CONTRIBUTING. Replaces the withdrawn capacity annex (issue #15). Not gated on spike verdicts.
8. `docs(adr): ADR-0002 ORM/data layer` (after A).
9. `docs(adr): ADR-0003 outbox + pg-boss`.
10. `docs(adr): ADR-0004 plugin isolation topology` (after B).
11. `docs(adr): ADR-0005 UI kit + token compiler` (incl. default-theme discovery input, §12).
12. `docs: contract conventions`.
13. `ci: secrets-gate negative check must assert the specific finding` (review-found defect).
14. `ci: gate-health SCA fixture` (review-found gap).
15. `test: fixture PRs for all six P0 gates` + `docs: P0 exit note`.

**Replacement-validation branch (binding, R1#16):** any flip verdict opens a replacement-validation track (Drizzle re-spike rerunning the invariant suite, or substrate redesign + re-spike) with a written note of the technical consequence. That note does not reopen a schedule model. P0 closes only on "green on the shipped substrate."

**Sequencing, corrected against the §1 dependency table (δ-F11), and against the 2026-10-25 withdrawal of task 7's old dependency:** 1 → {2, 7 (roadmap), 9 (ADR-0003), 11 (ADR-0005), 12 (conventions), 13, 14} — everything depending only on the plan starts immediately, in parallel; then 2 → (3,4) ∥ 5 → 6 → {8, 10 gated on verdicts} → 15. Task 7 does not sit on the spike chain. Gate-config tasks 13–14 unblock early (their defects are known today).

**Gate-config changes carry an approval artifact (δ-F16, model-routing.md:21; hardened per γ-N4 and γ-N7):** tasks 13–14 (and any gate-config change) commit a signed approval artifact alongside. Interim mechanism (the spec §4.6 machinery lands in **P2** — spec §15 P2 row, not P1; the interim lives until then): `scripts/gates/approvals/<date>-<slug>.json` carrying `{approver, scope_sha256_of_the_diff, timestamp}` **plus a detached signature over the canonical JSON** from the maintainer's pinned signing identity (public key committed at `scripts/gates/approvals/maintainer.pub` — a public key is public data, §0-safe). **CI verifies all three: presence, digest coverage of the gate diff, and cryptographic signature — always against the key at the PR's *base commit***, never the PR head (γ-N7: otherwise a PR replacing `maintainer.pub` verifies its own fabricated artifact). Any change to `maintainer.pub` is itself a gate-config change: **rotations** require an artifact signed by the **incumbent** key plus a human review receipt, no exceptions. **Key genesis (γ-R1, clarified):** the maintainer commits `maintainer.pub` in the T1 plan PR (before any gate-config PR exists); genesis is the one change to `maintainer.pub` with no incumbent — it carries the human review receipt instead of an incumbent signature (the T1 PR is reviewed by the maintainer anyway). If a gate-config PR's base commit has no key, CI **fails closed — no fallback to the head key**, ever. The permanent §4.6 mechanism replaces this in P2 and the interim is retired then, not earlier.

## 9. Review protocol for this plan

- Author: α. **Family separation, precisely applied (δ-F15, γ-N8):** the generator test is **material authorship of adopted content** (§9(d) below); "carries a reviewer's edits" alone does not make one (otherwise every reviewed document would exclude its own reviewers). β materially *authored* plan content (the §12 theme consultation; B2's transport-check citations), so: (a) the **capacity annex** was going to be authored later, by α, as deliverable 5, and reviewed at its PR time by a reviewer different from every material generator of *its* content; β, γ, and δ all have material authorship in this §5 method (authored text and adopted fixes), so that reviewer would have been **the human maintainer** — issue #15 withdrew the annex before authorship, and that review does not take place; (b) **ADR-0005**'s reviewer is not β; (c) the δ-originated edits in v8 and β-originated §12 content are covered by a non-β, non-δ review — **γ reviewed v8/v9**; (d) a reviewer whose suggested fix text is adopted materially becomes a generator of that text — the next revision's reviewer is chosen accordingly.
- **Receipt fields (δ-F18: receipts bind commits, not files):** reviewed **git head SHA** (the commit — a file hash does not cover the PR's other files) · reviewer role · **accountable sponsor** (the human maintainer) · verification summary · outcome · opaque evidence ID · family-separation assertion per the rules above. Where the reviewed artifact is an uncommitted working document (as during this plan's drafting), the content SHA-256 is recorded *in addition*, and the commit-SHA receipt is bound at PR time.
- New commits after a review invalidate the receipt; refreshed on the final head.
- Trail: β rounds 1–7 on v1…v7 (20/10/5/3/3/2 → ACCEPT on v7, SHA-256 `37e4d348…`); δ blind pass on v7 (18 → ACCEPT WITH CHANGES → v8) + one regression catch while reviewing the derived document (§11.11); γ passes on v8 (6 → ACCEPT WITH CHANGES → v9), v9 (3 → v10), v10 (2 → v11), v11 (2 → v12).

## 10. What this plan deliberately does NOT do

- No schema design (blocked on Spike A by D06).
- No SDK API design (P2).
- No SCORM/xAPI/LTI/LRS implementation (plugins, later phases; P0 freezes only Annex L).
- No AI gateway work (P3; the executable no-AI rule lands in P0).
- No Valkey/S3 in the harness.
- No schedule model and no capacity annex (withdrawn, issue #15; see the amendment at the top). Deliverable 5 is the contributor roadmap.

## 11. Review dispositions

### 11.1 Round 1 (β, v1) — 20 findings, all addressed in v2

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| 1 | BLOCKER | A2/A3 NULL-oracle rejects correct behavior | Fixed (v2): normalized-absent oracle + behavioral assertion; contaminated-baseline test |
| 2 | BLOCKER | GUC-forgery assumes nonexistent PG privilege boundary | Fixed (v2): battery moved to admission boundary; non-denial documented |
| 3 | MAJOR | A4 conflates protocols; per-backend view misses | Fixed (v2): outbound-name instrumentation; extended-protocol benchmark |
| 4 | MAJOR | A5 table-count-only gameable | Fixed (v2): query corpus × scaling, frozen flags, raw-SQL baseline |
| 5 | MAJOR | Committed codegen ≠ drift-proof | Fixed (v2): regenerate+diff gate, two drift fixtures |
| 6 | MAJOR | Verdict labels precede causality | Fixed (v2): §3.0 diagnosis protocol |
| 7 | BLOCKER | Fencing mock can't prove commit-time invariant | Fixed (v2): PG-backed authority, commit-race test |
| 8 | MAJOR | B3/B4 bounded-looking tests of unbounded impls | Fixed (v2): per-queue caps, open-loop overload, incremental/never-terminated frames |
| 9 | MAJOR | Shared channel excluded | Fixed (v2): B6 mux added |
| 10 | MAJOR | Perf numbers without environment | Fixed (v2): measurement contract |
| 11 | BLOCKER | 9-month bar not answerable | Fixed (v2): acceptance-linked work-package method |
| 12 | MAJOR | No maintenance/calendar allowance | Fixed (v2): +15% → 37.6–47.1 calendar weeks stated |
| 13 | MAJOR | CI-minutes multiplier missing | Fixed (v2): aggregate runner-minutes bands |
| 14 | BLOCKER | Cut ladder counted deferred scope | Fixed (v2): ladder rebuilt on current scope |
| 15 | MAJOR | Workload spec after its consumer | Fixed (v2): Annex L freeze + rerun rule |
| 16 | BLOCKER | Flip closes P0 unproven | Fixed (v2): replacement-validation branch binding |
| 17 | MAJOR | LRS data vs delivery log conflated | Fixed (v2): plugin-owned durable store; Annex L workload-only |
| 18 | MAJOR | No-AI declaration gameable | Fixed (v2): executable no-AI inventory |
| 19 | BLOCKER | Gate-exit interpretation weakened requirement | Fixed (v2): fixture PRs for all six gates; two CI defects tracked |
| 20 | MINOR | Receipt missing sponsor | Fixed (v2): sponsor field added |

### 11.2 Round 2 (β, v2) — 10 findings, addressed in v3

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| 1 | BLOCKER | A2/A3 oracle still incoherent (valid-B rejected; contamination lifecycle unspecified) | Fixed (v3): three distinct cases (clean-deny / valid-context positive control / contaminated reuse); checkout hygiene rule discards contaminated connections; PG session-restore + PgBouncer no-reset behavior explicitly modeled |
| 2 | MAJOR | A4's `max_prepared_statements` fallback can't help unnamed traffic | Fixed (v3): fallback removed; overhead >20% opens separately-validated A4b named-statement branch |
| 3 | MAJOR | A5 lacks query-count scaling / corpus size | Fixed (v3): frozen corpus 5×N per band, complexity bands S/M/L, recorded justification (5× headroom over P1 kernel estimate) |
| 4 | BLOCKER | B2 race oracle undefined (deadlockable lock shape; ordering unassumed) | Fixed (v3): atomic conditional-write fencing (check = write predicate), ack point defined, both orderings asserted via independent connection |
| 5 | MAJOR | B6 routing without identity binding | Fixed (v3): hostile battery (forged identity, credential mismatch, correlation collision, stale credential); supervisor-stamped identity before mux |
| 6 | MAJOR | B measurement contract permits environmental false failures | Fixed (v3): frozen concurrency/resources, defined latency endpoints, pre-flight resource check, invalid-run outcome, open-loop for all perf tests |
| 7 | MAJOR | CI projection excludes never-merged work | Fixed (v3): model covers non-merging attempts + retries; bands labeled scenarios until measured telemetry |
| 8 | BLOCKER | Cut ladder breaks binding acceptance criteria | Fixed (v3): Class A (criteria-preserving, mapped to §16) vs Class B (spec-amendment, maintainer sign-off required, never counted by default); honest gap reporting |
| 9 | MAJOR | Gate defects claimed owned without evidence | Fixed (v3): tasks 13–14 with assignee; plan claims tracking not completion; reviewer rerun evidence recorded |
| 10 | MAJOR | §3.0 PgBouncer evidence via wrong datasource | Fixed (v3): read-only admin-console connection; SHOW CONFIG/DATABASES/USERS tied to tested endpoint/db/role; PG settings via test transaction |

Round-2 review also confirmed clean: D10 sequencing, D13/D14 ADR boundary, Annex L ordering/rerun rule, durable LRS ownership, executable no-AI acceptance, replacement-validation branch, sponsor field.

### 11.3 Round 3 (β, v3) — 5 findings, addressed in v4

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| 1 | BLOCKER | Checkout hygiene: client-pool checkout ≠ PgBouncer backend checkout; "discard" physically meaningless | Fixed (v4): baseline assertion moved **inside the pinned transaction** (same backend guaranteed); contaminated backend physically removed via `pg_terminate_backend(pg_backend_pid())` (role may terminate own backend; PgBouncer evicts the dead connection); alert + bounded retry ≤2; first-use/default-injected contamination covered; A2(c) absence check runs on the replacement session; cleanup cost measured in benchmarks |
| 2 | BLOCKER | B2 serializes effects but lacks outcome arbitration | Fixed (v4): authority row carries `status ∈ {ACTIVE, COMMITTED, CANCELLED}`; both actors use conditional transitions on `ACTIVE`; PG conflicting-update serialization (wait + predicate recheck) makes exactly one win; cancellation ack ⇔ its own transition won; lost cancellation reported lost, never cancelled; lost-commit-reply retries read durable status; harness lets the executor finish while the revoker waits (row-lock blocking exercised, deadlock-free) |
| 3 | MAJOR | A5 headroom arithmetic false (400/15 = 26.7×, not 5×); S/M/L distribution unfrozen | Fixed (v4): corrected arithmetic — 5× headroom = 75 tables / 300–400 queries = the **acceptance point** where the ceiling binds; 200/400 bands demoted to **stress points** (curve characterization, diagnosis on overrun, no auto-fallback); S/M/L distribution frozen at 3:1.5:0.5 with per-band floors M≥20, L≥10 |
| 4 | MAJOR | CI example arithmetically wrong (weekly figure stated as monthly) | Fixed (v4): recomputed — 20 attempts × 4 runs × 45 min = 3,600/week; +450 post-merge; ≈4,050/week ≈ 17,500/calendar-month; added public-repo honesty (minutes unmetered; concurrency/queueing is the real constraint) |
| 5 | MAJOR | Class A counted a spec-bound cut (§11 binds three viewers) | Fixed (v4): viewer reduction moved to Class B (with §16.16/§16.18 preservation clause); Class A honestly near-empty (TS-only conformance fixtures, reviewer-clean); annex forbidden from manufacturing Class A savings |

Round-3 review verified resolved (no finding): A4b branch (R2#2), B6 identity battery (R2#5), measurement contract invalid-run outcome (R2#6), CI formula coverage of unmerged work (R2#7 formula), Class B amendment discipline (R2#8), gate-defect tracking wording (R2#9), admin-console datasource (R2#10).

### 11.4 Round 4 (β, v4) — 3 findings, addressed in v5

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| 1 | BLOCKER | Baseline inspection unexecutable: `current_setting` returns the *effective* value — a transaction-local override masks the session value; custom GUCs not enumerable via `pg_settings` | Fixed (v5): ordered statement protocol in §2 — inspect explicitly named context GUCs **before** any local override (effective = session at that point), terminate-if-contaminated, then install local context **and verify it reads back as the authorized tenant**, then tenant access |
| 2 | MAJOR | Crashed executions stuck ACTIVE forever (death between effects and COMMIT → rollback → no settlement owner) | Fixed (v5): `heartbeat_at` + named recovery owner (supervisor sweeper) + conditional `ACTIVE→ABANDONED` settlement gated on expired lease (competes safely with live COMMITTED; never rewrites terminal states); ABANDONED = outcome-unknown per spec §4.4; resubmission = fresh row; terminal rows retained for a stated window; three new race cases (death-before-commit, lost-reply, recovery-vs-live-commit) |
| 3 | MINOR | Fractional queries in frozen corpus (M=112.5 at N=75) | Fixed (v5): integer allocation rule S=3N, M=⌊1.5N⌋, L=5N−S−M (remainder → L); acceptance band frozen as S=225, M=112, L=38 = 375 |

Round-4 review verified resolved (no finding): live-race arbitration (R3#2), CI arithmetic 4,050/week ≈ 17,536.5/month (R3#4), Class A honesty + viewer cut to Class B (R3#5); additional checks clean: self-termination permissions, PgBouncer 1.26 eviction at source level, no top-band dependency, public-repo CI qualification.

### 11.5 Round 5 (β, v5) — 3 findings, addressed in v6

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| 1 | MAJOR | Crash settlement without a heartbeat/lease contract fences *healthy* long executions (heartbeat expires mid-transaction, sweeper wins) | Fixed (v6): full contract — heartbeat initialized at submission; executor renews on a **side connection** (in-transaction heartbeats invisible until commit = useless); cadence 5 s, lease ≥ 3× cadence + max scheduling delay; renewal conditional on ACTIVE; healthy-long-execution positive control added; lease loss explicitly ≠ proven death (ABANDONED = outcome-unknown, §4.4) |
| 2 | MAJOR | Integer rewrite deleted the S/M/L shape definitions (regression) | Fixed (v6): shapes restored alongside the allocation rule — S single-table CRUD; M 2–3 joins + optional predicates + keyset; L CTE + conditional composition + generic helpers |
| 3 | MINOR | ABANDONED missing from B2's legal states and retention set | Fixed (v6): state set `{ACTIVE, COMMITTED, CANCELLED, ABANDONED}` consistent between §2 and B2; all terminal states retained for the retry/reconciliation window |

Round-5 review verified resolved (no finding): ordered GUC inspection protocol (R4#1 — incl. the same-tenant SESSION attack: a pre-existing SESSION value fails the step-② absence check even when it equals the authorized tenant), integer allocation at all bands (R4#3).

### 11.6 Round 6 (β, v6) — 2 findings, addressed in v7

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| 1 | MAJOR | Positive control need not exercise lease expiry (cadence 5 s / lease 20 s / duration 11 s passes with renewals fully disabled) | Fixed (v7): control runs **past the configured lease** (duration > 1× lease, sweeper active); independent connection asserts multiple durable heartbeat advances during uncommitted effects, then COMMITTED with effects intact; renewal-suppressed variant must fail |
| 2 | MAJOR | Heartbeat shutdown can deadlock application completion against the executor's own row lock (invisible to PG's deadlock detector) | Fixed (v7): shutdown ordering — stop scheduling renewals → resolve effects transaction → drain outstanding renewals; completion never awaits a renewal blocked by its own transaction; deterministic heartbeat-behind-COMMITTED test asserts bounded completion |

Round-6 review verified resolved (no finding): S/M/L shapes restored (R5#2), ABANDONED lifecycle consistency (R5#3); additional checks clean: PgBouncer backend reassignment for side-channel heartbeats, READ COMMITTED visibility of renewals, terminal-state resurrection impossible (conditional recheck). Renewal traffic (≈ active/cadence UPDATEs/s) recorded as capacity-annex input.

### 11.7 δ blind pass (v7) — 18 findings, addressed in v8 (δ verdict: ACCEPT WITH CHANGES)

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| F1 | MAJOR | Hygiene check only inspects `plerni.*` GUCs; leaked `SET ROLE` / `search_path` survive transaction-mode reuse (cross-plugin privilege path via plugin-role membership) | Fixed (v8): step ② also asserts `current_user = session_user` and pinned `search_path`; battery #3 injects all three contamination classes |
| F2 | MINOR | ② didn't normalize `''` → warm backends self-terminate, pool thrash | Fixed (v8): NULLIF normalization at ②; benchmark asserts terminations == injected contaminations |
| F3 | MINOR | A4b unrunnable at `max_prepared_statements = 0` | Fixed (v8): A4b runs with the value > 0 and reruns A1–A3 under that config |
| F4 | MAJOR | A5 corpus type escape hatches not banned (`sql<T>`, `as`/`any`, explicit generics, `$castTo` → inference cost hidden) | Fixed (v8): corpus lint bans escape hatches; every query carries a type-level inferred-row assertion |
| F5 | MINOR | Battery 4(a) tests a parser P0 doesn't build | Fixed (v8): labeled prototype evidence scoped to "classifier shape"; real proof = P2 §16.13 |
| F6 | MAJOR | Queued work fenced before starting (ACTIVE from submission; renewals start at dispatch) | Fixed (v8): `QUEUED` state; sweeper ignores QUEUED; dispatch stamps heartbeat; queued-longer-than-lease case added |
| F7 | MAJOR | Renewals share the pool with effects transactions → starvation livelock under load | Fixed (v8): reserved-capacity renewal path (dedicated connection or separate PgBouncer pool); healthy control at concurrency ≥ pool size |
| F8 | MINOR | Shutdown stop point unpinned (slow tail can outlive lease) | Fixed (v8): renewal stops immediately before the conditional COMMITTED update; last-renewal→lock interval bounded |
| F9 | MINOR | B6 flood bound had no number | Fixed (v8): sibling cancel p99 ≤ 500 ms under sustained flood |
| F10 | MAJOR | Capacity method can't answer the bar (team never stated; no range decision rule; +15% formula mismatch; tiny calibration sample) | Fixed (v8): team + throughput priors stated and replaced by P0 telemetry; decision rule = P80 ≤ 9 months; formula `calendar = feature / 0.85` stated |
| F11 | MINOR | §8 order contradicted §1 dependencies (9/11/12/13/14 scheduled late) | Fixed (v8): corrected order starts all plan-dependent work in parallel after task 1 |
| F12 | MINOR | Annex L had no real consumer; "draft but frozen" contradiction | Fixed (v8): consumer named (§4.5 parked-cursor quota × rate → P1 retention sizing); values freeze at maintainer confirmation on plan merge |
| F13 | MINOR | Error envelope HTTP-only | Fixed (v8): transport-neutral codes + MCP mapping fixed in conventions now |
| F14 | MINOR | "Executable" no-AI inventory had no gate | Fixed (v8): machine-readable registry + CI check landing in P1; spec §12 gains the row then |
| F15 | MAJOR | Family separation violated (β generated §12 content + B2 citations, yet reviewed the plan) | Fixed (v8 §9): annex → γ/human review only; ADR-0005 reviewer ≠ β; v8 reviewed by γ; reviewer-as-generator rule stated |
| F16 | MAJOR | Tasks 13–14 (gate-config) skipped the signed-approval rule | Fixed (v8 §8): interim maintainer-signed approval artifact (JSON + digest), permanent §4.6 mechanism lands in P1 |
| F17 | MAJOR | Fixture PRs publish content forever via `refs/pull/*`; a `.private-markers.local` fixture would leak the private marker without proving anything | Fixed (v8 §7): fixture safety rule — governed/synthetic content only; stated in each fixture PR body |
| F18 | MINOR | Receipts bound to file hash, not commit | Fixed (v8 §9): receipts bind the git head SHA; content SHA-256 only as a drafting-stage supplement |

δ also confirmed clean (no finding): lease formula, side-connection visibility, ABANDONED semantics, terminal-state immutability, self-termination, A1–A3 oracles, B3/B4 caps; and live-verified that PostgreSQL 19 is still beta (PG 18 harness choice holds).

### 11.8 γ pass (v8) — 6 findings, addressed in v9 (γ verdict: ACCEPT WITH CHANGES)

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| N2 | MAJOR | §5 still routed annex review to "β or γ" — contradicts §9(a) family separation (β materially shaped the annex method) | Fixed (v9 §5): annex review = γ or the maintainer, never β; the stale remnant removed |
| N4 | MAJOR | Interim approval artifact verified presence+digest but never the signature (fail-open: fabricated artifact binds no one); interim retirement mis-scheduled to P1 (spec lands §4.6 in P2) | Fixed (v9 §8): CI verifies presence + digest + cryptographic signature against the maintainer's pinned public key (`scripts/gates/approvals/maintainer.pub`); retirement corrected to P2 |
| N1 | MINOR | Telemetry replacing throughput priors unpinned ("T1/T2 cycle times", undefined "§5.5") | Fixed (v9 §5.2): pinned collection sheet — per-PR cycle time, review round-trip hours, per-job CI durations, rework ratio |
| N3 | MINOR | Pinned `search_path` value and its establishment never stated (cold-start backends would fail ② en masse) | Fixed (v9 §2): the harness installs the pinned value as the app role's `ALTER ROLE … SET search_path` default; ② compares against exactly that; misinstall is caught at bring-up by the terminations==injected assertion |
| N5 | MINOR | P80 aggregation method unstated (sum-of-P80s vs joint distribution flips the verdict) | Fixed (v9 §5.6): joint distribution via Monte Carlo (10,000 samples) with a stated independence assumption + correlation caveat |
| N6 | MINOR | Battery 4(a) misattributed the real proof's phase (§16.13 is P3 acceptance; tenancy-gate forgery row is §12/P1) | Fixed (v9 §3.2.4): machinery P2, tenancy-gate suite P1, §16.13 acceptance P3 |

γ verified resolved in operative text (not merely claimed): δ's F1–F14, F17, F18 — B2 state machine, hygiene protocol, A5 contract, and measurement contract internally consistent and spec-aligned.

### 11.9 γ confirmation (v9) — 3 findings, addressed in v10 (γ verdict: ACCEPT WITH CHANGES)

| # | Sev | Finding (short) | Disposition |
|---|---|---|---|
| N7 | MAJOR | Signature anchor mutable by the PR under verification (replace `maintainer.pub` in the same PR → verifies its own fabricated artifact) | Fixed (v10 §8): CI verifies against the key at the PR's **base commit**, never the head; changing `maintainer.pub` is itself a gate-config change requiring an incumbent-key-signed artifact + human receipt (rotation ceremony) |
| N8 | MINOR | "Carries its edits → generator" rationale self-undetermined (would exclude γ too) | Fixed (v10 §9): generator = material authorship of adopted content; annex reviewer chosen at annex PR time against that rule |
| N9 | MINOR | Annex L's materialization owner referenced an undefined task ID | Fixed (v10 §6): owner named in plan terms — the Spike A benchmark's schema generator |

γ's regression check on v9: no finding — nothing previously resolved was disturbed by the v9 edits.

### 11.10 γ final confirmation (v10) — 2 residuals, addressed in v11 (γ verdict: ACCEPT WITH CHANGES)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R1 | MINOR | Key genesis unstated (base commit without a key would force an ad-hoc head-fallback — reinstating N7) | Fixed (v11 §8): the maintainer commits `maintainer.pub` in the T1 plan PR; no key at base ⇒ CI fails closed, no fallback ever |
| R2 | MINOR | §5 still carried the rejected "carries its edits" generator test and hard-routed the annex to γ — contradicting the corrected §9 | Fixed (v11 §5): β's exclusion grounded in β-*authored* method text; reviewer chosen at annex PR time per §9(a) |

γ's regression check on v10: no finding. N7 verified resolved (base-commit anchor + fail-closed rotation), N9 verified resolved.

### 11.11 Late catch (δ, while reviewing the derived detailed plan against v9) — 1 finding, addressed here

| # | Sev | Finding | Disposition |
|---|---|---|---|
| δ-M2 | MAJOR | The v8 B2 rewrite silently dropped v7's "queued work + second-executor cases included" tail (queued work survived as queued-past-lease; second-executor takeover vanished) | Fixed: second-executor takeover case restored to the B2 race battery (settled row + stale-token commit attempt → 0 rows → FENCED, zero effects, independent connection) |

Lesson recorded: full-row rewrites during review rounds are regression-prone — the disposition tables now require the reviewer to diff operative text, not just read the tables (γ already does this; the check caught this class explicitly).

### 11.12 γ confirmation (v11) — 2 residuals, addressed in v12 (γ verdict: ACCEPT WITH CHANGES)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R1 | MINOR | Genesis wording contradiction: "any change to maintainer.pub needs an incumbent signature" makes genesis unmeetable | Fixed (v12 §8): the incumbent-key rule applies to rotations; genesis carries the human review receipt |
| R2 | MINOR | §9(a) still named γ as an annex reviewer, though γ's adopted N1/N5 text makes it a material generator of the method | Fixed (v12 §5/§9(a)): all three agent families have material authorship in the method → the annex's reviewer is **the human maintainer** |

γ's regression check on v11 (diff-scope): no finding.

## 12. Addendum — default-theme discovery (feeds ADR-0005, not a P0 blocker)

Maintainer direction 2026-10-13: default theme enterprise-credible **without** default corporate blue; CIS-primary; theming machinery already architected (spec §9/D14) — discovery decides defaults = brand face. β consultation produced three palette directions with anchor hex values, WCAG-AA measurements, CIS cultural checks, and differentiation analysis; recommendation: **Scholarly Plum** (light primary `#6E3F73`) with a cheap validation path (token compiler → antd `ConfigProvider` on the future fixture gallery; light/dark × long-RU-labels; ranking test with 2 procurement + 2 learning admins + 2 developers). Alternatives: Deep Teal `#0F766E`, Burnished Copper `#A44727`. Final choice is the maintainer's; outcome lands as an ADR-0005 input note.
