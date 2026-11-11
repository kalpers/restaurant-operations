PHASE 18 COMPLETION REPORT

# Phase 18: Labor and Tips

## Summary

Phase 18 records the hours people actually work and how the day's tips are shared. It adds four things:

- **A time clock.** Employees punch in and out on their own login. Managers punch for staff who have no login, and those punches are audited. Breaks, shift matching and idempotent retries are included. Corrections keep the original punch times.
- **Weekly overtime.** Hours are allocated to overtime over whole work weeks, with live warnings.
- **Actual-labor reports.** These sit next to the unchanged scheduled-labor sections.
- **A daily tip pool per location.** Tips are split by hours worked × position points, previewed, then finalized as an immutable snapshot. There is a Tips report.

Everything is record only: no payroll, pay periods or payouts. Plan: `docs/Phase-18-Labor-and-Tips.md` (owner-approved 2026-11-10, with amendment 3: time-clock audits use category `SCHEDULING`).

| Check | Result |
|---|---|
| Lint, typecheck, build | Clean |
| Unit | 776 of 776 passed (48 files) |
| Integration | 1243 of 1243 passed (76 files) |
| E2E | 140 of 140 passed, first full run, 0 flaky |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run db:generate` after the last change | "No schema changes" |

## Environment

- Node v26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17 (`postgres:17-alpine`, Docker Compose), Windows 11.
- No dependency was added or changed.

## Policies (as built)

- **Time entries, breaks, recorded vs. effective times.**
  - `time_entries` keep effective `clock_in_at`/`clock_out_at` beside `clock_in_recorded_at`/`clock_out_recorded_at`. The `time_entries_guard` trigger freezes the recorded instants and other punch facts, refuses deletes and refuses reopening a CLOSED entry. A VOIDED entry is terminal.
  - A clock-out a manager sets afterwards has source `ADJUSTMENT` and no recorded instant.
  - One OPEN entry per employee (partial unique index), and no overlapping non-voided entries (exclusion constraint `time_entries_no_overlap`).
  - Breaks must lie inside their entry and not overlap. This is checked at commit by deferred constraint triggers on both tables. Breaks are removed by `removed_at`, never deleted. Unpaid breaks are subtracted from worked time; paid breaks count.
- **Self and manager punches, shift matching, idempotency.**
  - Self punches resolve the employee from the login link; the request never carries an employee ID.
  - Eligibility means ACTIVE, at the location, and holding the position on the business date. It is checked with the Employees module's `findSchedulingFacts`.
  - Matching picks a PUBLISHED, ACTIVE assignment for the same position and location starting within ±60 minutes (closest wins, ties by assignment UUID). Otherwise the entry is unscheduled, which is allowed and flagged.
  - Clock-in, clock-out and breaks take idempotency keys (`timeclock.clock-in`, `timeclock.clock-out`, `timeclock.break`). Clock-in locks the employee row, so it serializes with termination.
- **Adjustments, void, missed clock-outs, termination check.**
  - A correction needs `timeclock.manage` and a reason. Each one writes an append-only `time_entry_adjustments` row with before/after values for every changed field (times, position, business date, shift match, breaks).
  - Times can't be in the future, and versions are checked.
  - Moving the clock-in across the cutoff recomputes the business date and the shift match.
  - Void keeps the row as VOIDED.
  - Missed clock-outs count zero hours until closed, and are listed on the board and in reports.
  - Terminating someone on the clock is refused (`EMPLOYEE_ON_CLOCK`).
  - Manager punches, adjustments and voids are audited (`timeclock.*`, category `SCHEDULING`). Self punches aren't.
- **Overtime rule, allocation and warnings.**
  - Weekly only, by business date: `scheduling_rules.weekly_overtime_threshold` and `week_start_day` (both existing), plus a new `overtime_multiplier` (default 1.50, from 1.00 to 3.00) and `late_clock_in_grace_minutes` (default 5). Both new settings are on the existing Staffing & rules form.
  - `allocateOvertime` makes later work overtime first and splits the entry that crosses the threshold.
  - Warnings are `NONE`, `APPROACHING` (within 4 hours) or `OVERTIME`. They show on `/my-time`, on clock-in and on the manager board, and never block.
- **Actual labor cost and wage privacy.**
  - Worked hours come from CLOSED entries.
  - Each entry is costed at the HOURLY rate in effect on its business date for the Employee + Position, through one shared SQL fragment (`compensationAt`) that the scheduled sections now use too. Regular cost is regular hours × rate; overtime cost is overtime hours × rate × multiplier. Cents are half-up per portion.
  - Salaried work and work with no rate show hours only.
  - Every cost figure and labor % needs `hr.compensation.view`.
- **Tip pool rule, split, finalize and void.**
  - One `tip_pool_rules` row per location, with `tip_pool_rule_positions` (points > 0, deactivated rather than deleted).
  - The pool is RECORDED tender tips on COMPLETED settlements of CLOSED orders on the business date.
  - `splitTipPool` shares the pool by worked seconds × points, in exact BigInt cents by largest remainder (ties: employee number, employee UUID, position code). The lines always sum to the pool.
  - Preview writes nothing. Finalize (`tips.finalize` idempotency) is refused while the date has OPEN orders or settlements (`OPEN_CHECKS_REMAIN`) or OPEN entries (`OPEN_TIME_ENTRIES`). It locks the rule row and the date's entries (`FOR SHARE`).
  - One FINALIZED distribution per location and date (partial unique index). Lines and the rule are snapshotted, and the guard trigger allows only FINALIZED → VOIDED.
  - While a date is finalized, its entries can't be created, corrected or voided (`TIP_DISTRIBUTION_FINALIZED`).
- **Report additions.**
  - Labor keeps the five Phase 12 sections first and unchanged. It then adds Actual labor, Actual labor by employee, Scheduled vs. actual (late, early out, unscheduled, no-show, over 16 h), Overtime by work week (whole weeks, so a date's figures don't depend on the range) and Time clock exceptions (missed clock-outs, adjustments with reasons, voids). The dashboard adds a Worked hours tile.
  - New Tips area (`reports.tips`): tips by date and tender with distribution status (Not distributed / Finalized / Changed after finalizing), direct tips by server, and finalized shares. All of it exports to CSV.

## Results

- Double clock-in impossible; retry returns first entry: **PASS** (`timeclock.test.ts`)
- Adjustment keeps recorded instants and history: **PASS** (`timeclock.test.ts`)
- Overtime allocation exact; range-independent: **PASS** (`time-clock.test.ts`, `actual-labor.test.ts`)
- Actual labor cost exact; hidden without compensation permission: **PASS** (`actual-labor.test.ts`)
- Scheduled labor output unchanged: **PASS** (`labor-and-dates.test.ts` unchanged apart from the new dashboard tile; section order asserted)
- Tip lines sum exactly to pool; one finalized per date: **PASS** (`tip-split.test.ts`, `tips.test.ts`)
- Finalize refused with open checks or open entries: **PASS** (`tips.test.ts`)
- Canonical Bacon Cheeseburger unchanged: **PASS** (`orders/submission.test.ts`, untouched)

## Architectural decisions

1. **Audit category `SCHEDULING`** for time-clock actions (amendment 3; owner decision). No CHECK change, and no change to the audit viewer.
2. **Ownership.** Scheduling owns `time_entries*` and exposes `queries/worked-time.ts` as the one source of worked time. Settlements owns `tip_*` and exposes `queries/tip-facts.ts` to the time clock. Finalizing crosses both, so it is a workflow (`src/workflows/finalize-tip-distribution`).
3. **The shared compensation lookup** (`reporting/queries/compensation-at.ts`) replaced the inline LATERAL in the scheduled labor query, with identical SQL semantics.
4. **No outbox events or realtime** for the time clock (policy A12). The manager board re-reads on a 60-second interval, skipped while a form is focused or a correction panel is open.
5. **The Phase 17 permission seed's body moved into a shared helper** (`db/seeds/permission-grants.ts`) used by both the Phase 17 and Phase 18 seeds. Keys and behavior are unchanged.
6. **Scheduling-rule changes are still not audited.** No audit action existed for them, and the plan's "existing audit" for the new settings didn't exist. Left as it was.
7. **The manager adjust form sends only filled fields.** A `datetime-local` input has no seconds, so re-sending an unchanged time would have truncated it.
8. **Validation seed.** The Phase 18 step runs under its own key (`phase18.validation-labor-tips`), so databases seeded before Phase 18 get it too.

## Migrations

| File | Kind | Contents |
|---|---|---|
| `0035_labor_tips.sql` | Generated | `time_entries`, `time_entry_breaks`, `time_entry_adjustments`, `tip_pool_rules`, `tip_pool_rule_positions`, `tip_distributions`, `tip_distribution_lines`; `scheduling_rules.overtime_multiplier` and `late_clock_in_grace_minutes` with checks |
| `0036_labor_tips_guards.sql` | Custom | `time_entries_no_overlap` exclusion; `time_entries_guard`; deferred break-inside-entry and break-overlap constraint triggers; break guard; append-only adjustments and distribution lines; `tip_distributions_guard` |

Both migrations were reviewed and applied to the dev database. Reconstruction from all migrations passes, and so does the new upgrade-from-Phase-17 test (empty new tables, column defaults, triggers present).

## Validation results

- `npm run lint`: clean. `npm run typecheck`: clean. `npm run build`: succeeded (the new routes `/my-time`, `/scheduling/time-clock`, `/tips`, `/api/timeclock/*`, `/api/tips/*` built).
- `npm audit --omit=dev`: 0 vulnerabilities; no dependency changes.
- `npm run db:generate` after the last schema change: "No schema changes, nothing to migrate".
- `npm run db:seed` twice on the dev database: first run "1 applied, 20 already applied" (the new `security.labor-tips-permissions`), second "0 applied, 21 already applied".
- `npm run db:reset` with a database not named `restaurant_ops`: refused ("the database must be named restaurant_ops").
- grep: audit allow-lists for `timeclock.*` and `tips.*` hold employee number, position code, dates, changed field names, reasons and pool totals. They never hold an hourly rate or a per-employee tip amount, and no new log line carries either.
- Integration: `npm run test:integration`, 1243 of 1243 passed in 76 files (the final full run, after E2E). Earlier runs failed only on counts and lists this phase changes (permission totals, seed keys, the table list, the new dashboard tile, the new report area), and those were updated. One run failed because local PostgreSQL wasn't running.
- E2E: `npm run test:e2e`, 140 of 140 passed (9.8 min), 0 flaky. One earlier run of the two Phase 18 specs failed in the day spec's audit step. Linking the server's login to an employee makes the audit viewer show the employee's name instead of the email (existing behavior), so the spec now matches on the name. The known "Outbox batch failed" webServer log line (Phase 17 remaining issue) appeared and isn't a failure.

## Tests executed

- **Unit:** 776 (Phase 17: 755). New: `scheduling/rules/time-clock.test.ts` (16: worked hours, shift matching, overtime allocation, warning edges, flags) and `settlements/rules/tip-split.test.ts` (5). Updated: the permission catalog count (137) and the navigation tests.
- **Integration:** 1243 tests in 76 files (Phase 17: 1210). New: `scheduling/timeclock.test.ts` (18), `settlements/tips.test.ts` (4, including the Tips report), `reporting/actual-labor.test.ts` (7), the Phase 17 → 18 seed upgrade and the migration upgrade test. Updated: seed counts and keys, table and exclusion lists, report grants, the validation-seed test (labor step, run twice).
- **E2E:** new `labor-tips.spec.ts` (2), which runs on a location of its own:
  - a manager fixes a missed clock-out, punches in and out an employee with no login, sees the Adjusted entry, sets up the pool, finalizes tips, and is refused a correction on the finalized date;
  - a Server is refused the time clock, Tips and the Tips report, on the pages and through the APIs.

  `restaurant-day.spec.ts` was extended: the server clocks in on `/my-time` before service and out after the table is cleaned, the manager sees the server's share in today's pool preview, and the owner sees the server in Actual labor by employee.

## Files changed

- **Schema and migrations:** `src/db/schema/timeclock.ts`, `tips.ts` (new), `scheduling.ts`, `index.ts`; `drizzle/migrations/0035*`, `0036*`, meta.
- **Seeds:** `src/db/seeds/labor-tips-permissions.ts`, `permission-grants.ts` (new), `checks-closeout-permissions.ts`, `registry.ts`.
- **Auth:** `permission-catalog.ts`, `role-catalog.ts`.
- **Auditing:** `audit-actions.ts`.
- **Scheduling:** `rules/time-clock.ts`, `queries/worked-time.ts`, `services/timeclock-service.ts`, `validators/timeclock-validators.ts` (new); `rules/schedule-rules.ts`, `services/config-service.ts`, `services/scheduling-input.ts`, `validators/scheduling-validators.ts`.
- **Settlements:** `rules/tip-split.ts`, `queries/tip-facts.ts`, `services/tip-service.ts`, `validators/tip-validators.ts` (new).
- **Reporting:** `queries/actual-labor-report.ts`, `compensation-at.ts`, `tips-report.ts` (new); `labor-report.ts`, `services/report-service.ts`, `types.ts`.
- **Workflows:** `finalize-tip-distribution/` (new); `terminate-employee/terminate-employee.ts`.
- **API:** `src/app/api/timeclock/*` and `src/app/api/tips/*` (new).
- **UI:** `src/app/(app)/my-time`, `scheduling/time-clock`, `tips` (new); `reports/page.tsx`, `scheduling/staffing/page.tsx`; `src/components/timeclock/*` (new); `app-shell/navigation.ts`, `nav-icons.tsx`.
- **Validation seed:** `scripts/validation-labor.ts` (new), `scripts/seed-validation.ts`, `src/db/demo/validation-fixture.ts`.
- **Tests:** listed under Tests executed, plus `tests/fixtures/timeclock-fixtures.ts`, `tests/helpers/e2e-timeclock.ts` (new), `tests/fixtures/order-cleanup.ts` (clears the new tables with their guards lifted) and `tests/fixtures/restaurant-day.ts`.
- **Docs:** `README.md` (sections 11, 19, 21, 33, 36), `CLAUDE.md` (phase list, scheduling, reporting and tips summaries), `docs/User-Guide.md`, `docs/Phase-13-Validation-Seed-Data.md`, `docs/Phase-18-Labor-and-Tips.md`, this report.

## Risks

- **Tips recorded after finalizing.** If a check on a finalized date were still able to close later, its tips would miss the pool. Finalize refuses while the date has any open check, so a new tip on that date can only come from a check opened afterwards on the same business date, for example finalizing today mid-service. The Tips report marks such a date "Changed after finalizing", and the fix is to void and finalize again. Finalizing the current business date isn't refused, because the plan allows it.
- **After finalizing today, nobody can clock in again today** (policy A8). This is by design, but it can surprise an operator who finalizes early. The Tips page says the date's hours freeze.
- **Concurrency between a correction and a finalize.** The finalize takes `FOR SHARE` locks on the date's entries, and corrections lock their entry `FOR UPDATE`. A correction that moves an entry *into* a date while that date is being finalized isn't covered by those locks. That needs both at the same instant; the result would be one entry's hours missing from a snapshot, fixable by void and redo.
- **Very short entries with fractional points.** `tip_distribution_lines` requires `weighted_hours > 0` at 4 places, so an entry of a few seconds at very low points could round to zero and fail the check. That isn't reachable in practice (1 second × 1 point = 0.0003 h).
- **The E2E time clock helpers write rows directly** (as the services would) to place entries in the past. The E2E specs check the screens. The integration tests cover the services themselves.

## Remaining issues

- Manager break editing exists in the API (`breaks` changes on PATCH) but has no form on the time-clock page. Times and position can be corrected on screen.
- The day spec previews, but doesn't finalize, MAIN's pool: other specs on a parallel worker leave open checks at MAIN. Finalizing is covered end-to-end by `labor-tips.spec.ts` on its own location. This is a deviation from plan section 7.
- Carried over from Phase 17 and unchanged: the `migrations.test.ts` default timeout question, browser-local times in some panels (the new adjust form's `datetime-local` fields use the browser's time zone too), and the Playwright webServer/globalSetup ordering log line.
- Out of scope by plan: payroll, payouts, daily overtime, cash tip declarations, PIN/kiosk punching, notifications for overtime or missed clock-outs, and everything in Phase 19.

## Next-phase readiness

Phase 18 is complete once this report is reviewed. Phase 19 (Menu and Stock Signals: par levels and low-stock alerts, suggested POs, the 86 board, sales-by-hour, server performance, item mix and void/comp/discount reports) is named in README section 36 but has no plan yet. It needs `docs/Phase-19-*.md` and the owner's approval before it starts. Nothing in Phase 18 prepares for it. Cloud deployment remains on hold.
