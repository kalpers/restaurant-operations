# Accepted Technical Risks

## DEV-001: Next.js / ESLint development dependency chain (`braces`)

**Status note, 2026-11-05:** `npm audit` does not currently report the `braces` advisory (`braces@3.0.3` is installed). This entry stays tracked because the Phase 2 plan requires it. It should be closed deliberately, not removed in passing.

### Description

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

## DEV-002: Development tooling advisories (`esbuild`, `minimatch`)

Accepted by the project owner on 2026-11-05, during Phase 1 planning.

### Scope

Development dependencies only: 12 moderate `npm audit` findings from two advisories. `npm audit --omit=dev` reports 0 vulnerabilities.

| Advisory | Package | Reaches the project through | Exposure |
|---|---|---|---|
| GHSA-67mh-4wv8-2f99: a website can send requests to esbuild's dev server and read the responses | `esbuild` 0.18.20 | `drizzle-kit` | The project does not run esbuild's dev server |
| GHSA-g3hv-75wg-m249: denial of service through crafted glob patterns | `minimatch` 3.1.5 and 10.2.6 | `eslint-config-next` | Lint runs only on the project's own files |

### Decision

Accept temporarily. npm's only offered fixes are `drizzle-kit` 0.18.1 and `eslint-config-next` 15.5.29. Both are major-version moves backward, and the second downgrades the approved Next.js 16 toolchain.

### Controls

- Production dependencies must remain audit clean.
- These tools are never exposed to application users or run against untrusted input.
- Do not use `npm audit fix --force`.
- Re-run `npm audit` whenever dependencies change.

### Review Triggers

Reevaluate this risk when:

- A compatible patched release becomes available.
- `drizzle-kit`, `eslint-config-next`, or Next.js is upgraded.
- The findings' severity rises above moderate.
- The project's threat model changes.
- Before any cloud deployment (see `docs/Cloud-Deployment-Guide.md`).

## DEV-003: Deprecated development packages (`eslint`, `@esbuild-kit`)

Accepted by the project owner on 2026-11-05, at the close of Phase 1.

### Scope

Development dependencies only. `npm ci` prints three deprecation warnings. These are not `npm audit` findings, except that `@esbuild-kit/core-utils` is also the path to the `esbuild` advisory in DEV-002.

| Package | Warning | Reaches the project through |
|---|---|---|
| `eslint@9.39.5` | No longer supported | Direct dependency |
| `@esbuild-kit/esm-loader@2.6.5` | Merged into `tsx` | `drizzle-kit` 0.31.11 |
| `@esbuild-kit/core-utils@3.3.2` | Merged into `tsx` | `drizzle-kit` 0.31.11 |

### Decision

Accept temporarily, as tracked warnings that satisfy the Phase 1 plan §33 clean-install item. No compatible fix exists: `eslint-plugin-react`, `-import` and `-jsx-a11y`, required by `eslint-config-next`, don't accept ESLint 10, and the `@esbuild-kit` packages are dependencies of the current `drizzle-kit`. The fix is to upgrade when those packages catch up.

### Controls

- These packages are never part of the production dependency tree.
- Do not force ESLint 10 with overrides or `--legacy-peer-deps`.
- Read `npm ci` warnings unfiltered whenever dependencies change, and treat any new warning as unresolved until it is reviewed.

### Review Triggers

Reevaluate this risk when:

- `eslint-config-next` and its plugins support ESLint 10.
- A `drizzle-kit` release drops `@esbuild-kit`.
- `eslint`, `eslint-config-next`, `drizzle-kit`, or Next.js is upgraded.
- An audit advisory is published against any of these packages.
- Before any cloud deployment (see `docs/Cloud-Deployment-Guide.md`).
