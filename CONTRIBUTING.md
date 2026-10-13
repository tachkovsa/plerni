# Contributing to Plerni

## Legal

All contributions are made under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). By including a `Signed-off-by:` line in your commit you certify that you wrote or otherwise have the right to submit the contribution under the Apache-2.0 license, including contributions made with AI assistance. **DCO sign-off is human:** an agent cannot certify the DCO for you; squash merges must preserve applicable human sign-offs and contributor attribution. Sign-off is distinct from a cryptographic commit signature.

Commits containing substantial AI-generated or AI-rewritten code, tests, configuration, or documentation carry the trailer `AI-assisted: yes`. Spelling, formatting, and incidental research assistance need no disclosure. Never publish development-tool, provider, or model identities in contribution metadata (AGENTS.md §0). You remain responsible for correctness, licensing, and responding to review.

## Commits & PRs

- PR titles and commits retained on the default branch (`dev`) follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Each retained commit is one coherent, independently revertible change; tests and documentation ride with it. For nontrivial changes the body explains the problem, why this solution, spec/issue references, and verification performed; trivial changes need no body.
- **Squash merge is the default**, for humans and agents alike. Split unrelated outcomes into separate PRs. A multi-commit series is preserved only by explicit maintainer exception, when its history helps review or bisection. **The PR title and body become the squash commit message** (repository setting) — write the PR body as the final commit message: summary and evidence first, the `AI-assisted:` trailer as the last line; GitHub appends the sign-off.
- One PR delivers one coherent outcome. Aim for at most 400 changed handwritten lines including tests and docs; above 800, split the change or record a maintainer-approved explanation. Generated files and lockfiles count separately and still get reviewed. These are review guidelines, not correctness guarantees.
- Trunk-based: short-lived branches; draft PRs early (drafts are for work in progress; ready PRs carry complete scope and verification evidence). Auto-merge is maintainer-enabled per PR after review.
- Project-authored source files carry `SPDX-License-Identifier: Apache-2.0` (files without comment syntax are covered by `REUSE.toml`).

## Process

1. **Spec first for capabilities.** New capabilities start as a spec in `docs/specs/` (problem, contract, acceptance criteria), then a plan, then tasks. Bug fixes, documentation corrections, and maintenance may reference the existing contract and a scoped issue; small corrections may use the PR description as their task record.
2. **TDD where it pays.** Kernel services, contract logic, and domain rules are written red-green. Every feature ends with its role-chain walkthrough (spec §12).
3. **ADRs.** Any decision a future contributor would otherwise reverse-engineer gets an ADR in `docs/adr/`.
4. **Gates.** `pnpm run gates` locally before pushing; CI enforces the same plus PR-context checks (see the gate-status note in spec §12). Gates are fail-closed and proven by negative fixtures — if you change a gate, add a fixture.
5. **Docs.** A behavior change updates its doc in the same PR (doc-coupling gate).
6. **Workspace structure.** One manifest per workspace boundary. If plugins ever split into server/UI packages, the glob becomes `plugins/*/*` and parent manifests are removed — never a blanket `plugins/**`.

## Review

High-risk changes (authorization, tenancy, cryptography, plugin admission, migrations, CI/gates, release credentials, policy changes) require verification by a human or an agent of a different model family than every generator, recorded as a revision-bound review receipt — rules in `docs/ai/model-routing.md`. AI review findings elsewhere are advisory; mechanical gates and required approval artifacts block.

## Conduct

Be direct, be factual, assume competence. The [Code of Conduct](CODE_OF_CONDUCT.md) applies; report unacceptable behavior per it (see also GOVERNANCE.md).
