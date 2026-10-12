# Governance

## Roles

- **Maintainer** (founder): owns the gate policy, escalation rules, release authority, and periodic audits. Holds final say on ADRs.
- **Contributors** (human or agent): submit PRs under the rules in CONTRIBUTING.md.

## Decision-making

- Architecture decisions are recorded as ADRs in `docs/adr/` and require maintainer approval.
- New SDK capabilities or trust boundaries require an ADR before implementation (surface-area budget).
- Migration approval authority is defined by policy (currently: cross-family agent review with a signed approval artifact; see spec §4.6 and §13). The maintainer owns the policy.

## Escalation

Disagreements escalate to the maintainer. Security-sensitive changes require review by a different model family than the author, per principle 18 (spec, engineering culture).

## Amendments

This file changes only via PR with maintainer approval.
