# Phase 2 Completion Report

This report merges the plan §57 template with the sections required by README §37. Results are from this repository on 2026-11-05.

## Summary

Phase 2 is implemented and validated locally. A fresh database can now go through migrations, seeds, Owner bootstrap and Owner login to reach the protected shell, with permissions resolved from PostgreSQL on every protected request.

**Not yet confirmed:**

- **CI:** the work is uncommitted, so the updated workflow has not run on GitHub.
- **Interactive bootstrap prompt:** the hidden-password terminal prompt has not been run on a real terminal. The piped-input path was run for real. See Remaining issues.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |
| Authentication library | `next-auth` 4.24.15 (Credentials, JWT sessions) |
| Password hashing | `@node-rs/argon2` 2.2.2 (Argon2id, m=19456, t=2, p=1) |

## Policies

The plan has no "Approved Policies" section. README §33 (Phase 2) was treated as binding. The project owner made these decisions during planning:

| Conflict or gap | Decision |
|---|---|
| Plan's `reports.*.view` vs README and Phase 12's `reports.*`; README's `admin.roles` vs plan's split | README's 9 report codes plus `settlements.complete`; plan's `admin.roles.view` and `admin.roles.manage`. 44 codes in total |
| Public `/` with an E2E test vs plan §28's public list | `/` redirects to `/dashboard`, which sends signed-out visitors to `/login`. Home E2E rewritten, health E2E unchanged |
| `next-auth` stable v4 or v5 beta | 4.24.15 stable |
| Admin safeguards beyond self-disable | No-escalation rule, immutable Owner role, last-Owner protection |

These smaller conflicts were listed in the approved plan and resolved as follows:

- **Timezone:** kept only on `locations` (plan §6), not also in settings (README §8).
- **`orders.close`:** kept, because the plan and Phase 9 use it and the README's list is examples.
- **`reservation_pre_hold_minutes` and post-grace:** left for Phase 6.

### Authentication and sessions

- **Strategy:** encrypted JWT sessions lasting eight hours, as README §33 requires. The token holds only the user ID. Every protected request resolves the user, locations, roles and permissions from the database.
- **Why it suits this POC:** no session table is needed, and disabling a user or changing a permission takes effect on the next request.
- **Sign-in failures:** unknown, disabled and wrong-password attempts all return `Invalid email or password`. Unknown and disabled accounts still run a verification, so timing doesn't obviously reveal which case applies.
- **User provisioning:** only through the Owner bootstrap or an authorized administrator. There is no public registration.

### Location settings defaults

| Setting | Default |
|---|---|
| Business day cutoff | 04:00 |
| Table turn | 90 minutes |
| Reservation length | 90 minutes |
| Wait quote | 15 minutes |
| Walk-ins, reservations, takeout, inventory, scheduling, kitchen display | Enabled |

### Starting role-permission matrix

Source: `src/modules/auth/role-catalog.ts`. 152 mappings in total.

| Role | Permissions |
|---|---|
| OWNER | All 44 |
| GENERAL_MANAGER | All except `admin.roles.manage`, `organization.manage`, `hr.compensation.edit` |
| MANAGER | `admin.users.view`, `organization.view`, `locations.view`, `employees.view`, `schedule.*`, `restaurant.*`, `reservations.*`, `menu.*`, `inventory.*`, `orders.*`, `settlements.complete`, `kitchen.*`, `reports.view/sales/orders/inventory/fulfillment/settlements/seating` |
| SERVER | `restaurant.view`, `menu.view`, `orders.create/submit`, `schedule.view`, `settlements.complete` |
| BARTENDER | Server's set plus `kitchen.view/manage` |
| HOST | `restaurant.view/manage`, `reservations.view/manage`, `schedule.view` |
| COOK | `kitchen.view/manage`, `menu.view`, `schedule.view` |
| WAIT_STAFF | `restaurant.view`, `menu.view`, `kitchen.view`, `schedule.view`. Deliberately has no order entry: support staff who run food and clear tables |
| INVENTORY_MANAGER | `inventory.*`, `menu.view`, `schedule.view`, `reports.view`, `reports.inventory` |

## Architectural decisions

- **Dependency direction:** Route Handler, then guard, then service, then repository, then Drizzle. React components and pages never import Drizzle or the schema, confirmed by search.
- **Library isolation:** `next-auth` is imported only inside `src/modules/auth/`, confirmed by search. It is configured lazily, so `next build` needs no secret.
- **Each page and API enforces its own permission.** There is no `proxy.ts`, because Next's documentation says it is not a full authorization solution, and these checks need the database.
- **Location updates authorize against the target location,** not the one the user is working at.
- **Current location is a cookie holding a preference only.** It counts only if the user is authorized there now, and a forged value grants nothing.
- **Foreign keys are all `ON DELETE RESTRICT`.** Nothing cascades, and a test checks this for every foreign key. Replacing role permissions deletes join rows explicitly.
- **`OWNER_ROLE_CODE` appears in code only for data invariants and bootstrap,** plus hiding the edit form on the Roles page. No authorization decision uses a role name.
- **`active` isn't editable on organizations or locations in Phase 2,** because deactivating one would lock out its users, including the last Owner.
- **The test database is now seeded,** using its own connection so it can't touch development.

### Architecture deviations

| Deviation | Reason |
|---|---|
| No-escalation rule also covers disabling a user, removing a role and deactivating a role, not only assigning | You approved it for assignment. Without this, a General Manager could disable an Owner while another Owner remained. **Please confirm** |
| `bootstrap:owner` also accepts piped input (email line, then password line) | Needed for provisioning and to test the real script. The password still never appears in arguments. README §33 describes only the prompt |
| No create-location or create-area screens | One location is deployed, and plan §28 asks for the minimum. Update screens exist |
| Added `/access-denied` | Plan doesn't list it, but pages need somewhere to send a denied user |
| `.github/copilot-instructions.md` not used | `CLAUDE.md` replaces it, per the `/phase` instruction |

## Migrations

`0001_organization_auth_rbac.sql` was generated and reviewed. It creates 9 tables, with the constraints from plan §40 and indexes on `role_permissions(permission_id)`, `user_roles(user_id, location_id)` and `user_roles(role_id)`.

| Check | Result |
|---|---|
| Generation | PASS |
| Application | PASS |
| Existing Phase 1 database to Phase 2 | PASS: the real development database, which held only `seed_runs`, upgraded with `db:migrate` |
| Empty DB reconstruction | PASS: automated test, plus `db:reset` |
| Unexplained schema drift | NONE: a second `db:generate` reports no changes |

## Validation results

### Organization domain

| Check | Result |
|---|---|
| organizations | PASS |
| locations | PASS |
| location_settings | PASS |
| restaurant_areas | PASS |
| tenant/location constraints | PASS |

### Security schema

| Check | Result |
|---|---|
| users | PASS |
| roles | PASS |
| permissions | PASS |
| role_permissions | PASS |
| user_roles | PASS |

### Authentication

| Check | Result |
|---|---|
| Email normalization | PASS |
| Password hashing/verification | PASS |
| Valid login | PASS: E2E, and against a production build |
| Invalid login generic response | PASS |
| Session resolution | PASS |
| Logout | PASS |
| Disabled-user enforcement | PASS: a signed-in user got 200, was disabled, then got 401 on the next request |
| Public registration absent | PASS: `/signup`, `/register` and `/api/register` return 404 |

### Authorization

| Check | Result |
|---|---|
| Central permission catalog | PASS |
| Permission resolution | PASS |
| Server-side permission guard | PASS |
| Direct protected-operation denial | PASS: a signed-in Server gets 403 from direct API calls and "Access denied" from admin URLs |
| Inactive roles ignored | PASS |
| Inactive role assignments ignored | PASS |
| Location-aware authorization | PASS: service and API level, using temporary second locations |

### Safeguards

| Check | Result |
|---|---|
| No-escalation | PASS: including a General Manager sending the Owner role's ID directly, which gets 403 |
| Owner role immutable | PASS |
| Last-Owner protection | PASS: including two Owners removing each other at once, where exactly one succeeds |
| Self-disable rejected | PASS |

### Seed data

| Check | Result |
|---|---|
| Organization | PASS |
| Main location | PASS |
| Location settings | PASS |
| Dining Room | PASS |
| Bar | PASS |
| Takeout | PASS |
| Roles | PASS |
| Permissions | PASS |
| Role-permission mappings | PASS |
| Seed idempotency | PASS |

Row counts after each of two `db:seed` runs, and again after `db:reset` and `db:seed`: organizations 1, locations 1, settings 1, areas 3, roles 9, permissions 44, role permissions 152, users 0. The second run reported `0 applied, 2 already applied`.

### Owner bootstrap

| Check | Result |
|---|---|
| Secure account creation | PASS |
| No hardcoded password | PASS |
| No credential leakage | PASS: the password and hash were absent from the script's output and from the production server log |
| Owner role assignment | PASS |
| Retry/duplicate handling | PASS: a second run with a different password left the account's password unchanged and added no rows |

The real script ran through piped input. Passwords were generated at run time.

### Regression

| Check | Result |
|---|---|
| Phase 1 database foundation tests | PASS |
| `db:reset` safeguards | PASS |
| `/api/health` | PASS |

Real `npm run db:reset` refusals, each exiting 1 with the probe account still present afterward: `NODE_ENV=production`, `NODE_ENV=test`, a fake RDS host, and database `postgres`.

### Production-build flow

Run against `next start` with the development database and the bootstrapped Owner:

| Step | Result |
|---|---|
| `/api/health` | 200 |
| `/dashboard`, signed out | 307 to `/login` |
| `/api/admin/users`, signed out | 401 |
| Wrong password | 401, no session cookie |
| Correct password | 200, encrypted session cookie |
| Session payload | `expires` and `user.id` only |
| `/dashboard`, signed in | 200 |
| `/api/admin/users`, signed in | 200, no credential fields |
| `/api/admin/users`, after sign-out | 401 |

### Validation

| Check | Result |
|---|---|
| `npm ci` | PASS: the same 3 deprecation warnings as DEV-003, none new |
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 125 of 125 |
| Integration tests | PASS: 163 of 163 |
| E2E tests | PASS: 26 of 26 |
| Production build | PASS |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 12 moderate, unchanged, recorded as DEV-002 |
| GitHub Actions | NOT RUN: work is uncommitted |

### Accepted risks

DEV-001: unchanged. DEV-002 and DEV-003: unchanged, and the new dependencies added no findings or warnings.

### Business domains created beyond Phase 2

NONE. A migration test asserts the exact table list.

## Tests executed

- **Unit (125):** email normalization, Argon2id hashing, catalog and matrix rules, token contents, permission checks, navigation filtering, error mapping and non-disclosure, secret rules, and the existing Phase 0 and 1 tests.
- **Integration (163):**
  - `auth/credentials`: all login outcomes, login recording, database constraints.
  - `auth/permissions`: plan §46 in full, matrix allow/deny by role, inactive location and organization, cross-organization assignment.
  - `auth/user-admin`: atomic creation and rollback, duplicates, concurrency, and all safeguards.
  - `auth/role-admin`: permission replacement, Owner immutability, escalation, stale versions.
  - `auth/owner-bootstrap`: creation, retries, simultaneous runs, disabled accounts, missing seeds.
  - `organization/organization`: updates, concurrency, constraints, delete refusal.
  - `database/foundation-seeds`: real seeds on a fresh database, run twice.
  - The existing Phase 1 database tests.
- **E2E (26):** login, invalid login, logout, signed-out access, direct API denial, disabled user, role-based navigation, location authorization and switching, forged location cookie, provisioning through the UI, stale edits, and the health regression.

## Files changed

**Created**

- Schema and migration: `src/db/schema/{organization,auth}.ts`, `drizzle/migrations/0001_organization_auth_rbac.sql`, `drizzle/migrations/meta/0001_snapshot.json`
- Seeds: `src/db/seeds/{organization-foundation,security-foundation}.ts`
- Auth module: `src/modules/auth/` (catalogs, email, password, options, session, client, guards, route handler, repositories, services, validators)
- Organization module: `src/modules/organization/` (repository, service, validators)
- Shared: `src/shared/errors/app-error.ts`, `src/shared/http/api-route.ts`, `src/infrastructure/logging/logger.ts`, `src/db/helpers/database-errors.ts`, `src/config/auth-env.ts`
- UI: `src/app/login/`, `src/app/(app)/` (shell, dashboard, access denied, six admin pages), `src/components/{app-shell,forms,admin}/`, `src/components/login-form.tsx`
- API: `src/app/api/auth/[...nextauth]/`, `src/app/api/session/location/`, `src/app/api/admin/`
- Script: `scripts/bootstrap-owner.ts`
- Tests: `tests/integration/auth/`, `tests/integration/organization/`, `tests/integration/database/foundation-seeds.test.ts`, `tests/e2e/auth.spec.ts`, `tests/fixtures/auth-fixtures.ts`, `tests/helpers/e2e-accounts.ts`, and unit tests beside the code
- Docs: this report

**Modified**

- `package.json`, `package-lock.json`: two dependencies, `bootstrap:owner`
- `src/config/env.ts` and its test, `.env.example`: `NEXTAUTH_SECRET`
- `src/app/page.tsx`: now a redirect
- `src/shared/errors/concurrency-error.ts`: extends `AppError`, same code and message
- `src/db/schema/index.ts`, `src/db/seeds/registry.ts`, `drizzle/migrations/meta/_journal.json`
- `tests/helpers/prepare-test-database.ts`: also seeds
- `tests/e2e/home.spec.ts`, `tests/integration/database/{migrations,seed-framework}.test.ts`
- `playwright.config.ts`: a generated secret for each run
- `.github/workflows/ci.yml`: production audit, throwaway secret, Chromium, E2E
- `docs/Database-Conventions.md`: test database is seeded

**Local only (gitignored):** a generated `NEXTAUTH_SECRET` in `.env`.

`README.md`, `CLAUDE.md` and `docs/accepted-risks.md` are unchanged. The development database was left reset and seeded, with no users, so you can run `bootstrap:owner` yourself.

## Risks

- **A copied session token stays usable after logout.** Logout removes the cookie, but JWT sessions have no server-side revocation. Disabling the user does cut access immediately. This follows from the README's chosen model.
- **Sessions can be extended.** The app never calls next-auth's `/api/auth/session` during normal use, so ordinary sessions end at eight hours. But calling that endpoint reissues the token for another eight hours, so a stolen token could be kept alive until the user is disabled. Revisit before Phase 14.
- **No login rate limiting.** It wasn't specified, and Redis isn't allowed. Revisit before Phase 14.
- **Initial passwords are set by an administrator,** with no forced change at first login, because account recovery is out of scope.
- **No audit rows yet** for security changes, by design (plan §44). Phase 2 doesn't record who disabled a user or changed a role, beyond `assigned_by_user_id`.
- **`next-auth` 4 is the maintenance line.** Its calls are isolated in the auth module, so a later move should be contained.

## Remaining issues

None of these block Phase 3.

1. **Confirm the no-escalation extension** described under Architecture deviations.
2. **Try the interactive prompt once.** No terminal is available in this environment, so the hidden-password prompt hasn't been run. Running `npm run bootstrap:owner` in your terminal both tests it and creates your Owner account.
3. **Confirm CI after committing.** The workflow gained an E2E step, and the drift check needs the migration committed. The workflow itself hasn't run.
4. **Carried over, both optional:** the old `restaurant-ops-postgres-1` container and volume, and the stray `%USERPROFILE%\package-lock.json`. Next.js still warns about the second.

## Next-phase readiness

**Phase 3 readiness: READY,** subject to review of this report and a green CI run once committed. Every plan §54 check passes locally, and the §56 lifecycle ran from migrations through Owner login to enforced protected operations. No Employees/HR tables exist, and security roles stay separate from positions.
