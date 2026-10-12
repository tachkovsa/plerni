# AGENTS.md — rules for any AI agent working in this repository

Plerni is a **public** open-source repository. These rules are mandatory.

## 0. Public-repository data policy (the first rule)

This repo is public from day one. Anything committed is permanent and world-readable — treat every commit as publication.

**Never commit, embed, or reference:**
- Secrets of any kind: API keys, tokens, passwords, private keys, certificates, cookie values — real *or* "example-shaped" real ones. Key material enters via environment variables or the operator's secret store only.
- `.env*` files (gitignored), `temp/` (gitignored), session logs, scratch data, screenshots with real data.
- Real personal data: names, emails beyond the maintainer's public identity, employee records, customer data.
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
- **Generation ≠ verification** — different model families for author vs. reviewer on high-risk work; both recorded in the commit trailer (principle 18).
- File-size ratchet; small files, explicit responsibilities. ADR for any decision a future contributor would reverse-engineer.
- **Library research:** use Context7 MCP (see `.mcp.json`; key via `CONTEXT7_API_KEY` env) for library documentation and version checks instead of recalling versions from memory.

## 3. Process

Spec-driven development → plan → tasks; TDD where it pays; role-chain walkthrough per feature; conventional commits + DCO sign-off + `AI-assisted` trailer. See CONTRIBUTING.md and GOVERNANCE.md.
