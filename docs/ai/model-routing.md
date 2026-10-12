# Model routing & agent conventions

Rules for AI-agent development on this repo (spec §13, principles 17–20).

## Disqualifier list (convention-heavy tasks)

Do NOT route these to cheap/fast models (the predecessor measured the failure mode: convention-guessing that typechecks and looks finished):

- Frontend / design-system work (token discipline, kit idioms, FSD boundaries)
- i18n-sensitive layout and locale files
- CI plumbing, gate configuration, workflow files
- Security-sensitive code (auth, tenancy, crypto, plugin admission)
- Migrations and schema changes (also require the signed approval artifact, spec §4.6)

## Review rules

- Generation and verification must use different model families (or a human reviewer). Record both in the commit trailer: `AI-assisted: author=<model> reviewer=<model-or-human>`.
- Reviewer agents pin the exact git revision under review.
- A completion report starts verification, not ends it (principle 19): run the thing, exercise the changed path, observe the result.
- One channel's confidence is not a signal. For high-risk work: independent review, falsification stance preferred over approval-seeking.

## Bug ownership

Whoever spots a bug either fixes it immediately or files a tracked deep-dive task (principle 20). "Another agent wrote this code" is not a valid reason to pass by.
