# Governance

## Roles

- **Maintainer** (founder): owns the gate policy, escalation rules, release authority, and periodic audits. Holds final say on ADRs.
- **Contributors** (human or agent): submit PRs under the rules in CONTRIBUTING.md. Agents may author changes and perform delegated reviews; every contribution has an accountable human sponsor, and agents cannot certify the DCO. The maintainer controls delegation policy and release authority.

## Decision-making

- Architecture decisions are recorded as ADRs in `docs/adr/` and require maintainer approval.
- New SDK capabilities or trust boundaries require an ADR before implementation (surface-area budget).
- Migration approval authority is defined by policy (currently: cross-family agent review with a signed approval artifact; see spec §4.6 and §13). The maintainer owns the policy.

## Escalation

Disagreements escalate to the maintainer. High-risk changes (authorization, tenancy, cryptography, plugin admission, migrations, CI/gates, release credentials, policy changes) require verification by a human or an agent of a different model family than every generator, evidenced by a revision-bound review receipt (`docs/ai/model-routing.md`, principle 18); identities stay private per AGENTS.md §0. AI review findings elsewhere are advisory; mechanical gates and required approval artifacts block.

## Branch protection (main)

Configured on the remote and binding on everyone, administrators included: PR required; named checks (`p0-gates`) required and up to date before merge; conversations resolved; no ordinary force pushes or branch deletion. Native GitHub approval votes are **not** required while there is a single maintainer (authors cannot approve their own PRs) — the revision-bound review receipt and the maintainer's recorded merge decision carry the review weight; required approvals are added when a second maintainer joins. Exceptional recovery actions are documented publicly.

## Amendments

This file changes only via PR with maintainer approval.
