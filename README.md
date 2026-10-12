# Plerni

**The open-source, AI-first skills and learning platform — a stable kernel, everything else a plugin.**

Plerni is a self-hostable LXP (Learning Experience Platform): competency/skill models, learning content, development goals, career-development workflows, mentorship — with an AI copilot in every workflow (AI proposes, humans commit) and every capability, including the ones we ship, built as a plugin on one public SDK.

## Status

**P0 — Foundations.** There is nothing to run yet. The current state of the design lives in:

- [`docs/specs/2026-10-12-plerni-design.md`](docs/specs/2026-10-12-plerni-design.md) — the full product & architecture specification (multi-model reviewed: Kimi K3, GPT 6.1 "Sol", GLM 5.3, Claude Opus 5.5)
- [`docs/decision-register.html`](docs/decision-register.html) — 32 architectural decisions with rationale, evidence, and flip conditions (open in a browser)
- [`docs/adr/`](docs/adr/) — architectural decision records
- [`docs/reviews/`](docs/reviews/) — integrity manifest of the adversarial review transcripts the design survived (transcripts retained privately per AGENTS.md §0)

## License

Apache-2.0 (see LICENSE). Plerni was founded by **Sergei Tachkov** — see NOTICE: derivative works must carry founder attribution (Apache-2.0 §4(d)).

## Principles (short form)

- Equal plugin citizenship: first-party and third-party plugins share one SDK and one admission pipeline
- API-first: every capability is reachable via REST/OpenAPI and MCP; the shell is just another client
- Multi-tenant from commit #1 (PostgreSQL RLS); one artifact for on-prem appliance and SaaS
- Compliance lives in code, not in prompts: every convention that can be mechanized is a CI gate
- "Done" is never taken on faith; nobody is trusted by default — in either direction
- Apache-2.0, DCO, AI-assisted commits disclosed

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

Node.js (see `.nvmrc`), pnpm (see `packageManager`). Development conventions: spec-driven development, TDD where it pays, ADR for any decision a future contributor would otherwise reverse-engineer — see the spec §13.
