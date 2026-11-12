# Phase 18: Labor and Tips Design and Implementation Plan

## Purpose

Phase 18 records the hours people actually work and what happens to the tips. Today:

- **Labor is scheduled, not worked.** The Phase 12 labor report costs published shift assignments (README section 33, Phase 12 policies). Nothing records when anyone arrived or left, so scheduled and actual hours can't be compared, overtime can't be seen while it's happening, and labor cost is an estimate.
- **Tips stop at the tender.** `settlement_tenders.tip_amount` records each CASH and EXTERNAL_CARD tip, and the Phase 17 drawer close-out lists cash tips "for information". Nothing says who the tips belong to, and no report shows tips by server or by business date.

Phase 18 was added by owner decision on 2026-11-10. The owner split the Tier 2 list into Phase 18 (labor and tips) and Phase 19 (menu and stock signals: par levels and low-stock alerts, suggested purchase orders, the 86 board, and the sales and menu reports). Phase 19 isn't planned here, and nothing in this phase prepares for it.

It changes these written contract points, which the owner approves with this plan:

- README section 21 and the Phase 12 notes in section 33: labor is no longer only "scheduled, not clocked". The scheduled labor sections stay exactly as they are. Actual labor is added next to them.
- README section 39 keeps **payroll processing** as a future capability. Phase 18 records tip distributions and reports hours and costs. It produces no pay stubs, pay periods, payroll exports, tax withholding or payouts (policy 30).

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially sections 10 (Employees and HR: sensitivity tiers, compensation), 11 (Scheduling), 19 (Settlement), 21 (Reporting), 24 (Transaction Boundaries), 25 (Concurrency), 29 (Business Date) and the Phase 3, 4, 11, 12 and 17 notes in section 33.
2. Read the Phase 3, 4, 11 and 12 plans and completion reports: employee and user links, the eligibility evaluator, compensation by Employee + Position, tender tips, and the labor report with its wage privacy rule.
3. Read `docs/accepted-risks.md`. This phase should add no dependency.

## Approved Phase 18 Policies

### A. Time clock

1. **Ownership.** The Scheduling module owns the time clock, because time entries are matched to shifts. Attendance is Management-tier HR data (README section 10). Viewing other people's entries needs `timeclock.view` (policy 26).
2. **Time entries.** `time_entries`:
   - employee, location, position worked, optional `shift_assignment_id`;
   - `business_date` (from `BusinessDateService` and the clock-in instant; the whole entry belongs to that business date, even past midnight);
   - `status` `OPEN`, `CLOSED` or `VOIDED`;
   - `clock_in_at`, `clock_out_at` (null while OPEN): the *effective* times, which reports use;
   - `clock_in_recorded_at`, `clock_out_recorded_at`: the original punch instants, written once and never changed (trigger). An adjusted entry keeps both the original and the corrected times;
   - `clock_in_source`, `clock_out_source`: `SELF` or `MANAGER`, plus the acting user for each;
   - void fields (by, at, reason), `version`.

   Constraints: `clock_out_at > clock_in_at`. A partial unique index allows one OPEN entry per employee (at any location). An exclusion constraint forbids overlapping non-voided entries for one employee (`tstzrange(clock_in_at, COALESCE(clock_out_at, 'infinity'))`).
3. **Breaks.** `time_entry_breaks`: entry, `started_at`, `ended_at` (null while on break), `paid BOOLEAN`, and the user who recorded it. At most one open break per entry. Breaks lie inside the entry. Unpaid breaks are subtracted from worked hours, and paid breaks aren't. Clocking out ends an open break at the same instant.
4. **Who punches.** No PIN or shared kiosk login (rule 15 forbids storing PINs).
   - *Self:* the signed-in user's linked Employee clocks in and out on `/my-time` (`timeclock.punch`). It's refused if the user has no linked Employee, the Employee isn't ACTIVE, isn't eligible at the location, or doesn't hold the chosen position (`TIMECLOCK_NOT_ELIGIBLE`). The eligibility checks reuse the Employees module's rules, not a copy.
   - *Manager:* `timeclock.manage` can clock any eligible employee in or out at the location. This covers staff with no login. Manager punches are audited.
5. **Clock in.**
   - The employee picks a position they hold, or the only one is used.
   - The server links the entry to the employee's ACTIVE assignment in a PUBLISHED period when that shift is for the same position, at this location, and starts within 60 minutes either side of the clock-in. If several match, the one starting closest is used (ties: assignment UUID). If none matches, the entry is **unscheduled**. That's allowed and flagged, not refused.
   - Clocking in early or late is allowed, and reports flag it (policy 20).
   - The response carries warnings: unscheduled, and overtime state (policy 17).
6. **Clock out.** Closes the caller's OPEN entry (self) or a named entry (manager), checking `version`.
7. **Forgotten clock-outs.** An entry is never closed automatically, and the system never invents a time. An OPEN entry from an earlier business date shows as **missed clock-out** on the manager's time clock page and in reports, and it counts zero hours until a manager closes it with an adjustment.
8. **Adjustments.** A manager (`timeclock.manage`) corrects an entry with a required reason. They can set or change the clock-in or clock-out time, change the position, or add, change or remove breaks.
   - Each adjustment writes an append-only `time_entry_adjustments` row in the same transaction: entry, adjusted by and at, reason, and the before and after values of every changed field, as JSON from an allow-list.
   - Corrected times can't be in the future, and the overlap constraint still applies.
   - Changing the clock-in recomputes `business_date` and the shift match.
   - An entry whose business date has a FINALIZED tip distribution can't be adjusted, voided or created until that distribution is voided (`TIP_DISTRIBUTION_FINALIZED`).
9. **Void.** A manager voids an entry made by mistake, with a reason. It stays as VOIDED and counts nowhere.
10. **Termination.** Terminating an employee who is on the clock is refused (`EMPLOYEE_ON_CLOCK`). A manager clocks them out first. This keeps the Phase 3 termination transaction unchanged apart from the check.
11. **Concurrency and idempotency.** Clock in, clock out, break start and break end take a client idempotency key (scopes `timeclock.clock-in`, `timeclock.clock-out`, `timeclock.break`). A retry over a bad connection returns the first outcome and never creates a second entry. Adjustments and voids check `time_entries.version` (`CONCURRENCY_CONFLICT`). The partial unique index is the final guard against a double clock-in.
12. **Events.** Audit, category `LABOR`:
    - `timeclock.manager-clock-in` and `timeclock.manager-clock-out`;
    - `timeclock.entry-adjusted` (entry ID, employee number, changed field names, reason);
    - `timeclock.entry-voided`.

    Self punches aren't audited, because the entry is the record. No outbox event and no realtime: the manager page reads current state when it loads and refreshes on an interval.

### B. Overtime

13. **Rule (business configuration, not a labor-law claim).** Weekly overtime only: worked hours above `scheduling_rules.weekly_overtime_threshold` (existing, default 40) in a work week. Weeks start on `scheduling_rules.week_start_day` (existing) and are counted by **business date**. Daily overtime, double time and state-specific rules aren't built.
14. **Multiplier.** New column `scheduling_rules.overtime_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.50`, which must be at least 1.00. It's edited on the existing scheduling rules form under the existing permission and audit.
15. **Allocation** (pure rule `allocateOvertime` in `src/modules/scheduling/rules/`). The week's CLOSED entries are ordered by `clock_in_at` (ties: entry UUID). Worked hours accumulate, and the hours past the threshold are overtime. An entry that crosses the threshold is split, so later work is overtime first. Hours are exact to the second, then rounded half-up to 4 places at output.
16. **Range edges.** A report range that starts or ends mid-week computes overtime over the whole week, so the figures for a date never depend on the range chosen. Only the dates in range are shown.
17. **Warnings.** The overtime state uses the employee's closed hours this week plus the open entry's elapsed hours. It's `NONE`, `APPROACHING` (within 4 hours of the threshold) or `OVERTIME`. It shows on clock-in, on `/my-time`, and next to each person on the clock on the manager's time clock page. Warnings never block a punch. No notification is sent.

### C. Actual labor cost and reports

18. **Worked hours** = (`clock_out_at` − `clock_in_at`) − unpaid break time, over CLOSED entries only. OPEN and VOIDED entries count zero, and OPEN entries are listed separately.
19. **Cost.**
    - Each entry is costed at the HOURLY `employee_position_compensation` rate in effect on its business date for that Employee and the Position worked. This is the existing lookup, shared with scheduled labor rather than copied.
    - Regular cost = regular hours × rate. Overtime cost = overtime hours × rate × multiplier, cents half-up per entry portion.
    - SALARY work and work with no rate show hours only, as in Phase 12.
    - Every cost figure, including labor % of net sales, needs `hr.compensation.view` as well as `reports.labor` (the Phase 12 wage privacy rule). Without it, labor is hours only.
20. **New labor report sections** (next to the unchanged scheduled sections):
    - *Actual labor:* worked hours, regular and overtime hours, regular, overtime and total cost, and labor % of net sales.
    - *Scheduled vs. actual*, by business date and employee: scheduled hours, worked hours, variance; flags for unscheduled entries, no-shows (an assignment with no entry), clock-in more than `scheduling_rules.late_clock_in_grace_minutes` after the shift start (new column, default 5), clock-out more than that grace before the shift end, and entries over 16 hours.
    - *Overtime by employee and week.*
    - *Exceptions:* missed clock-outs, adjusted entries (count and reasons), voided entries.
    - All sections export to CSV. No materialized view.

### D. Tips

21. **Ownership.** The Settlements module owns tip rules and distributions, because tips come from tenders. Hours come from the Scheduling module's public query. A workflow, `src/workflows/finalize-tip-distribution.ts`, does the cross-domain orchestration.
22. **What counts as a tip.** RECORDED tender tips on COMPLETED settlements of CLOSED orders. A tip belongs to the order's `business_date` and location. A CLOSED order is frozen, so its `assigned_server_employee_id` is fixed and identifies the server for direct-tip reporting. Refunds never change tips (Phase 17: tips aren't refundable). No separate cash tip declaration is built.
23. **Pool rule.** `tip_pool_rules`: one per location, with `active`, `version` and an optional `name`. `tip_pool_rule_positions` holds position and `points NUMERIC(6,2) > 0` (for example Server 10, Bartender 10, Busser 5, Host 3). When the rule is active, **all** tips for the business date go into one pool shared by the hours worked in the participating positions. Positions not listed get no share. Changing the rule never changes a finalized distribution (rule 4: lines snapshot the points used).
24. **Distribution** (pure rule `splitTipPool` in `src/modules/settlements/rules/`). Each participant line (Employee + Position for the date) gets weighted hours = worked hours × points. Share = pool × weighted hours ÷ Σ weighted hours. Cents go by largest remainder (ties: employee number, then employee UUID, then position code), so the lines add up exactly to the pool. If nobody participating worked, or the pool is zero, there are no lines and nothing is distributed. Finalize is still allowed (policy 25) and records zero.
25. **Preview and finalize.**
    - `GET` returns a computed preview and writes nothing.
    - `POST …/finalize` (idempotency scope `tips.finalize`) writes `tip_distributions`: location, business date, `status` `FINALIZED` or `VOIDED`, pool total, cash and card tip subtotals, total weighted hours, a rule snapshot, finalized by and at, void fields, `version`. It also writes `tip_distribution_lines`: employee, position, worked hours, points, weighted hours, share. Both are append-only apart from the void change (trigger).
    - A partial unique index allows one FINALIZED distribution per location and business date.
    - Finalize is refused while the business date still has OPEN orders or OPEN settlements (`OPEN_CHECKS_REMAIN`), or OPEN time entries (`OPEN_TIME_ENTRIES`), because the pool or the hours could still change.
    - Void (with reason) allows a corrected re-finalize. The voided row and its lines stay.
26. **Permissions.** Five new codes, 137 in all:
    - `timeclock.punch`: clock self in and out, take breaks, see own entries, own week-to-date hours and own finalized tip shares. Held by all nine roles.
    - `timeclock.view`: see everyone's entries at the location. Owner, General Manager, Manager.
    - `timeclock.manage`: punch for others, adjust, void. Owner, General Manager, Manager.
    - `tips.manage`: pool rule, preview, finalize, void. Owner, General Manager, Manager.
    - `reports.tips`: the Tips report area. Owner, General Manager, Manager.

    Per-employee tip figures appear only behind `tips.manage` or `reports.tips`, apart from each employee's own shares on `/my-time`. An idempotent `security.labor-tips-permissions` seed adds the codes and grants.
27. **Events.** Audit `tips.rule-changed` (position codes and points), `tips.distribution-finalized` (business date, pool total, line count) and `tips.distribution-voided`, category `SETTLEMENTS`. Audit details never list per-employee amounts.
28. **Tips report** (new area `tips`): tips by business date and tender type, direct tips by server, and finalized distributions by employee and position (hours, points, share). Dates with tips but no finalized distribution are listed as *not distributed*. Exports to CSV.

### E. Boundaries

29. **Rule 4.** Hours come from time entries, costs from the compensation history in effect on each date, and tip shares from finalized snapshots. Nothing is recalculated from current configuration, apart from the live overtime warning.
30. **Not payroll.** No pay periods, pay stubs, gross-to-net, withholding, tip credit or minimum-wage calculations, payroll export, or tip payout records. Overtime multiplier and pool points are business configuration, and the UI says so.

## Amendments decided later

- **2026-11-11, Phase 20 (owner decision):** daily overtime, cash tip declarations and notifications for overtime and missed clock-outs, listed as out of scope in section 2, were built in Phase 20. Policy D22's "no separate cash tip declaration" and policy B17's "no notification is sent" are superseded. See `docs/Phase-20-Service-Polish-and-Deferred-Features.md`.

## Amendments decided at planning

Decided on 2026-11-10, when Phase 18 was planned:

1. **Owner decisions:** Tier 2 split into Phase 18 (labor and tips) and Phase 19 (menu and stock signals).
2. **Recorded, not asked:** no PIN or kiosk mode (rule 15); entries keep original punch instants beside the effective times; weekly overtime only; one daily pool per location; finalize and void instead of an editable draft.

Decided on 2026-11-10, when `/phase 18` was planned (owner approved the execution plan):

3. **Audit category.** `AUDIT_CATEGORIES` has no `LABOR`. Time clock actions use `SCHEDULING`, because the Scheduling module owns the time clock, so the category CHECK and the audit viewer's filter are unchanged. Wherever this plan says category `LABOR`, read `SCHEDULING`.

## 1. Objectives

Deliver:

- Time entries, breaks, adjustments and voids, with self and manager punches, shift matching and idempotent retries
- Overtime allocation, live warnings, the overtime multiplier and the late-grace setting
- Actual labor, scheduled vs. actual, overtime and exceptions report sections, with wage privacy
- Tip pool rules, preview, finalize and void with exact cent allocation, and the Tips report area
- Five new permissions (137 in all), role grants and the idempotent seed
- UI: `/my-time` (clock in/out, breaks, week-to-date hours, overtime state, own tip shares); `/scheduling/time-clock` for managers (on the clock now, missed clock-outs, entries by date, adjust, void, punch for others); `/tips` (pool rule, preview, finalize, void, history); the new report sections and the Tips area; navigation entries by permission
- README, CLAUDE.md and User Guide updates, and `docs/Phase-18-Completion-Report.md`

## 2. Scope Boundary

Out of scope (don't build):

- Payroll of any kind (policy 30), tip payout or tip-out to the house
- Daily overtime, double time, meal-break compliance rules, predictive scheduling penalties
- PIN pads, kiosk mode, badge, biometric or geofenced punching
- Cash tip declarations; tip pools per shift or per area; multiple pools per location
- Notifications for overtime or missed clock-outs (in-page warnings only)
- Anything from Phase 19 (par levels, low-stock alerts, suggested POs, 86 board, sales-by-hour, server performance, item mix, void/comp abuse reports)
- Cloud deployment (on hold)

## 3. Review Existing Foundation Before Changes

Confirm from code rather than memory:

- `src/modules/reporting/queries/labor-report.ts` and `rules/labor-cost.ts`: share the compensation lookup and the cost rule with actual labor instead of copying them. Scheduled sections must stay byte-for-byte the same in output.
- The eligibility evaluator and the Employees module's eligibility checks (ACTIVE, location, position): reuse them for punching.
- `scheduling_rules` (overtime threshold, week start) and its form, service, validator and audit allow-list.
- The Phase 3 termination transaction: where the on-the-clock check goes.
- `BusinessDateService`, the idempotency record helpers and their scopes.
- `my-schedule-service` and `/api/scheduling/me`: the pattern for "my" data resolved from the signed-in user's linked Employee.
- `src/modules/auditing/audit-actions.ts`: whether a `LABOR` category exists. If it doesn't, add it, or stop and propose `SCHEDULING` if a new category conflicts with the audit viewer's filters.
- The `audit_events_action_format` and `outbox_events_event_type_format` CHECKs: `timeclock` and `tips` are single words, so they fit.
- The demo and validation seeds, and `tests/integration/database/migrations.test.ts`.

If any of these conflicts with the policies above, stop and explain before changing it.

## 4. Build Order

Each step generates its own migration with `npm run db:generate` (plus custom migrations for triggers and exclusion constraints), reviewed before applying. Migrations start at 0035. Each step leaves lint, typecheck, and unit and integration tests green before the next starts.

1. **Time clock:** tables, constraints and triggers; clock in/out, breaks, shift matching, adjustments, void, the termination check; permissions seed (all five codes at once).
2. **Overtime:** the `scheduling_rules` columns, `allocateOvertime`, the warning state.
3. **Labor reports:** actual, scheduled vs. actual, overtime, exceptions, CSV.
4. **Tips:** rule tables, `splitTipPool`, the finalize workflow, void, the Tips report area.
5. **UI and E2E.**
6. **Validation seed:** time entries and a finalized distribution for the validation fixture day.
7. **Documentation and the completion report.**

## 5. Unit Tests

- *Worked hours:* unpaid vs. paid breaks, an entry past midnight, to-the-second rounding.
- *Overtime allocation:* below, at and across the threshold; an entry split at the threshold; several positions in one week with different rates; ties by UUID; week start on each weekday; a range starting mid-week gives the same figures for a date.
- *Overtime warning:* NONE, APPROACHING and OVERTIME edges, including the open entry's elapsed time.
- *Shift matching:* ±60-minute window, position and location must match, closest wins, tie by UUID, none gives unscheduled.
- *Tip split:* exact sum by largest remainder; ties by employee number, UUID, position; zero pool; no participants; one employee in two positions.
- *Validators:* times not in the future, reason required, points and multiplier ranges, money strings.

## 6. Integration Tests

- **Time clock:**
  - self clock-in links the matching assignment; an unscheduled clock-in is allowed and flagged;
  - refused with no linked Employee, an inactive or ineligible employee, or a position not held;
  - a second clock-in is refused, and a retry with the same key returns the first entry;
  - the overlap constraint refuses a manual overlap;
  - an adjustment keeps the recorded instants and writes the before and after values;
  - adjusting the clock-in across the cutoff moves the business date;
  - void excludes the entry everywhere;
  - termination is refused while on the clock;
  - a Server can't adjust or see others' entries (API refuses);
  - audit details hold only allow-listed fields.
- **Labor reports:**
  - actual hours and cost exact against a fixture with breaks, an overtime week and two positions;
  - without `hr.compensation.view` no cost or labor % appears;
  - scheduled sections unchanged from Phase 12 output;
  - no-show, late, early-out, unscheduled and missed clock-out flags;
  - a later compensation change doesn't change past cost.
- **Tips:**
  - the pool equals the RECORDED tips of CLOSED orders on the date, and tips on voided tenders or other dates don't count;
  - finalize is refused with open checks, open settlements or open entries;
  - lines add up exactly to the pool;
  - one FINALIZED per date, and a retry returns the first;
  - void then re-finalize works;
  - adjusting an entry on a finalized date is refused;
  - changing the rule after finalize leaves the snapshot unchanged;
  - the Tips report matches the fixture, with permission and location scoping.
- **Canonical scenario:** the Bacon Cheeseburger test still passes unchanged.
- **Migrations:** reconstruction from all migrations and the upgrade-from-Phase-17 checks pass. Existing `scheduling_rules` rows get the multiplier and grace defaults.

## 7. E2E Tests (Playwright)

- **`restaurant-day.spec.ts` (extended):** the server clocks in on `/my-time` at the start of the day and clocks out at the end. After the day's checks close, the manager finalizes the tip pool. The labor report shows actual hours next to scheduled, and the Tips report shows the distribution.
- A manager time clock flow: clock in an employee with no login, fix a missed clock-out with a reason, and see the adjustment in the exceptions section.
- A Server can't see `/scheduling/time-clock`, `/tips` or the Tips report, and the APIs refuse them. A Server sees only their own entries and shares on `/my-time`.
- Every existing spec still passes.

## 8. Documentation

- **README section 11:** the time clock tables and policies.
- **README section 19:** tips, pool rules and distributions.
- **README section 21 and the Phase 12 notes:** actual labor next to scheduled, and the Tips area.
- **README section 33:** a "Phase 18 Labor and Tips" note with the policies as built.
- **README section 36 and the `CLAUDE.md` phase list:** Phase 18, plus a one-line Phase 19 entry as planned next (added when this plan is approved). The `CLAUDE.md` reporting and scheduling summaries are updated at completion.
- **`docs/User-Guide.md`:** clocking in and out, breaks, fixing a missed clock-out, setting up the pool, finalizing tips.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` (stop `npm run dev` first)
- [ ] `npm run build`
- [ ] `npm audit --omit=dev` clean (no dependency added)
- [ ] Migrations generated, reviewed and committed; `npm run db:generate` then reports no changes
- [ ] Migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] The canonical Bacon Cheeseburger test passes unchanged
- [ ] `grep` confirms no compensation rate or per-employee tip amount reaches logs or audit details

## 10. Required Phase 18 Completion Report

Write `docs/Phase-18-Completion-Report.md`:

```text
PHASE 18 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Time entries, breaks, recorded vs. effective times:
- Self and manager punches, shift matching, idempotency:
- Adjustments, void, missed clock-outs, termination check:
- Overtime rule, allocation and warnings:
- Actual labor cost and wage privacy:
- Tip pool rule, split, finalize and void:
- Report additions:

Results
- Double clock-in impossible; retry returns first entry: PASS / FAIL
- Adjustment keeps recorded instants and history: PASS / FAIL
- Overtime allocation exact; range-independent: PASS / FAIL
- Actual labor cost exact; hidden without compensation permission: PASS / FAIL
- Scheduled labor output unchanged: PASS / FAIL
- Tip lines sum exactly to pool; one finalized per date: PASS / FAIL
- Finalize refused with open checks or open entries: PASS / FAIL
- Canonical Bacon Cheeseburger unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
