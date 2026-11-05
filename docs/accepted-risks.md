# Accepted Technical Risks

s### Description

The Next.js / ESLint development dependency chain currently
contains high-severity npm audit findings involving transitive
glob-pattern dependencies.

The affected braces advisory currently has no patched release
available through the compatible dependency chain.

The production dependency audit is clean.

### Decision

Do not downgrade the required Next.js 16 toolchain and do not
apply an incompatible `npm audit fix --force` remediation merely
to obtain a clean audit result.

The development dependency risk is temporarily accepted so that
development may continue without destabilizing the approved
application stack.

### Controls

- Production dependencies must remain audit clean.
- Do not expose development lint/glob tooling to application users.
- Continue monitoring compatible upstream dependency updates.
- Re-run `npm audit` whenever dependencies are upgraded.
- Do not use `npm audit fix --force` without reviewing the proposed
  dependency changes and architectural impact.
- Reevaluate this acceptance before production deployment.

### Review Triggers

Reevaluate this risk when:

- A compatible patched transitive dependency becomes available.
- Next.js or eslint-config-next is upgraded.
- The project's threat model changes.

### Resolution

DEV-001 remains accepted until a compatible upstream dependency update addresses the advisory or a review trigger changes the risk assessment. Reevaluate the dependency tree and production audit at that time, then update this record deliberately. Do not downgrade the approved Next.js 16 toolchain or use forced npm remediation without reviewing compatibility and architectural impact. Production dependencies must remain audit-clean.
