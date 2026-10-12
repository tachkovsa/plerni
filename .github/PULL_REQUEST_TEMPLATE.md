## What

<!-- One paragraph: what changes and why. Link the spec section, ADR, or issue. -->

## Verification

<!-- Principle 19: "done" starts verification. What did you run, what did you observe? -->
- [ ] I ran the changed path and observed the result (paste evidence: commands, output, revision)
- [ ] Role-chain walkthrough added/updated for any user-facing feature (spec §12)
- [ ] Behavior-changing PR → docs updated in the same change (doc-coupling gate)

## Risk

- [ ] Low risk — observed verification only
- [ ] High risk (authz, tenancy, crypto, plugin admission, migrations, CI/gates, release credentials, policy) → review receipt covering the current revision is linked (reviewer role, evidence ID)

## Compliance

- [ ] No secrets, personal data, third-party confidential info, or private tooling/model identities in the diff or metadata (AGENTS.md §0)
- [ ] Human DCO sign-off(s) present; substantial AI-generated content carries `AI-assisted: yes`
- [ ] New SDK capability or trust boundary → ADR linked
