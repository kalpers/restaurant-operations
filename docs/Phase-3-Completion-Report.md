# Phase 3 Completion Report

This report merges the plan §61 template with the sections required by README §37. Results are from this repository on 2026-11-05.

## Summary

Phase 3 is implemented and validated locally. An authorized user can create an employee, assign locations and positions, and manage certifications, per-position compensation, personal data, documents, notes, reviews and disciplinary records, each behind its own permission. Termination ends eligibility and disables a linked login in one transaction, and keeps all history.

**Not yet confirmed:**

- **CI:** the work is uncommitted, so the workflow hasn't run on GitHub.
- **`db:reset` on the real development database:** deliberately not run, because it would delete your Owner account. The same command was proven on a throwaway PostgreSQL container. See Migrations.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |
| Authentication library | `next-auth` 4.24.15 |
| File storage adapter | `LocalFileStorage` behind `FileStorageService` |

No dependencies were added.

## Policies

The plan has no "Approved Policies" section, so README §33 (Phase 3) was treated as binding.

### Decided by the project owner during planning

| Conflict or gap | Decision |
|---|---|
| Employment status: README §10 says Management tier; plan §31, §34 and §35 say General | README. Status, termination date and status history need `hr.view`, and the list hides the status column without it |
| Minimum password length: `dee4f4b` set 5; README and the bootstrap prompt said 14 | Restore 14 |
| Termination vs the Phase 2 user safeguards | Refuse the whole termination if the linked user is the actor, the last Owner, or holds permissions the actor lacks. No override is built |
| Manager HR access | The Management tier: `hr.view`, `hr.certifications.*`, `hr.performance.*`, `hr.notes.*`, without sensitive notes |

**The password change is yours, not mine, and it's uncommitted.** `password.ts` already read 14 when implementation began, while HEAD (`dee4f4b`) still has 5. The baseline ran against 14, so the two 13-character tests passed. I had said they should fail at HEAD; that was never tested, because the working tree no longer matched HEAD. It needs committing with this work.

### Plan vs README conflicts resolved in README's favor

| Conflict | Resolution |
|---|---|
| Plan §13 suggests `users.employee_id`; README §33 says `employees.user_id` | `employees.user_id`, nullable and unique |
| Plan §18 says overlaps are per employee in one bullet, per employee + position in another | Per Employee + Position |
| Plan §31 puts manager notes in the Management tier; README §33 requires `hr.notes.sensitive.*` | README |
| README §33 described a follow-up migration renaming truncated FK names | Not needed: `Database-Conventions.md` says to name them explicitly, so they are correct from the first migration. The README sentence was corrected |

### Design choices shown in the approved plan

- **Location scoping:** an employee is reachable only from a location where they have a current or ended assignment. Elsewhere they return 404.
- **Assigning at another location** needs the permission at both the current and the target location.
- **Sensitive documents** have their own `hr.documents.sensitive.*` permissions. Without them, the plan's `sensitive` flag would have no effect.
- **`phone` and `personal_email`** are personal data under `hr.personal.*`. Only `work_email` is the general "work contact".
- **User link** needs both `employees.edit` and `admin.users.manage`.
- **`TERMINATED` is final.** A rehire gets a new employee record. Only termination disables a user.
- **Termination** needs `employees.terminate` and not `admin.users.manage`. Open compensation periods stay as they are.
- **Dates:** effective and termination dates are HR calendar dates, so `BusinessDateService` isn't involved. End dates are inclusive and can't be in the future.

## Architectural decisions

- **Each employee service enforces its own permission and scope,** so restricted queries are refused however they are reached, in addition to the route guard.
- **No single employee type.** `dto/employee-dto.ts` defines one view per permission, and repositories select explicit columns. `storage_key` is absent from every view.
- **Sensitive rows are filtered in SQL,** so they never reach a caller who can't see them.
- **Termination is a workflow** (`src/workflows/terminate-employee/`), because it crosses Employees and Auth. Disabling the user reuses the Phase 2 rules through `disableUserForTermination`.
- **Exclusion constraints guard overlapping periods** in PostgreSQL itself, and a row lock on the employee serializes changes in the services.
- **Composite foreign keys** tie a compensation row's employee and position to its organization.
- **`active` on assignments always matches `effective_to IS NULL`,** enforced by a CHECK.
- **Auth reads one employee column** to refuse re-enabling a terminated employee's account. It changes nothing in the Employees domain.
- **Uploads:** authorize, check the declared length, validate size, type and signature, write the file outside any transaction, then insert metadata. A failed insert removes the file.

### Architecture deviations

| Deviation | Reason |
|---|---|
| `db:reset` proven on a throwaway container rather than the real development database | It would have deleted your Owner account. The command, migrations and guard are the same |
| Added `hr.documents.sensitive.view` and `.manage` beyond plan §30 | The `sensitive` flag needs a permission to mean anything. Plan §30 allows adjustment |
| `README.md` §33 Phase 3 text updated | To record the decisions above, and to remove the follow-up-migration sentence |
| `.github/copilot-instructions.md` not used | `CLAUDE.md` replaces it, per the `/phase` instruction |

## Migrations

| Migration | Contents |
|---|---|
| `0002_employees_hr.sql` | Generated. 14 tables, all foreign keys `RESTRICT`, no changes to existing tables |
| `0003_employee_overlap_constraints.sql` | Custom, generated with `--custom`. Enables `btree_gist` and adds 3 exclusion constraints |

| Check | Result |
|---|---|
| Generation | PASS |
| Application | PASS |
| Existing Phase 2 database to Phase 3 | PASS: your real development database upgraded with `db:migrate` and `db:seed`, keeping its 1 user |
| Empty DB reconstruction | PASS: automated test, plus a new empty PostgreSQL 17 container |
| Unexplained schema drift | NONE: a second `db:generate` reports no changes |

Your development database is now on Phase 3: 64 permissions, 199 role-permission rows, 8 positions, 2 certification types, 0 employees and 1 user.

## Validation results

### Employee schema

| Table | Result |
|---|---|
| employees | PASS |
| employee_locations | PASS |
| positions | PASS |
| employee_positions | PASS |
| employee_addresses | PASS |
| employee_emergency_contacts | PASS |
| employee_position_compensation | PASS |
| certification_types | PASS |
| employee_certifications | PASS |
| employee_documents | PASS |
| employee_notes | PASS |
| employee_disciplinary_actions | PASS |
| employee_performance_reviews | PASS |
| employee_status_history | PASS |

### Identity boundaries

| Check | Result |
|---|---|
| User/Employee optional 1:1 | PASS |
| Duplicate User/Employee links rejected | PASS |
| Position does not grant Security Role | PASS |
| Security Role does not create Position | PASS |

### Employee workflows

| Check | Result |
|---|---|
| Employee creation | PASS |
| Initial status history | PASS |
| Location assignment | PASS |
| Position assignment | PASS |
| Primary location consistency | PASS |
| Primary position consistency | PASS |
| Status changes | PASS |
| Termination | PASS |
| Linked-user termination policy | PASS: including rollback for self, last Owner and missing permissions, and an E2E test where the user's next request is denied |

### Compensation

| Check | Result |
|---|---|
| Effective-dated history | PASS |
| Previous period closure | PASS: including a leap-day boundary |
| Per Employee + Position wage independence | PASS |
| Assignment-required rule | PASS |
| Overlap validation | PASS: in the service, and on direct SQL |
| HOURLY validation | PASS |
| SALARY validation | PASS |
| Exact NUMERIC handling | PASS: `9999999999.99` and `0.10` round-trip as strings; `9.505` is rejected rather than rounded |
| Restricted read authorization | PASS |
| Restricted write authorization | PASS |

### HR security

| Check | Result |
|---|---|
| General employee DTO excludes restricted HR data | PASS: exact key list asserted |
| Personal data authorization | PASS |
| Emergency contact authorization | PASS |
| Compensation authorization | PASS |
| Disciplinary authorization | PASS |
| Performance authorization | PASS |
| Sensitive notes authorization | PASS |
| Sensitive document authorization | PASS |
| Direct API unauthorized access denied | PASS: E2E, 9 restricted endpoints plus a write, as a user with `employees.view` only |

### Certifications

| Check | Result |
|---|---|
| Certification type seed | PASS |
| Employee certification creation | PASS |
| Expiration-required validation | PASS |
| Verification metadata | PASS: also enforced by a CHECK, and cleared when details change |

### File storage

| Check | Result |
|---|---|
| Local FileStorageService | PASS |
| Files outside PostgreSQL | PASS |
| Files outside public web root | PASS: the adapter refuses a root inside `public/` |
| Safe generated storage keys | PASS |
| Path traversal protections | PASS |
| File size validation | PASS |
| MIME type validation | PASS: with signature checks, so a script named `.pdf` is refused |
| Authorized retrieval | PASS |
| Sensitive retrieval denial | PASS: including with a known document ID |

### Seed data

| Check | Result |
|---|---|
| Positions | PASS |
| Certification types | PASS |
| Seed idempotency | PASS: `4 applied`, then `0 applied, 4 already applied`. No duplicates and no employees |

The versioned seed also upgrades a Phase 2 database without restoring a grant an administrator removed from a non-Phase-3 permission. An integration test covers this.

### Regression

| Check | Result |
|---|---|
| Phase 1 foundation tests | PASS |
| Phase 2 auth/RBAC tests | PASS |
| `db:reset` safeguards | PASS |
| `/api/health` | PASS: 200 on a production build |

Real `npm run db:reset` refusals on the throwaway container, each exiting 1 with no credentials in the output and a probe row intact afterward: `NODE_ENV=production`, `NODE_ENV=test`, a fake RDS host, database `postgres`, database `restaurant_ops_test`, and `?host=` on a local URL.

Production build, signed out: `/api/employees`, `/api/positions` and `/api/certification-types` return 401, and `/employees` redirects to `/login`.

### Validation

| Check | Result |
|---|---|
| PostgreSQL health | PASS |
| `npm ci` | PASS: the deprecation warnings are unchanged |
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 195 of 195 (baseline 125) |
| Integration tests | PASS: 321 of 321 (baseline 163) |
| E2E tests | PASS: 39 of 39 (baseline 26) |
| Production build | PASS |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 12 moderate, unchanged, recorded as DEV-002 |
| GitHub Actions | NOT RUN: work is uncommitted |

### Accepted risks

DEV-001: unchanged. DEV-002 and DEV-003: unchanged, and no dependencies were added.

### Business domains created beyond Phase 3

NONE. A migration test asserts the exact table list. No Scheduling, availability, payroll, S3 or audit code exists.

## Tests executed

- **Unit (new):** effective dates, leap days and daylight-saving changes, end and termination date rules, status transitions, money format, note sensitivity, certification dates, document signatures and limits, download headers, the local storage adapter, and the role matrix.
- **Integration (`tests/integration/employees/`):**
  - `employee-workflows`: creation and rollback, general access, concurrency, locations, positions, status, position and role independence, direct-SQL constraints.
  - `compensation`: everything in plan §48.
  - `termination-and-user-link`: plan §47, §49, each safeguard's rollback, and no path back to access.
  - `hr-authorization`: plan §45 and §46, notes, personal data, reviews, disciplinary records, certifications, cross-organization and cross-location access.
  - `documents`: plan §52, including cleanup after a failed metadata insert.
- **Integration (updated):** migrations, foundation seeds including a Phase 2 upgrade, seed registry.
- **E2E (`tests/e2e/employees.spec.ts`, 13):** create and open, stale edit, restricted tabs and direct API denial, a restricted tab by URL, the Manager tier, no-permission and signed-out refusal, wages, sensitive document upload and download, a mismatched upload, termination ending access, self-termination refused, phone-width layout.

## Files changed

**Created**

- Schema and migrations: `src/db/schema/employees.ts`, `drizzle/migrations/0002_employees_hr.sql`, `0003_employee_overlap_constraints.sql` and their snapshots
- Seeds: `src/db/seeds/{employee-reference-data,security-hr-permissions}.ts`
- Employees module: `src/modules/employees/` (`dto`, `repositories`, `rules`, `services`, `validators`, `types.ts`)
- Workflow: `src/workflows/terminate-employee/terminate-employee.ts`
- Storage: `src/infrastructure/storage/`
- API: 33 Route Handlers under `src/app/api/{employees,positions,certification-types}/`
- UI: `src/app/(app)/employees/` (list, detail with tabs, positions, certification types), `src/components/employees/`
- Tests: `tests/integration/employees/`, `tests/e2e/employees.spec.ts`, `tests/fixtures/employee-fixtures.ts`, `tests/helpers/e2e-{employees,storage}.ts`, unit tests beside the code
- Docs: this report

**Modified**

- Auth: `permission-catalog.ts` (64 codes), `role-catalog.ts`, `guards.ts`, `services/user-service.ts`, `repositories/user-repository.ts`, `password.ts` (your uncommitted change)
- Shared: `src/shared/http/api-route.ts` (raw responses), `src/db/helpers/{database-errors,timestamps}.ts`, `src/db/schema/index.ts`, `src/db/seeds/registry.ts`, `src/config/env.ts`
- UI: `src/components/app-shell/navigation.ts`, `src/components/forms/{entity-form.tsx,api-request.ts}`
- Tests and config: `playwright.config.ts`, and the tests that pinned the old catalog, matrix, seeds and table list
- Docs: `README.md` §33, `docs/Database-Conventions.md`, `.env.example`

## Risks

- **`btree_gist` on RDS.** It's documented as a trusted extension from PostgreSQL 13, so the database owner should be able to create it. This hasn't been tested on RDS. Check it in Phase 14, because the migration chain fails without it.
- **No audit rows for HR changes.** Status history and `*_by_user_id` columns record some actors, but nothing records who read restricted data or changed a personal record. See Remaining issues, item 1.
- **Uploads are held in memory** while processed, up to the 50 MiB ceiling per request. Acceptable for a POC with authenticated HR users; revisit before wider use.
- **`employees.view` can infer some status.** A terminated employee stays listed but shows no current location or position. The status itself is never sent. This follows from keeping past staff reachable.
- **Document contents aren't scanned.** The upload page warns against bank or card details, but a file could still contain data rule 15 prohibits.
- **An orphaned file is possible** if both the metadata insert and the cleanup fail. It holds no metadata and is unreachable, but stays on disk.
- **Sessions:** the Phase 2 risks still apply, and a copied token stays valid until the user is disabled. Termination does disable the user.

## Remaining issues

None of these block Phase 4.

1. **Where does the audit domain get built? Your decision.** Plan §43 says "Full business audit remains Phase 12", but README §36's Phase 12 deliverables don't list `audit_events`, and no other phase claims it. CLAUDE.md expects audit viewing to be built. Phases 4 to 11 will add actions that need auditing, so it's worth settling before Phase 12.
2. **Edit forms for some records.** Notes, reviews, disciplinary records and certifications have working, tested update APIs, but the UI only lists and adds them, plus verifying certifications. Plan §33 asks for a minimal UI. Say if you want the forms before Phase 4.
3. **Your existing Owner's password.** The 14-character minimum applies only when a password is set, so an account created while the minimum was 5 keeps working with its short password. There's no change-password feature yet, so changing it would mean recreating the account.
4. **Commit and confirm CI,** including your `password.ts` change.
5. **Carried over from Phase 2, both optional:** the old `restaurant-ops-postgres-1` container and volume, and the stray `%USERPROFILE%\package-lock.json`.

## Next-phase readiness

**Phase 4 readiness: READY,** subject to review of this report and a green CI run once committed. Employee locations, positions and status are in place for the shared eligibility evaluator, and it can read them without touching compensation or restricted HR data.
