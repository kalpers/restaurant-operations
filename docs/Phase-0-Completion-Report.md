# Phase 0 Completion Report

This report merges the plan §24 template with the sections required by README §37. Results are from this repository on 2026-11-05.

## Summary

Phase 0 is complete and ready for review. The repository now has a Next.js application, Docker PostgreSQL, Drizzle, centralized environment validation, unit, integration and E2E test infrastructure, and an initial CI workflow. There is no restaurant functionality, no domain table and no authentication.

The work is committed and pushed to `origin/main` as `9a24795`. All local checks were re-run on that commit and pass. The GitHub Actions result is not confirmed, because it couldn't be read from this environment (see Validation results).

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 (current LTS; `.nvmrc` = 26; `engines` = `>=22.12.0`) |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| React | 19.3.1 |
| TypeScript | 6.0.3 |
| Tailwind CSS | 4.3.4 |
| PostgreSQL | 17.11 (`postgres:17-alpine`) |
| Drizzle ORM / Drizzle Kit | 0.45.4 / 0.31.11 |
| `postgres` driver | 4.0.0 |
| Zod | 4.6.7 |
| Vitest | 5.1.0 |
| Playwright | 1.64.1 |
| ESLint | 9.39.5 |

Two tools are deliberately behind their latest versions, because of published peer ranges:

- **TypeScript 6.0.3, not 7.0.2:** `typescript-eslint`, required by `eslint-config-next`, needs `<6.1.0`.
- **ESLint 9.39.5, not 10:** `eslint-plugin-react`, `-import` and `-jsx-a11y` do not accept ESLint 10.

## Policies

The Phase 0 plan has no "Approved Policies" section. These decisions were made by the project owner during planning:

| Conflict | Decision |
|---|---|
| README §36 lists "Authentication dependencies"; plan §5 says not to install them | Deferred to Phase 2 |
| README and CLAUDE.md said Node 20.9+; Vitest 5 needs `^22.12`, `^24` or `>=26`; plan §4 says current LTS | `.nvmrc` 26, `engines` `>=22.12.0`; README §33 and CLAUDE.md updated |
| Plan §16 lists `db:generate` and `db:migrate` for Phase 0; CLAUDE.md said Phase 1 | Added in Phase 0; CLAUDE.md updated. `db:seed` and `db:reset` stay in Phase 1 |

## Architectural decisions

- **Environment parsing is lazy.** `getEnv()` validates on first use, so `next build` succeeds with no runtime variables. Error messages name the variable and the rule, never the value.
- **`process.env` appears in two files only,** both in `src/config/`: `env.ts` and `tooling-env.ts`. The second holds the `.env` loader for tools that run outside Next.js, and the CI flag.
- **`getDatabase()` is lazy** and keeps one pool on `globalThis` so dev hot reloads don't leak connections.
- **The health check lives in `src/infrastructure/health/`,** because it isn't a domain concern. The route handler only maps the result to a status code.
- **The health check takes a database resolver, not an open database.** Invalid configuration then reports as 503 rather than an unhandled error.
- **Health failures log only the error name and code.** Driver messages can contain the host. The code is read from the error's `cause` chain, because Drizzle wraps driver errors. Real failures logged `ECONNREFUSED` and `28P01` with no connection details.
- **`typecheck` runs `next typegen` first.** `next-env.d.ts` is gitignored, and TypeScript 6 needs it to resolve the CSS import on a fresh clone.
- **The project was scaffolded by hand,** not with `create-next-app`, to avoid overwriting the existing docs.

### Architecture deviations

| Deviation | Reason |
|---|---|
| No authentication dependencies (README §36) | Owner decision; deferred to Phase 2 |
| No `.github/copilot-instructions.md` (plan §§2, 18, 20, 22) | `CLAUDE.md` replaces it, per the `/phase` instruction |
| Migration metadata is in `drizzle/migrations/meta`, not `drizzle/meta` (README §5) | This is where drizzle-kit writes it; matches the plan's tree |
| Added `postcss.config.mjs`, `vitest.config.mts`, `.nvmrc` (not in the plan §2 tree) | Required by Tailwind and Vitest; `.nvmrc` is named in plan §4 |
| `.gitkeep` in top-level folders with no Phase 0 content | Git can't track empty folders, and plan §1 requires the structure. No domain-module folders were created |
| Health 503 body is `{"status":"unavailable","database":"disconnected"}`, not the `{ "error": ... }` shape | It mirrors the plan's success shape. The structured error classes arrive in a later phase and could be applied then |
| Health logs have no `requestId` | Request context infrastructure doesn't exist yet |

## Migrations

None were created, as Phase 0 defines no tables. `npm run db:generate` reported `0 tables` and `No schema changes, nothing to migrate`, and wrote an empty `drizzle/migrations/meta/_journal.json`. `db:migrate` needs that journal, so it is kept.

`npm run db:migrate` succeeded as a no-op. It creates Drizzle's own `drizzle.__drizzle_migrations` table, which is the only table in the development database.

## Validation results

### Database

| Check | Result |
|---|---|
| PostgreSQL healthy | PASS: moved from `starting` to `healthy`, as reported by Docker |
| Application DB connection | PASS |
| Integration DB test | PASS |
| Data survives `docker compose down` and `up` | PASS: checked with a probe table, then dropped it |

### Validation

| Check | Result |
|---|---|
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 14 of 14 |
| Integration tests | PASS: 4 of 4 |
| E2E tests | PASS: 2 of 2 |
| Production build | PASS: `/api/health` is dynamic, `/` is static |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 12 moderate, 0 high or critical (see Risks) |
| GitHub Actions run | NOT CONFIRMED: `9a24795` is pushed, but the GitHub API returned "Not Found" and `gh` isn't installed. Check the repository's Actions tab |

### Additional checks

| Check | Result |
|---|---|
| CI steps in a clean copy with `CI=1` and no `.env` (`npm ci`, lint, typecheck, unit, build) | PASS |
| New-developer flow in that copy (copy `.env`, integration, E2E against the running database) | PASS |
| `npm run dev` page content and `/api/health` | PASS: 200 `{"status":"ok","database":"connected"}` |
| Production `next start`, `/api/health` | PASS: 200 |
| PostgreSQL stopped | PASS: 503 with no connection details; 200 again after restart |
| Closed port and wrong password | PASS: 503; logged `ECONNREFUSED` and `28P01`; no credentials in the response or log line |
| Missing configuration | PASS: `db:migrate` exits 1 naming `DATABASE_URL` and `APP_BASE_URL`; `/api/health` returns 503 |

The new-developer flow reused the already-running Compose database rather than running `docker compose up -d` from the clean copy, because both copies would use port 5432. `docker compose up -d` was verified from the repository itself.

### Checks that don't apply to Phase 0

Migration reconstruction, seed idempotency and reset safeguards are N/A. There are no migrations yet, and `db:seed` and `db:reset` belong to Phase 1 (plan §16 forbids creating them early).

## Tests executed

- **Unit (`src/config/env.test.ts`, 10):** valid configuration, both Postgres URL schemes, defaults, unrelated variables, missing and malformed values, all errors reported together, no values in errors.
- **Unit (`src/infrastructure/health/check-database-health.test.ts`, 4):** connected, query failure without connection details, wrapped driver error code, unresolvable database.
- **Integration (`tests/integration/database/database-connection.test.ts`, 4):** `SELECT 1` through the application database layer, health check against real PostgreSQL, `NUMERIC` returned as an exact string, Drizzle transaction rollback.
- **E2E (`tests/e2e/home.spec.ts`, 2):** page title and content, `/api/health`.

The last two integration tests go beyond the plan. `postgres` 4.0.0 is a new major version, and Phase 1 depends on exact numerics and transactions, so they confirm it works with Drizzle 0.45.4.

## Files changed

**Created**

- Configuration: `.env.example`, `.gitignore`, `.nvmrc`, `docker-compose.yml`, `drizzle.config.ts`, `eslint.config.mjs`, `next.config.ts`, `package-lock.json`, `playwright.config.ts`, `postcss.config.mjs`, `tsconfig.json`, `vitest.config.mts`, `.github/workflows/ci.yml`
- Application: `src/app/{layout.tsx,page.tsx,globals.css}`, `src/app/api/health/route.ts`, `src/config/{env,tooling-env}.ts`, `src/db/index.ts`, `src/db/schema/index.ts`, `src/infrastructure/health/check-database-health.ts`
- Tests: `src/config/env.test.ts`, `src/infrastructure/health/check-database-health.test.ts`, `tests/helpers/integration-setup.ts`, `tests/integration/database/database-connection.test.ts`, `tests/e2e/home.spec.ts`
- Generated: `drizzle/migrations/meta/_journal.json`
- `.gitkeep` in: `docker/postgres`, `public`, `src/{components,modules,shared,types,workflows}`, `tests/fixtures`
- This report

**Modified**

- `package.json`
- `README.md` §33: Node requirement
- `CLAUDE.md`: Node requirement and script phases
- `AGENTS.md`: `next dev` changed one heading level. The file's header says Next rewrites this block, so the change should be committed

**Local only (gitignored):** `.env` with development-only credentials.

## Risks

**New dev-only audit findings that DEV-001 doesn't describe.** `docs/accepted-risks.md` describes high-severity `braces` findings. The current audit has no `braces` advisory (`braces@3.0.3` is installed). It reports 12 moderate findings from two advisories instead:

| Advisory | Package | Reaches the project through | Exposure |
|---|---|---|---|
| GHSA-67mh-4wv8-2f99 (dev server request exposure) | `esbuild` `<=0.24.2` (0.18.20 installed) | `drizzle-kit` | The project doesn't run esbuild's dev server |
| GHSA-g3hv-75wg-m249 (denial of service) | `minimatch` `>=7.0.0 <11.0.1` | `eslint-config-next` | Lint tooling only, on the project's own files |

Neither is in the production dependency tree, and `npm audit --omit=dev` is clean. npm's only offered fixes are major-version changes that move backward: `drizzle-kit` 0.18.1 and `eslint-config-next` 15.5.29, the second of which would downgrade the Next.js toolchain. `npm audit fix --force` was not used. These findings are not yet accepted (see Remaining issues).

**Other risks**

- **`postgres` 4.0.0 is new.** Its behavior beyond the tested paths is less proven than 3.4.9. Fall back to 3.4.9 if Phase 1 hits a driver problem.
- **E2E and integration tests use the development database for now.** They only read data, or roll back. Isolation arrives with `TEST_DATABASE_URL` in Phase 1.
- **npm blocks esbuild's install scripts** (`allowScripts`). This has no effect today, because the platform binary comes from an optional dependency and drizzle-kit runs correctly.

## Remaining issues

No Phase 0 functionality is outstanding. These need an owner's attention:

1. **Confirm CI.** Check that the GitHub Actions run for `9a24795` passed.
2. **Approve or reject a risk entry for the new dev-only audit findings.** `CLAUDE.md` requires approval before they are recorded in `docs/accepted-risks.md`. That file also has a typo on line 3 (`s### Description`) and no `DEV-001` heading. It was left unchanged.
3. **Old Docker leftovers.** An exited `restaurant-ops-postgres-1` container and a `restaurant-ops_postgres_data` volume remain from an earlier project folder. They were left untouched. If that data isn't needed, this deletes it permanently: `docker rm restaurant-ops-postgres-1; docker volume rm restaurant-ops_postgres_data`.
4. **Stray lockfile.** Next.js warns that it is ignoring `C:\Users\kneal\package-lock.json`, which is outside this repository. The warning is harmless and specific to this machine.

## Next-phase readiness

**Phase 1 readiness: READY,** subject to review of this report. Every plan §23 condition is met, and all the existing-foundation checks in Phase 1 plan §3 pass locally. The CI result on GitHub is still to be confirmed.
