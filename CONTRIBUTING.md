# Contributing to Plerni

## Legal

All contributions are made under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). By including a `Signed-off-by:` line in your commit you certify that you wrote or otherwise have the right to submit the contribution under the Apache-2.0 license, including contributions made with AI assistance.

Commits that include AI-generated code must disclose it: `AI-assisted: author=<model> reviewer=<model-or-human>` in the commit trailer. Generation and verification must be done by different model families (or a human); see `docs/ai/model-routing.md`.

## Process

1. **Spec first.** Every feature starts as a spec in `docs/specs/` (problem, contract, acceptance criteria), then a plan, then tasks. No spec → no implementation PR.
2. **TDD where it pays.** Kernel services, contract logic, and domain rules are written red-green. Every feature ends with its role-chain walkthrough (spec §12).
3. **ADRs.** Any decision a future contributor would otherwise reverse-engineer gets an ADR in `docs/adr/`.
4. **Gates.** `pnpm run gates` locally before pushing; CI enforces the same. Gates are fail-closed and proven by negative fixtures — if you change a gate, add a fixture.
5. **Docs.** A behavior change updates its doc in the same PR (doc-coupling gate).

## Conduct

Be direct, be factual, assume competence. Report unacceptable behavior to the maintainers (see GOVERNANCE.md).
