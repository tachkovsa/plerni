# Plerni

**The open-source, AI-first skills and learning platform — a stable kernel, everything else a plugin.**

Plerni is a self-hostable LXP (Learning Experience Platform): competency/skill models, learning content, development goals, career-development workflows, mentorship — with an AI copilot in every workflow (AI proposes, humans commit) and every capability, including the ones we ship, built as a plugin on one public SDK.

## Status

**P0 — Foundations.** There is nothing to run yet. The current state of the design lives in:

- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what Plerni is, the phases, and where to help (plain language; start here)
- [`docs/specs/2026-10-12-plerni-design.md`](docs/specs/2026-10-12-plerni-design.md) — the full product & architecture specification (adversarially reviewed across four independent model families, pseudonymized per AGENTS.md §0)
- [`docs/decision-register.html`](docs/decision-register.html) — 32 architectural decisions with rationale, evidence, and flip conditions (open in a browser)
- [`docs/adr/`](docs/adr/) — architectural decision records
- [`docs/reviews/`](docs/reviews/) — integrity manifest of the adversarial review transcripts the design survived (transcripts retained privately per AGENTS.md §0)

## License

Apache-2.0 (see LICENSE). Plerni was founded by **Sergei Tachkov** (see NOTICE). Redistributions must preserve applicable notices as required by Apache-2.0 §4.

## Principles (short form)

- Equal plugin citizenship: first-party and third-party plugins share one SDK and one admission pipeline
- API-first: every capability is reachable via REST/OpenAPI and MCP; the shell is just another client
- Multi-tenant from commit #1 (PostgreSQL RLS); one artifact for on-prem appliance and SaaS
- Compliance lives in code, not in prompts: every convention that can be mechanized is a CI gate
- "Done" is never taken on faith; nobody is trusted by default — in either direction
- Apache-2.0; human DCO sign-off is not required at the current stage; AI-assisted commits disclosed (`AI-assisted: yes`)

## Repository layout

```
apps/kernel/          # Hono API + kernel services (thin transport, Web-standard handlers)
apps/shell/           # React 19 + Vite SPA (FSD pragmatic variant, Ant Design, token compiler)
packages/contracts/   # zod schemas, event registry, port types — the ONLY shared code
packages/sdk/         # plugin SDK (v0 experimental with a stated support window)
plugins/              # first-party plugins (same SDK, same admission pipeline as third-party)
tools/cli/            # plugin scaffold / pack / sign / verify / install
e2e/                  # role-chain walkthroughs
onprem/               # appliance packaging (docker-compose, Helm later)
docs/                 # specs, ADRs, review transcripts, ai/ conventions
scripts/gates/        # CI gates (see docs/specs §12)
```

## Development

Node.js (see `.nvmrc`), pnpm (see `packageManager`). Bootstrap: `pnpm install && pnpm run gates` — expected: every gate prints OK (CI additionally runs the secrets scan, SCA, and PR-context checks such as commit-policy). Conventions: spec-driven development, TDD where it pays, ADR for any decision a future contributor would otherwise reverse-engineer — see spec §13 and CONTRIBUTING.md.
