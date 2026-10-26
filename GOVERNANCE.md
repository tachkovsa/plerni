# Governance

## Roles

- **Maintainer** (founder): owns the gate policy, escalation rules, release authority, and periodic audits. Holds final say on ADRs.
- **Contributors** (human or agent): submit PRs under the rules in CONTRIBUTING.md. Agents may author changes, perform delegated reviews, and merge a PR once its review is clean, every review thread is replied to and resolved, and CI is green. Human DCO sign-off is not required at the current stage. Every contribution has an accountable human sponsor. The maintainer controls delegation policy and release authority.

## Decision-making

- Architecture decisions are recorded as ADRs in `docs/adr/` and require maintainer approval. Acceptance review follows `docs/ai/model-routing.md`, including the maintainer decision of 2026-10-26 for an unknown drafting family (assistant reviewer plus a clean Codex review of the exact head).
- New SDK capabilities or trust boundaries require an ADR before implementation (surface-area budget).
- Migration approval authority is defined by policy (currently: cross-family agent review with a signed approval artifact; see spec §4.6 and §13). The maintainer owns the policy.

## Escalation

Disagreements escalate to the maintainer. High-risk changes (authorization, tenancy, cryptography, plugin admission, migrations, CI/gates, release credentials, policy changes) require verification by a human or an agent of a different model family than every generator when those families are known, evidenced by a revision-bound review receipt (`docs/ai/model-routing.md`, principle 18); identities stay private per AGENTS.md §0. When the drafting model family is unknown, the maintainer decision of 2026-10-26 in that file applies: the maintainer-designated assistant reviewer plus a clean Codex review of the exact head is enough to accept an ADR or merge the pull request. A human review is not required on that path. The receipt names that exact head, states that the review was done under this maintainer rule, and carries no human-review claim and no family-separation claim. AI review findings elsewhere are advisory; mechanical gates block. Migration approval artifacts still apply (spec §4.6). The signed approval artifact for gate-config changes is waived at the current stage (owner decision, 2026-10-15; `docs/ai/model-routing.md`).

## Branch protection (dev — the default branch)

Configured on the remote and binding on everyone, administrators included: PR required; named checks (`p0-gates`) required and up to date before merge; conversations resolved; no ordinary force pushes or branch deletion. Human DCO sign-off is not a merge requirement at the current stage. An agent may merge a PR once its review is clean, every review thread is replied to and resolved, and CI is green. Native GitHub approval votes are **not** required while there is a single maintainer (authors cannot approve their own PRs) — the revision-bound review receipt and the maintainer's recorded merge decision carry the review weight; required approvals are added when a second maintainer joins. Exceptional recovery actions are documented publicly.

## Amendments

This file changes only via PR with maintainer approval.
