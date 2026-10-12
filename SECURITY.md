# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories (preferred) once the repository is public. Until then, contact the maintainer directly. Do not open public issues for security findings.

## Supported versions

Security fixes are applied to the latest release line only during the alpha period. A supported-versions policy will be published at GA.

## Scope notes

- The threat model is defined in the design spec (`docs/specs/`), §12 and the plugin trust tiers (§4.4).
- AI-assisted CI review is advisory only; blocking gates are mechanical.
- Third-party plugins run under the operator-approved trust tier; see the spec for the containment model.
