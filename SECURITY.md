# Security Policy

## Reporting a vulnerability

Report vulnerabilities **privately**: via GitHub private vulnerability reporting (Security Advisories) on this repository, or contact the maintainer directly (see GOVERNANCE.md). Do not open public issues for security findings. Reports are acknowledged within 5 business days.

## Supported versions

P0 has no releases yet — repository and CI security reports are accepted now. During the alpha period, security fixes target the latest alpha release line; a supported-versions policy is published at GA.

## Scope notes

- The threat model is defined in the design spec (`docs/specs/`), §12 and the plugin trust tiers (§4.4).
- AI-assisted CI review is advisory only; blocking gates are mechanical.
- Third-party plugins run under the operator-approved trust tier; see the spec for the containment model.
