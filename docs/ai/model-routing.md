# Model routing & agent conventions

Rules for AI-agent development on this repo (spec §13, principles 17–20). Tool-agnostic per AGENTS.md §0: contributors use any agent harness; the rules name roles, never products. The maintainer decision of 2026-10-26 below names one review path, Codex, for the case where a drafting family is unknown. That path name is not a model-family identity. Families stay α, β, γ, δ.

## Disqualifier list (convention-heavy tasks)

Do NOT route these to cheap/fast models (the predecessor measured the failure mode: convention-guessing that typechecks and looks finished):

- Frontend / design-system work (token discipline, kit idioms, FSD boundaries)
- i18n-sensitive layout and locale files
- CI plumbing, gate configuration, workflow files
- Security-sensitive code (auth, tenancy, crypto, plugin admission)
- Migrations and schema changes (also require the signed approval artifact, spec §4.6)

## Review rules

- **High-risk changes** — authorization, tenancy, cryptography, plugin admission, migrations, CI/gates, release credentials, policy changes — require verification by a human reviewer or an agent from a **different model family** than every agent materially involved in generating the change, when every drafting model family is known. Different clients, accounts, sessions, or model versions do not establish different families. That cross-family rule is unchanged, and the receipt states the separation.
- **Unknown drafting family (maintainer decision, 2026-10-26).** When the drafting model family is unknown, a review by the project's maintainer-designated assistant reviewer plus a clean Codex review of the exact head is enough to accept an ADR or merge a high-risk pull request. A human review is not required on this path. The receipt names that exact head and states that the review was done under this maintainer rule. It carries no human-review claim and no family-separation claim.
- Verification identifies the reviewed revision (pinned SHA), states findings and their disposition, and provides observed test evidence. New commits invalidate the receipt.
- **Public record — the review receipt:** reviewed head SHA, reviewer role (`human|agent`), verification summary, outcome, accountable sponsor, and an opaque evidence ID. When the families are known, an agent review asserts that the family-separation requirement was satisfied. On the unknown-family path, reviewer role is `agent`, the receipt names the exact head, states that the review was done under the 2026-10-26 maintainer rule, and carries no human-review claim and no family-separation claim.
- **Private archive (maintainer):** actual author/reviewer identities and versions, the family mapping, revision, findings, and verification evidence — including every material generator, reviewers who write fixes included. Archive hashes prove integrity, not review quality or independence: the public verifies an accountable assertion and its scope, not the separation itself.
- Commits with substantial AI-generated content carry only `AI-assisted: yes` (role-only — never identities). Migrations keep the signed approval artifact (spec §4.6) with a tool-agnostic approver identity and a content digest. **The signed approval artifact for gate-config changes is waived at the current stage** (owner decision, 2026-10-15), the same way human DCO sign-off is not required now.
- Low-risk work still requires observed verification (principle 19); a second model for every edit is unjustified overhead.
- Reviewer agents pin the exact git revision under review.
- A completion report starts verification, not ends it (principle 19): run the thing, exercise the changed path, observe the result.
- One channel's confidence is not a signal. For high-risk work: independent review, falsification stance preferred over approval-seeking.

## Bug ownership

Whoever spots a bug either fixes it immediately or files a tracked deep-dive task (principle 20). "Another agent wrote this code" is not a valid reason to pass by.
