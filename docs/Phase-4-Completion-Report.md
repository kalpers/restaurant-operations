# Phase 4 Completion Report

This report merges the plan §72 template with the sections required by README §37. Results are from this repository on 2026-11-05.

## Summary

Phase 4 is implemented and validated locally. An authorized manager can create a period, add shifts by hand or from a staffing template, assign employees with eligibility checks and coverage feedback, generate a draft or fill open shifts, review the explanations, change assignments, and publish. An employee with a linked login can see their own published shifts, maintain availability and preferences, request time off, and request or accept a swap.

Manual assignment, generation, Fill Open Shifts, swaps and publishing all call one eligibility evaluator, so they can't disagree.

**Not yet confirmed:**

- **CI:** GitHub Actions failed on the first push: 1 of 51 E2E tests got a 404 from the coverage API. An unanchored `coverage/` rule in `.gitignore` had kept that route file out of the commit, so the bug shipped in the first push even though every local check passed. Commit `7840586` anchors the rule and adds the file, and the owner reports the workflow then passed. This environment can't read the runs, so that is the owner's confirmation. The run covers the Phase 3 code too, but it doesn't establish what the Phase 3 commits did on their own.
- **`db:reset` on your real development database:** deliberately not run, because it would delete your Owner account. The same command was proven on a throwaway PostgreSQL container. See Migrations.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |

No dependencies were added.

## Policies

Plan §9's approved availability policy and README §33 (Phase 4) were treated as binding.

### Decided by the project owner during planning

| Conflict or gap | Decision |
|---|---|
| Staffing template seeds: README §32 and plan §63 include them; README §33 says no staffing demand records | Default rules only. README §32 is annotated |
| Published changes: plan §22 suggests manager change commands; README §33 and CLAUDE.md say swap only | Swap only. A `schedule.swap.approve` holder can open a swap or record acceptance for an employee, because someone with no login, or who has left, can't |
| An employee becomes ineligible after being scheduled | Keep and flag. Coverage shows a hard violation, a draft can't publish, a published assignment moves by swap. The termination workflow is unchanged |
| Plan §35 shows "Active employee" to schedulers; Phase 3 made status Management-tier | One code, `EMPLOYEE_NOT_SCHEDULABLE`, labelled "Schedulable". Leave, suspension and termination aren't distinguished |

### Plan vs README conflicts resolved in README's favor

| Plan | Applied |
|---|---|
| §38 optional regeneration action | `GENERATE_DRAFT` requires an unassigned draft, with no regenerate action |
| §27, §30, §35 illustrative scores | The README §33 weights |
| §8 possible override of some rules | No override of hard constraints or availability. Soft rules only warn |

### Additions accepted with the plan

1. **Permissions:** the plan §44 codes plus `schedule.availability.self` and `.manage`. The catalog grew from 64 to 72.
2. **Role grants:** Owner, General Manager and Manager hold all `schedule.*`. Server, Bartender, Host, Cook, Wait Staff and Inventory Manager add `time-off.request`, `swap.request` and `availability.self`.
3. **Draft visibility:** without `schedule.edit`, `.generate` or `.publish`, a user sees only published and archived periods, and no coverage or explanations. Time-off reasons are visible only to the requester and approvers.
4. **Swap statuses:** `PENDING`, `ACCEPTED`, `COMPLETED`, `DENIED`, `CANCELLED`. The plan's optional `APPROVED` is dropped, because approval completes the swap in one transaction and records approver and time.
5. **Assignment history:** `status` is `ACTIVE`, `REMOVED` or `SWAPPED`, with `ended_at` and `ended_by_user_id`. Nothing is hard-deleted.
6. **Shift cancellation:** `cancelled_at` keeps the row, so re-applying a template can't bring it back.
7. **Rule additions:** `week_start_day` (Monday), hard flags for rest, days and consecutive days, and a nullable `maximum_weekly_hours`, which is always hard when set. The last goes slightly beyond the README's list.
8. **Definitions:** weekend is a Saturday or Sunday `shift_date`; opening starts before 11:00 local; closing ends at or after 22:00 local or past midnight; fairness looks back over the current period; the worked day is `shift_date`.

### Decided during implementation

| Choice | Reason |
|---|---|
| A window of 00:00 to 00:00 means the whole day | Otherwise "all day" can't cover a shift ending at midnight. The plan's "end at or before start runs past midnight" already implies it |
| Fairness is `+8 x (highest candidate count - this candidate's count)` | README §33 says "+8 per shift" without a comparison point |
| The manager path can request time off for an employee | Someone with no login can't request it otherwise. Plan §45 allows explicit targeting by managers. It's API only (see Remaining issues) |

### Hard and soft constraints

| Hard, no override | Soft, scores and warnings only |
|---|---|
| Schedulable (`ACTIVE`) | Target hours: below `+20`, at or above `-10` |
| Eligible at location on the date | Crossing overtime threshold `-50` |
| Holds the position at that location on the date | Preferred time, weekend, opening, closing: match `+12`, mismatch `-6` |
| Approved time off | Weekend and closing fairness: `+8` per shift |
| Availability covers the whole shift | Short rest, when rest is soft: `-18` |
| No overlapping assignment | Pending time off: `-24` |
| Maximum weekly hours, when set | Over a soft weekly-day limit: `-12` per day |
| Rest, days and consecutive days, when marked hard | Over a soft consecutive-day limit: `-15` per day |

Ties use employee number by code point, then UUID.

## Architectural decisions

- **One evaluator.** `rules/eligibility.ts` is pure and has no input for security roles or compensation, so neither can affect a decision.
- **A narrow HR door.** `employees/queries/scheduling-facts.ts` returns only ID, number, name, status, and location and position date ranges. A test pins the exact keys, and another checks the decision files import no restricted HR source.
- **Pure generator.** `generator/schedule-generator.ts` uses no clock, randomness or database. `services/scheduling-input.ts` assembles one normalized input before it runs.
- **Generation boundary (plan §42).** Insert a `STARTED` run, compute outside any transaction, then in one transaction lock the period, compare the version, rerun hard checks on fresh data, write assignments and complete the run. Any failure writes no assignments and marks the run `FAILED` with a safe code.
- **Locking order.** Period, then employees sorted by ID, so overlap, rest and limit checks hold across periods and locations without deadlocks.
- **Real instants.** Shifts store `TIMESTAMPTZ`, built by `shared/time/zoned-time.ts`. `shift_date` is a calendar date, not a business date, so `BusinessDateService`, which doesn't exist yet, isn't involved.
- **Rationale storage.** `shift_assignments.generation_rationale` holds hard checks and score reasons. The run holds the rules and weights snapshot, warnings, and per-slot counts by reason. Rejected candidates aren't stored individually.
- **Exact hours.** `NUMERIC(6,2)` decimal strings, converted to integer milliseconds by string parsing. Input with too many decimal places is refused rather than rounded.

### Architecture deviations

| Deviation | Reason |
|---|---|
| Scheduling routes use a new `requireApiActor` guard rather than `requireApiPermission` | Many have several valid permissions, such as self-service or manager access. Every service asserts its own permission, and direct-API E2E tests prove the refusal. A new `requirePageActorWithAny` does the same for pages |
| `db:reset` proven on a throwaway container rather than the real development database | It would have deleted your Owner account. The command, migrations and guard are the same |
| No outbox, audit rows or notifications | That infrastructure doesn't exist yet. Plan §21 says not to introduce it here |
| `.github/copilot-instructions.md` not used | `CLAUDE.md` replaces it, per the `/phase` instruction |

## Migrations

| Migration | Contents |
|---|---|
| `0004_scheduling.sql` | Generated and reviewed. 12 tables, 36 foreign keys, all `RESTRICT`. No changes to existing tables |
| `0005_scheduling_overlap_constraints.sql` | Custom. A partial exclusion constraint refusing two published periods sharing a date at a location |

| Check | Result |
|---|---|
| Generation | PASS |
| Application | PASS |
| Existing Phase 3 database to Phase 4 | PASS: your real development database upgraded with `db:migrate` and `db:seed`, keeping its 1 user |
| Empty DB reconstruction | PASS: automated test, plus a new empty PostgreSQL 17 container |
| Unexplained schema drift | NONE: a further `db:generate` reports no changes |

Your development database went from 64 permissions and 199 role-permission rows to 72 and 241. The 42 new grants match the plan: 8 each for Owner, General Manager and Manager, and 3 each for the six staff roles. It has 1 scheduling rules row and 0 staffing templates.

## Validation results

### Scheduling schema

| Table | Result |
|---|---|
| schedule_periods | PASS |
| shifts | PASS |
| shift_assignments | PASS |
| employee_availability | PASS |
| employee_availability_exceptions | PASS |
| employee_scheduling_preferences | PASS |
| time_off_requests | PASS |
| shift_swap_requests | PASS |
| staffing_templates | PASS |
| staffing_template_requirements | PASS |
| scheduling_rules | PASS |
| schedule_generation_runs | PASS |

### Manual scheduling

| Check | Result |
|---|---|
| Schedule period lifecycle | PASS |
| Shift creation | PASS: including past midnight and a rejected skipped local time |
| Manual assignment | PASS |
| Employee status eligibility | PASS: terminated, on leave, suspended |
| Location eligibility | PASS |
| Employee Position eligibility | PASS |
| Security Role cannot substitute for Position | PASS: both directions |
| Availability validation | PASS |
| Approved time-off validation | PASS |
| Overlap detection | PASS: including across dates and periods |
| Coverage analysis | PASS |
| Publishing | PASS |

### Employee scheduling inputs

| Check | Result |
|---|---|
| Recurring availability | PASS |
| Availability exceptions | PASS |
| Exception precedence | PASS |
| Preferences | PASS: never make anyone ineligible |
| Time-off workflow | PASS |
| Shift swaps | PASS |
| Self-service Employee scoping | PASS |

### Staffing configuration

| Check | Result |
|---|---|
| Staffing templates | PASS |
| Staffing requirements | PASS |
| Template-to-shift generation | PASS: repeat-safe, keeps edited and cancelled shifts |
| Scheduling rules | PASS |
| Seed idempotency | PASS: `2 applied`, then `0 applied, 6 already applied`, with identical counts |

### Automatic generator

| Check | Result |
|---|---|
| Deterministic output | PASS: pure input reordering, and two separately built databases |
| Shared hard eligibility logic | PASS |
| Hard constraints | PASS |
| Soft scoring | PASS |
| Target-hours scoring | PASS |
| Overtime avoidance | PASS |
| Rest handling | PASS: by real instants, including a daylight-saving night |
| Consecutive-day handling | PASS: including across a week boundary |
| Weekend fairness | PASS |
| Closing fairness | PASS |
| Stable tie-breaking | PASS |
| Generate Draft | PASS |
| Fill Open Shifts | PASS: the manual row is byte-for-byte unchanged |
| Manual assignments preserved | PASS |
| Manager overrides | PASS |
| No automatic publish | PASS |
| Generation concurrency | PASS: a manager's change mid-computation wins, and of two simultaneous runs one writes |
| Failure atomicity | PASS |

### Explainability

| Check | Result |
|---|---|
| Assignment hard-check reasons | PASS |
| Scoring reasons | PASS: the score equals the sum of its listed reasons |
| Unfilled-shift explanations | PASS: all reasons with counts, not a single claimed cause |
| Restricted HR data excluded | PASS: wage rows exist in the test, and no value appears in any output |
| Generation rules snapshot | PASS: rules and weights, no employee data |

### Authorization

| Check | Result |
|---|---|
| schedule.view | PASS |
| schedule.edit | PASS |
| schedule.generate | PASS: refused even with edit and publish |
| schedule.publish | PASS |
| Time-off self-service scoping | PASS |
| Swap self-service scoping | PASS |
| Direct unauthorized API access denied | PASS: E2E, generate and publish 403, coverage 403, a draft 404, with no permission 403, signed out 401 |

### Regression

| Check | Result |
|---|---|
| Phase 1 foundation tests | PASS |
| Phase 2 auth/RBAC tests | PASS |
| Phase 3 Employee/HR tests | PASS |
| `db:reset` safeguards | PASS |
| `/api/health` | PASS: 200 on a production build |

Real `npm run db:reset` refusals on the throwaway container, each exiting 1 with no password in the output and seed rows intact afterward: `NODE_ENV=production`, `NODE_ENV=test`, a fake RDS host, database `postgres`, database `restaurant_ops_test`, and `?host=` on a local URL. The successful reset then seed reproduced the same counts: 72 permissions, 241 role permissions, 1 rules row, 0 templates, employees and users.

Production build, signed out: `/api/scheduling/periods`, `/me` and `/rules` return 401, and `/scheduling` and `/my-schedule` redirect to `/login`.

### Validation

| Check | Result |
|---|---|
| PostgreSQL health | PASS |
| `npm ci` | PASS: the same 3 deprecation warnings as DEV-003, none new |
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 295 of 295 (baseline 195) |
| Integration tests | PASS: 448 of 448 (baseline 321) |
| E2E tests | PASS: 51 of 51 (baseline 39), three consecutive runs |
| Production build | PASS |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 12 moderate, unchanged, recorded as DEV-002 |
| GitHub Actions | PASS after one fix, reported by the owner following `7840586`. The first push failed 1 of 51 E2E tests (see Summary). This environment can't read the runs |

An earlier E2E run failed intermittently because my own test named which equally scored employee would win a tie, and the tie-break used random employee numbers. The test now asserts provenance instead. The product behaved correctly.

### Accepted risks

DEV-001: unchanged. DEV-002 and DEV-003: unchanged, and no dependencies were added.

### Business domains created beyond Phase 4

NONE. A migration test asserts the exact table list. No seating, reservation, menu, inventory, order, payroll or audit code exists.

## Tests executed

- **Unit (new, 100):** zoned time, including daylight-saving and leap-day cases; availability precedence and past-midnight cases (plan §53); eligibility (§52); scoring, tie-breaks and fairness (§54); coverage and unfilled explanations (§55, §56); the generator.
- **Integration (`tests/integration/scheduling/`):**
  - `manual-scheduling` (41): plan §57, §61, security role versus position, ineligible-after-scheduling, visibility.
  - `availability-time-off` (23): plan §58, self-service scoping, preferences.
  - `shift-swaps` (22): plan §59, manager-opened swaps, a terminated holder's shift.
  - `generation` (24): plan §60, staleness, failure, HR boundaries.
  - `staffing-config` (15): templates, rules, the HR boundary.
- **Integration (updated):** migrations, foundation seeds including a Phase 3 upgrade, seed registry.
- **E2E (`tests/e2e/scheduling.spec.ts`, 12):** all plan §62 scenarios, plus template and rules setup, a swap through approval, a time-off conflict shown before approval, signed-out and no-permission refusal, and phone-width layout.

**Partly covered:** plan §53 asks for "manual and generated assignment give an identical availability result". Both paths call the same function, and each has its own availability tests, but no single test compares the two on one input.

## Files changed

**Created**

- Schema and migrations: `src/db/schema/scheduling.ts`, `drizzle/migrations/0004_scheduling.sql`, `0005_scheduling_overlap_constraints.sql` and their snapshots
- Seeds: `src/db/seeds/scheduling-foundation.ts`
- Scheduling module: `src/modules/scheduling/` (`rules`, `generator`, `repositories`, `services`, `validators`, `types.ts`)
- HR query: `src/modules/employees/queries/scheduling-facts.ts`
- Time: `src/shared/time/zoned-time.ts`
- API: 42 Route Handlers under `src/app/api/scheduling/`
- UI: 7 pages under `src/app/(app)/scheduling/` and `src/app/(app)/my-schedule/`, `src/components/scheduling/`
- Tests: `tests/integration/scheduling/`, `tests/e2e/scheduling.spec.ts`, `tests/fixtures/{scheduling-fixtures,compensation-probe}.ts`, `tests/helpers/e2e-scheduling.ts`, unit tests beside the code
- Docs: this report

**Modified**

- Auth: `permission-catalog.ts` (72 codes), `role-catalog.ts`, `guards.ts`
- UI: `src/components/app-shell/navigation.ts`, `src/components/forms/action-button.tsx` (POST)
- Schema and seeds: `src/db/schema/index.ts`, `src/db/seeds/registry.ts`, `drizzle/migrations/meta/_journal.json`
- Tests: `navigation.test.ts`, `auth.test.ts`, `tests/e2e/auth.spec.ts`, `tests/fixtures/employee-fixtures.ts`, and the tests pinning the catalog, seeds and table list
- Docs: `README.md` §32 and §33, `docs/Database-Conventions.md`

The README §33 additions document the swap workflow, ineligible employees, definitions, rationale storage and permission codes.

## Risks

- **Two drafts for the same week block each other.** Overlap checks count every active assignment, draft or not, so one person can't be assigned at the same time in two competing drafts. This is the safe reading, but a manager comparing alternatives will hit it.
- **The generator is greedy, not optimal.** It fills shifts in priority and time order, and an early pick can leave a later shift unfillable when a different arrangement would have filled both. Plan §24 asks for deterministic logic, not optimization. Managers see the gap and can adjust.
- **Changing a rule doesn't touch published schedules.** Tightening a hard limit makes existing assignments show as violations in coverage, and they stay until moved by swap.
- **No audit rows.** Who approved a swap or published is on the row, but other changes, such as editing availability, record no actor. See Remaining issues, item 1.
- **Availability edits apply at once with no approval.** Plan §45 allows it where permitted. An employee can make themselves ineligible for a future draft.
- **The schedule page runs one candidate query per open shift.** Acceptable for a location's week. Measure before very large periods.
- **`btree_gist` on RDS** remains untested, as noted in Phase 3. Check it in Phase 14.

## Remaining issues

None of these block Phase 5.

1. **Where does the audit domain get built? Still your decision,** carried from Phase 3. The Phase 2 and 3 plans place full audit in Phase 12, but README §36's Phase 12 deliverables don't list it, and each phase adds more actions that need auditing.
2. **Some working APIs have no form yet.** Plan §46 lists what the UI must support, and these go beyond it: editing an existing shift or period, editing a recurring availability row (remove and add works), and a manager requesting time off for an employee. All have tested services and routes. Say if you want them before Phase 5.
3. **Prevent a repeat of the ignored-file failure, optional.** Local checks use the working folder, so they can't see a file git ignores. Running `git status --ignored` before a push, or validating from a clean clone, would catch it. `out/` and `uploads/` in `.gitignore` are also unanchored and could catch a future route folder with that name.
4. **Carried over, both optional:** the old `restaurant-ops-postgres-1` container and volume, and the stray `%USERPROFILE%\package-lock.json`. Next.js still warns about the second.

## Next-phase readiness

**Phase 5 readiness: READY,** subject to review of this report. CI is green, as reported by the owner. Published schedules and `ACTIVE` assignments are in place for the server-assignment policy in Phase 5's plan §25, which `shift_assignments.status` can answer directly.
