# Roadmap

Plerni is a non-commercial open experiment: a learning platform you can run on your own servers. The priority is a small, stable kernel. Courses, tests, competencies, certificates, and connections to other systems are plugins. Plugins depend on each other through public contracts and the event bus. One plugin reaches another only that way.

Phases end when their checks pass. There is no delivery deadline.

An AI assistant may suggest a change. A person decides whether it happens.

## Principles

- **Everything else is a plugin.** The kernel keeps identity, tenancy, permissions, audit, storage, and the bus. Learning features, including the ones this project ships, use the same plugin path as anyone else's work.
- **AI proposes, humans commit.** The assistant can draft. A person accepts a sensitive or destructive change.
- **Self-hostable.** One build runs as an appliance on your own machines or as a shared service. Companies in one installation stay separated from the first version.
- **The API is a full product.** The screens are one client. The same actions are available over the API.
- **Rules that can be checked, are checked.** "Done" means someone ran the change and saw the result.
- **Open to this community.** Apache-2.0. People in HR, learning and development, and education technology are part of the audience, alongside developers.

The full statement is [design spec](specs/2026-10-12-plerni-design.md) §1. The decisions behind it are in the [decision register](decision-register.html) (D01–D32).

## Phases

The design spec §15 is the detailed list. This is the plain version. No phase has a date.

**P0 — Foundations.** The repository, the contributor rules, the decision records, and two technical proofs: tenant separation holds on a normal database pool, and a plugin can talk to the kernel under cancellation and overload. This roadmap is part of P0. The [exit note](plans/p0-exit-note.md) records this phase complete.

An earlier draft of this phase included a schedule exercise: a capacity annex with a team size, a calendar formula, and a nine-month bar. The maintainer withdrew that exercise on 2026-10-25 ([issue #15](https://github.com/tachkovsa/plerni/issues/15)). This page replaces it. The [design spec](specs/2026-10-12-plerni-design.md) §15, decision D23, and the [P0 plan](plans/2026-10-13-p0-implementation-plan.md) record the withdrawal.

**P1 — Kernel.** Sign-in, companies as tenants, roles, an audit trail, file storage, a secret store, notification plumbing, a job and event bus, a small admin screen, and a read-only assistant API. Creating a tenant and an administrator works through the API alone. Courses, tests, and competencies stay in plugins. The kernel source stays free of those words.

**P2 — Plugin platform.** A way to package, sign, install, and turn on a plugin, including one built outside this repository. Plugin screens in this phase are forms, menus, and lists described as data. The shell draws them.

**P3 — First learning plugins and a pilot.** The competencies plugin and the learning plugin (a small catalog, assignments, completion). An assistant proposes a goal and an assignment; a person accepts. A pilot runs with named users, and the project records whether the workflow is actually used. Completion is recorded on its own. It is separate from demonstrated skill.

**P4 — Hardening for a company deployment.** Sign-in and directory connectors (SAML and SCIM), install and upgrade notes, a Helm chart proven on a fresh machine, and a short test of how much help an outside author needs to install a plugin.

**P5 — Only after measured demand.** A manual catalog, a stronger isolation option, and the first release in which a plugin may run JavaScript in the host page (Module Federation). This phase starts only after at least three outside authors have real installs through manual sharing. It is outside the first version. Until then, plugin screens stay declarative data.

## Analysts and domain experts

The first people we need are those who run learning in companies. No coding.

Help define what the core must handle before the kernel is designed in P1. The design spec is a draft. These notes are input to that work. Comment on the issue, or open a pull request with a markdown file in the folder the issue names.

- [#63 — Core use cases](https://github.com/tachkovsa/plerni/issues/63). Five to ten short stories: who does what, and why. For example, assign mandatory training to a department and track the deadline.
- [#64 — Integrations](https://github.com/tachkovsa/plerni/issues/64). Which other systems a learning platform has to talk to, what data moves, how often, and how important it is.
- [#65 — Roles and permissions](https://github.com/tachkovsa/plerni/issues/65). Who can see what, who can change what, and what they must never see.
- [#66 — Metrics and reports](https://github.com/tachkovsa/plerni/issues/66). The numbers learning teams and managers actually use, who looks at them, and how often.

## Where help is wanted

**People who are not writing code**

- Domain input, in the four issues above. That is the useful work while the kernel design is still ahead.
- Examples of real learning content, and the words HR and L&D teams use, so later screens and reports match the work.
- Translations. English and Russian are both first-class. Kazakh and Uzbek come next.
- Feedback on flows. If a task needs hidden expert knowledge, the design is what should change.

**People who write code**

- Read the spec and the decision records before adding a capability. A new capability starts as a spec, then a plan, then tasks.
- Review of a high-risk change or an ADR follows [`ai/model-routing.md`](ai/model-routing.md). When every drafting model family is known, the reviewer is a person or a different model family, and the receipt says so. When a drafting family is unknown, the maintainer's decision of 2026-10-26 accepts a review by the project's assistant reviewer plus a clean Codex review of the exact commit. That receipt names the commit, says the review was done under that rule, and carries no claim that a person reviewed it and no claim that the model families were separate.
- Keep the kernel free of learning-domain words. The governed list is [`gates/domain-nouns.txt`](gates/domain-nouns.txt). Those ideas belong in a plugin.
- Connect plugins only through public contracts and the event bus.
- Tests, decision records, and doc corrections are useful during P0. The open engineering tasks on the P0 milestone (the data-layer and UI-kit decision records, and the gate checks) are tracked work. They are specialist tasks, separate from the starter list below.

## Good first issues

The [`good first issue`](https://github.com/tachkovsa/plerni/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label already exists. The curated starter set is the four domain tasks above. Each one also carries the `domain-input` label.

Use that label for a task a newcomer can finish from the docs: a domain note, a translation, a small doc correction. Kernel, security, tenancy, and migration work keeps its own labels (`risk/high`, `phase/P1`, and the rest).

## Planned plugins

Interoperability standards are plugins. Decision D24 in the [decision register](decision-register.html) takes SCORM, xAPI, and LTI out of the first version and brings them back later as plugins. The same treatment covers the other standards in this list. They live in plugins, and the kernel stays free of them. Host-page JavaScript from a plugin waits for P5, and only if that phase starts.

**Early, once a plugin can be installed**

- **SCORM 1.2 and 2004.** Old and frozen. Authoring tools still export it.
- **xAPI (Tin Can), with a learning record store.** Version 2.0 is IEEE 9274.1.1-2023. The store is a plugin. The kernel event log only delivers messages. It is the bus, and the statement archive lives in the plugin.
- **cmi5.** A newer way to launch a course, built on xAPI.
- **QTI.** Question import and export for a test plugin.
- **SCIM 2.0.** User and group sync from HR and identity systems. The spec places this connector in P4. People and groups live in the kernel directory. The sync adapter is the plugin.
- **Russian professional standards (профстандарты).** An importer for the open XML published by the Ministry of Labour.
- **Competencies and learning.** The domain plugins the spec schedules in P3: skills, goals, a small catalog, assignments, and completion.

**Later**

- **LTI 1.3.** Launch an external tool, such as a coding lab.
- **Open Badges 3.0 and CLR 2.0.** Verifiable certificates and learning records.
- **Competency framework importers.** CASE, ESCO, O\*NET, and SFIA, plus an export in the shape of IEEE 1484.20.3. Each importer is its own plugin, on top of the competencies plugin.
- **HR connectors.** For example 1C:ZUP and the electronic work book.
- **GOST R 72276-2025**, the specialist's digital portfolio, in force since 2026-01-01. It defines the content and defines no exchange format, so a plugin maps profile fields onto it.

**Left aside for now:** AICC (obsolete), Common Cartridge and OneRoster (school rostering and packaging), and Caliper.

**Accessibility** (WCAG 2.2 AA in the research note; the spec says WCAG AA) belongs to the UI kit and is shown on real workflows.

These shapes are design notes for P1, from the research comment on [issue #15](https://github.com/tachkovsa/plerni/issues/15). They describe room for plugins. A standard ships when its plugin ships, in that plugin's own phase. Learning-domain words stay out of the kernel:

1. A learning-event contract in the xAPI shape (actor, verb, object, result, context), so a record-store plugin or an external store can connect. The kernel log stays a delivery bus.
2. External identifiers on competencies, inside the competencies plugin, so each framework importer can be a separate plugin.
3. One shared format for achievements and records, which a certificate plugin can sign.
4. A signing and key hook on the kernel secret store, so key material stays in one place.
5. Users, groups, and org units in the kernel directory, in a shape a SCIM plugin can sync.
6. One sandboxed way for a content plugin to launch a package and report a result. Untrusted plugin screens, and an iframe protocol for them, stay out of the first version (D24). JavaScript in the host page waits for P5.
7. Accessibility built into the UI kit, as above.

The xAPI 2.0 status, Open Badges 3.0, CLR 2.0, IEEE 1484.20.3, and GOST R 72276-2025 were checked against official sources for that issue. Re-check every other item before a decision record cites it.

## How to start

1. Read [CONTRIBUTING.md](../CONTRIBUTING.md).
2. Read the [design spec](specs/2026-10-12-plerni-design.md).
3. Open the [decision register](decision-register.html) in a browser.
4. Skim the [architecture decision records](adr/README.md).
5. Pick a [good first issue](https://github.com/tachkovsa/plerni/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22), or leave a comment on one of the domain issues.

The [code of conduct](../CODE_OF_CONDUCT.md) applies.
