# Contributing to Plerni

New here? Start with the [roadmap](docs/ROADMAP.md): what Plerni is, the phases, and the current [good first issues](https://github.com/tachkovsa/plerni/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22). People in HR, learning and development, and education technology can contribute without writing code.

## Legal

All contributions are made under the Apache-2.0 license. The [Developer Certificate of Origin](https://developercertificate.org/) remains the licensing standard, but **a `Signed-off-by:` line is not required at the current stage**, and the commit-policy gate does not check for one. A human may still add a sign-off; an agent does not certify the DCO. Sign-off is distinct from a cryptographic commit signature.

Commits containing substantial AI-generated or AI-rewritten code, tests, configuration, or documentation carry the trailer `AI-assisted: yes`. Spelling, formatting, and incidental research assistance need no disclosure. Never publish development-tool, provider, or model identities in contribution metadata (AGENTS.md §0). You remain responsible for correctness, licensing, and responding to review.

## Commits & PRs

- PR titles and commits retained on the default branch (`dev`) follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Each retained commit is one coherent, independently revertible change; tests and documentation ride with it. For nontrivial changes the body explains the problem, why this solution, spec/issue references, and verification performed; trivial changes need no body.
- **Squash merge is the default**, for humans and agents alike. Split unrelated outcomes into separate PRs. A multi-commit series is preserved only by explicit maintainer exception, when its history helps review or bisection. **The PR title and body become the squash commit message** (repository setting) — write the PR body as the final commit message: summary and evidence first, the `AI-assisted:` trailer as the last line.
- One PR delivers one coherent outcome. Aim for at most 400 changed handwritten lines including tests and docs; above 800, split the change or record a maintainer-approved explanation. Generated files and lockfiles count separately and still get reviewed. These are review guidelines, not correctness guarantees.
- Trunk-based: short-lived branches; draft PRs early (drafts are for work in progress; ready PRs carry complete scope and verification evidence). At the current stage an agent may merge a PR once its review is clean, every review thread is replied to and resolved, and CI is green. Human DCO sign-off is not a merge requirement.
- Project-authored source files carry `SPDX-License-Identifier: Apache-2.0` (files without comment syntax are covered by `REUSE.toml`).

## Process

1. **Spec first for capabilities.** New capabilities start as a spec in `docs/specs/` (problem, contract, acceptance criteria), then a plan, then tasks. Bug fixes, documentation corrections, and maintenance may reference the existing contract and a scoped issue; small corrections may use the PR description as their task record.
2. **TDD where it pays.** Kernel services, contract logic, and domain rules are written red-green. Every feature ends with its role-chain walkthrough (spec §12).
3. **ADRs.** Any decision a future contributor would otherwise reverse-engineer gets an ADR in `docs/adr/`. Acceptance follows `docs/ai/model-routing.md`. When every drafting family is known, the reviewer is a human or an agent from a different model family, and the receipt states that separation. When a drafting family is unknown, the maintainer decision of 2026-10-26 applies: the maintainer-designated assistant reviewer plus a clean Codex review of the exact head. That receipt names the head, states the rule, and carries no human-review claim and no family-separation claim.
4. **Gates.** `pnpm run gates` locally before pushing; CI enforces the same plus PR-context checks (see the gate-status note in spec §12). Gates are fail-closed and proven by negative fixtures — if you change a gate, add a fixture.
5. **Docs.** A behavior change updates its doc in the same PR (doc-coupling gate).
6. **Workspace structure.** One manifest per workspace boundary. If plugins ever split into server/UI packages, the glob becomes `plugins/*/*` and parent manifests are removed — never a blanket `plugins/**`.

## Review

High-risk changes (authorization, tenancy, cryptography, plugin admission, migrations, CI/gates, release credentials, policy changes) require verification by a human or an agent of a different model family than every generator when those families are known, recorded as a revision-bound review receipt — rules in `docs/ai/model-routing.md`. When the drafting model family is unknown, the maintainer decision of 2026-10-26 in that file applies: the maintainer-designated assistant reviewer plus a clean Codex review of the exact head is enough to accept an ADR or merge the pull request. A human review is not required on that path. The receipt names that exact head, states that the review was done under this maintainer rule, and carries no human-review claim and no family-separation claim. AI review findings elsewhere are advisory; mechanical gates block. Migration approval artifacts still apply (spec §4.6). The signed approval artifact for gate-config changes is waived at the current stage (owner decision, 2026-10-15; `docs/ai/model-routing.md`).

## Conduct

Be direct, be factual, assume competence. The [Code of Conduct](CODE_OF_CONDUCT.md) applies; report unacceptable behavior per it (see also GOVERNANCE.md).
