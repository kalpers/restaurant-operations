# Phase 14 Completion Report

Results are from this repository on 2026-11-10. The plan is `docs/Phase-14-Schedule-Timeline.md`, and its approved policies and planning amendments were treated as binding.

## Summary

Phase 14 is implemented and validated locally, apart from one existing test-timing problem described under Validation results. The new **Timeline** page shows one day's schedule at the current Location as a Gantt chart. It groups rows by employee or by position, shows unfilled places as hatched **Open** bars, and has an hourly headcount strip. Selecting a bar opens a details panel: a side panel on desktop and a bottom sheet on a phone.

Managers who review schedules also see:
- drafts;
- approved and pending time off;
- how each assignment was made, and the "Why this assignment" explanation;
- notes;
- open swaps;
- current problems with the assignment;
- the person's scheduled hours.

Everyone else with `schedule.view` sees only published and archived schedules, and the server never sends them the extra fields.

The phase adds no table, column, migration, permission or dependency, and it writes nothing.

**Not yet confirmed:**
- **CI:** nothing has been pushed, and this environment can't read GitHub Actions.
- **Migration-upgrade tests:** an existing integration test file times out intermittently on this machine. It isn't caused by this phase (see Validation results and Remaining issues, item 1).

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |

No dependencies were added or changed.

## Policies (as built)

### Decided by the project owner

| Question | Decision |
|---|---|
| Placement | A new Phase 14. AWS deployment moves to Phase 15 and AWS acceptance to Phase 16 |
| Dark mode, which the plan asked for but the app doesn't have | Light only, matching the app |
| "Who assigned it". Users have only an email, which is a contact detail | Dropped. The panel shows the source and the time it was assigned |
| Shift and station notes, which the period page doesn't render | Shown to reviewers. They're operational schedule data, not HR data |

### As built

- **Day definition:** every uncancelled shift whose `shift_date` is the date, so a shift past midnight shows in full on its start day, marked "ends next day". No business-date logic is involved. A shift ending exactly at midnight is not marked "ends next day".
- **Axis window and daylight saving:** the axis runs from the local hour at or before the earliest start to the hour at or after the latest end, never narrower than 06:00 to midnight. It's built from instants, and rounding is to local hours, so it works in zones with half-hour offsets. A spring-forward day has 23 ticks and a fall-back day 25.
- **Groupings and ordering:** By employee, with an Open shifts section, or By position, with employee rows and an Open row per position. Employees sort by name, then number, then UUID; positions by name, then code, then UUID, all by code point. Position colors follow the sorted order from an 8-color palette.
- **Visibility:** schedules at the actor's Location only.
  - *Everyone with `schedule.view`:* PUBLISHED and ARCHIVED periods. A draft-only day returns an empty timeline, not an error.
  - *Reviewers* (`schedule.edit`, `.generate` or `.publish`): also DRAFT periods, unless *Include drafts* is turned off. Staff can't turn drafts on.
  - *Always:* only `ACTIVE` assignments on uncancelled shifts.
- **Details panel fields per permission:**
  - *Everyone:* name, position, area, date, local start and end, duration, period name and status, and filled count against required.
  - *Reviewers also get:*
    - source and time assigned;
    - rationale;
    - station note and notes;
    - current hard violations;
    - open-swap flag;
    - hours for the day and the period;
    - the latest run's summary for an open slot;
    - a link to the schedule.
- **Time-off overlay:** reviewers only. Approved time off is a grey band labeled *Time off*; pending time off is a dashed band labeled *Pending time off*. Spans carry only employee, start, end and status.
- **Open slots:** required count minus active assignments, never negative. Each slot is its own bar with key `open:<shiftId>:<n>`.
- **Headcount strip and totals:** headcount counts assigned people per position for each hour they touch. Row totals and durations are integer minutes shown as `h:mm`. No money appears.

## Architectural decisions

- **Layering.**
  - *Pure rules:* `rules/timeline-layout.ts`, with no clock or database.
  - *Reads:* `repositories/timeline-repository.ts`, a new file in the same module, to keep the already long `schedule-repository.ts` from growing. That's a small deviation from the plan's suggested location.
  - *Service:* `services/timeline-service.ts` builds the response. The page and `GET /api/scheduling/timeline` both call it, and components get a plain object with no visibility logic.
- **Reuse rather than restate.**
  - *Rules:* draft and reviewer visibility come from `canReviewSchedules`.
  - *Violations:* computed by the existing `findPeriodViolations`, the same eligibility check that coverage and publishing use.
  - *Names:* come from the narrow `findSchedulingFacts`.
  - *Time off:* comes from `findOpenTimeOffSpans`, which never selects a reason.
  - *Explanation component:* the "Why this assignment" component was moved out of the period page into `components/scheduling/assignment-explanation.tsx` and is shared by both.
- **Redaction by omission.** Non-reviewers' responses don't contain the `reviewer` or `timeOff` keys at all. One field was named `openSlotSummary` rather than `unfilledReason`, so the key scan can forbid any key containing "reason" with no exceptions.
- **Query budget.** One day costs a fixed set of queries: location context, periods, shifts, assignments and names. Reviewers add swaps, period minutes, latest runs and time off, plus the violation check, which runs a fixed set per period covering the day (usually one).
- **Not real-time, not audited.** As planned. URL state drives everything, so Back, reload and shared links work.
- **API route.** It uses `requireApiActor` and the service's own permission check, like the other scheduling routes, with `Cache-Control: private, no-store`.

### Architecture deviations

| Deviation | Reason |
|---|---|
| Reads in a new `timeline-repository.ts`, not `schedule-repository.ts` | Same module and layer, and it keeps one file focused |
| Route-level 401, 403 and 400 checked in Playwright rather than in Vitest | No integration test in this repository calls route handlers with a session. The service-level 403 and the schema checks are covered in integration tests |
| `.github/copilot-instructions.md` not used | `CLAUDE.md` replaces it, per `/phase` |

## Migrations

None. `npm run db:generate` reports "No schema changes, nothing to migrate".

**EXPLAIN** on the development database, which holds the Phase 13 validation fixture:
- *Natural plans:* the planner already uses `schedule_periods_location_id_start_date_idx` and `shifts_schedule_period_id_shift_date_idx`.
- *With sequential scans disabled,* to show every predicate is indexable:
  - assignments use `shift_assignments_one_active_per_employee_unique` on `shift_id`;
  - swaps use `shift_swap_requests_one_open_per_assignment_unique`;
  - runs use `schedule_generation_runs_schedule_period_id_idx`.

No index was needed.

## Validation results

### Timeline

| Check | Result |
|---|---|
| By employee | PASS |
| By position | PASS |
| Open slots | PASS: two bars for 3 required with 1 filled; none when over-filled |
| Overnight shift | PASS: on its start date only; midnight end not marked next day |
| DST 23h / 25h day | PASS (unit) |
| Lane stacking | PASS (unit); an overlapping draft is drawn separately (integration) |
| Selection and URL restore | PASS (E2E, reload with `?selected=`) |
| Keyboard and focus return | PASS (E2E: Enter opens; Escape closes and focus returns to the bar) |
| Phone layout, no page horizontal scroll | PASS (E2E at 375 px: page doesn't scroll sideways, chart frame does, panel is a full-width bottom sheet) |
| Dark mode | N/A: light only, by owner decision |

### Security and data

| Check | Result |
|---|---|
| `schedule.view` enforced on page and API | PASS: service 403; HTTP 401 signed out, 403 without permission, page redirects to access denied |
| Drafts hidden from non-reviewers | PASS |
| Reviewer-only fields absent for non-reviewers | PASS: keys absent, notes text absent |
| No wage, HR or time-off-reason fields | PASS: key-word scan for both roles; time-off reason and swap reason text absent; the Phase 13 day's wage amounts absent |
| Read-only (no rows, no audit events) | PASS: row counts of 7 tables, including `audit_events`, unchanged |
| Location scoping | PASS |
| Terminated employee | PASS: `EMPLOYEE_NOT_SCHEDULABLE` for reviewers only |

### Performance

| Check | Result |
|---|---|
| Query count independent of staff count | PASS: the same statement count for 3 and for 30 staff, counted with a postgres.js `debug` hook on a dedicated client |
| EXPLAIN | Indexed (see Migrations) |

### Full suite

| Check | Result |
|---|---|
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 659 of 659 (baseline 634) |
| Integration tests | 1,140 of 1,141 on a clean run with nothing else running. The one failure is a 5-second timeout in `tests/integration/database/migrations.test.ts` (see below). Two earlier runs that overlapped other database work had 2 such timeouts each. Every Phase 14 test passed in every run |
| E2E tests | PASS: 120 of 120 (baseline 115) under `next dev`; after the fixes below, 120 of 120 in CI mode (`next start`) with retries off, and 119 of 120 under `next dev` (one dev-only flake, see E2E reliability fixes) |
| Production build | PASS; `/scheduling/timeline` and `/api/scheduling/timeline` listed |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 11 moderate, unchanged from Phase 13 (DEV-002) |
| Migration drift | None |
| Seed idempotency | PASS: `0 applied, 18 already applied` twice |
| `db:reset` safeguards | PASS: refused with `NODE_ENV=production` and with a non-loopback host |

**About the integration timeouts.** Every test in `migrations.test.ts` rebuilds the schema from all checked-in migrations, taking 2.2–3.8 s when run alone, against Vitest's 5-second default. In the full suite, where files run in parallel, one or two of the "upgrades a Phase N database" tests have crossed 5 s on this machine, and the file has also failed once when run alone. They're timeouts, not assertion failures. This phase changed no migration and doesn't touch that file. I didn't change the test's timeout, because that's outside this phase (Remaining issues, item 1).

The E2E run logs the known "Outbox batch failed; it will be retried" line once at dev-server start, as recorded in the Phase 11 and 13 reports.

## Tests executed

- **Unit (new, 25):** `src/modules/scheduling/rules/timeline-layout.test.ts`:
  - *Axis:* the minimum window, early and late widening, an overnight shift, and 23-hour and 25-hour days;
  - *Placement:* half-hour-offset rounding, and clipping at the window edges;
  - *Lanes:* lane assignment, including back-to-back shifts and input-order stability;
  - *Open slots;*
  - *Headcount:* half-open hour boundaries;
  - *Durations:* minutes and `h:mm` formatting;
  - *Ordering and colors.*
- **Integration (new, 20):** `tests/integration/scheduling/timeline.test.ts`:
  - *Visibility:* draft handling for staff and reviewers, archived periods, and permission;
  - *Scope:* location, cancelled shifts and removed assignments, and the new holder after a swap;
  - *Layout:* open slots, the overnight and midnight cases, headcount and minutes, and an overlapping draft;
  - *Reviewer data and redaction;*
  - *Terminated employee;*
  - *Read-only and query budget;*
  - *Query validation.*
- **Integration (added to Phase 13, 1):** `tests/integration/validation/restaurant-day.test.ts`. The canonical day's three published shifts appear, with the server's 16:00–02:00 shift marked "ends next day" (600 minutes), and no wage amount appears.
- **E2E (new, 5, in `tests/e2e/scheduling.spec.ts`):**
  - a manager's grouping, selection, reload, keyboard, open slot and time off;
  - day navigation;
  - staff seeing published shifts only with no reviewer details;
  - the phone layout;
  - API refusals, validation and cache headers.

  These are in the existing spec file rather than a new one, so its shared cleanup can't remove another file's data mid-run.
- **Updated:** `navigation.test.ts`, for the new entry.

## Files changed

**Created**
- `src/modules/scheduling/rules/timeline-layout.ts` and `.test.ts`
- `src/modules/scheduling/repositories/timeline-repository.ts`
- `src/modules/scheduling/services/timeline-service.ts`
- `src/app/api/scheduling/timeline/route.ts`
- `src/app/(app)/scheduling/timeline/page.tsx`
- `src/components/scheduling/timeline/schedule-timeline.tsx`, `timeline-details-panel.tsx`, `timeline-format.ts`
- `src/components/scheduling/assignment-explanation.tsx`
- `tests/integration/scheduling/timeline.test.ts`
- `docs/Phase-14-Schedule-Timeline.md` (the plan), this report

**Modified**
- `src/modules/scheduling/validators/scheduling-validators.ts`: `timelineQuerySchema`
- `src/app/(app)/scheduling/[periodId]/page.tsx`: the shared explanation component, and a day link on each shift date
- `src/app/(app)/my-schedule/page.tsx`: a "View day" link for shifts at the current location
- `src/components/app-shell/navigation.ts` and `.test.ts`: the Timeline entry
- `tests/e2e/scheduling.spec.ts`, `tests/helpers/e2e-scheduling.ts` (`approvedTimeOff`), `tests/integration/validation/restaurant-day.test.ts`
- `tests/helpers/e2e-day.ts`: the restaurant-day retry fix
- `tests/e2e/inventory.spec.ts`: the count test's variance flow limited to its own item
- `playwright.config.ts`: `next start` in CI
- `.github/workflows/ci.yml`: upload Playwright failure files
- `src/components/scheduling/timeline/schedule-timeline.tsx`: `data-ready` hydration marker
- `README.md`: §11 pointer; §33 "Phase 14 Schedule Timeline"; §36 Phase 14 entry with AWS renumbered to 15 and 16
- `CLAUDE.md`: phase list
- `docs/accepted-risks.md` and `docs/Phase-13-Validation-Seed-Data.md`: "Phase 14 AWS" now "Phase 15"
- `docs/User-Guide.md`: "Viewing the day's schedule"

## E2E reliability fixes

The owner's CI runs after Phase 13 and Phase 14 reported failing and flaky E2E tests. The Phase 14 run took 14.7 minutes, with 1 failed and 11 flaky across unrelated specs. These were investigated, and fixed where the cause was confirmed.

**1. The restaurant-day spec couldn't survive a retry.**
- *Cause:* the spec always schedules the same fixed week (`DAY_WEEK`) and leaves it published. When the first CI attempt failed for any reason, each retry drafted the same week, and Publish was refused because two published periods can't share a date. That gave the "Draft" where "Published" was expected in the Phase 13 run, and it hid the first attempt's real error.
- *Reproduced:* `--repeat-each=2` gave a pass, then the CI error.
- *Fix:* `createDraftSchedule` in `tests/helpers/e2e-day.ts` archives any period an earlier attempt published for that week, through `archivePeriod`, so nothing is deleted.
- *Verified:* both repeats pass. In the Phase 14 CI run this spec was flaky, not failed, meaning a retry recovered.

**2. CI ran E2E against `next dev`.**
- *Cause:* every first request compiles a route on demand, and on a busy runner the 5-second assertion after a save and refresh timed out. The failed combine-table test and the swap test both stopped at that kind of assertion, and the run took twice as long as the one before.
- *Fix:* by owner decision, in CI only, `playwright.config.ts` starts `next start` on the build CI already makes. Local runs keep `next dev`; `npm run build` then `CI=1 npm run test:e2e` reproduces CI mode.
- *Verified:* the full suite in CI mode, with retries off, ran 120 of 120 in 3.0 minutes, against 7.7–8.0 under `next dev`.

**3. A Phase 14 test acted before hydration.**
- *Cause:* the server-rendered timeline shows before React hydrates. Under the faster production server, one test pressed Escape before the panel's key listener existed.
- *Fix:* the timeline sets `data-ready="true"` once hydrated, using `useSyncExternalStore`. Its tests wait for that before clicking or pressing keys, and check that the panel focuses its Close button.
- *Verified:* 25 of 25 runs in production mode, with no retries.

**4. The inventory count test depended on other specs.**
- *Cause:* the test approved a full count, which holds every item stocked at MAIN. Other specs running at the same time send orders that move those items' stock, and by the Phase 8 policy, approval then needs an explicit acknowledgement, so the count stayed "Submitted".
- *Reproduced:* running it with the orders, kitchen and settlements specs on 2 workers failed 1 time in 2.
- *Fix:* the test still starts a full count from the screen and checks it opens. The variance, submit and approve steps now use a count started through the API and limited to the test's own item.
- *Verified:* 3 of 3 passes in that combination.

**5. CI now keeps Playwright failure files.** By owner decision, `.github/workflows/ci.yml` uploads `test-results/` when the E2E step fails, kept for 7 days.

**Not fixed: dev-mode-only flakes.** In a local `next dev` full run, `reservations.spec.ts:261` failed once at the first assertion after a save. It passes 3 of 3 alone and in CI mode, and CI no longer uses `next dev`. The other Phase 14 CI flakes weren't individually investigated. None failed in either of the two CI-mode full runs.

## Risks

- **The violation check reads whole periods.** For reviewers, current violations reuse `findPeriodViolations`, which evaluates every assignment in each period covering the day. That's correct and shared with coverage, but more work than one day needs. It's fine for a location's week; measure before very long periods.
- **Wide days scroll on desktop.** A day running to 02:00 is 20 hours (about 1,290 px with names), wider than the 1,152 px content column. The chart scrolls inside its frame and names stay visible.
- **The panel isn't modal.** It's a non-modal dialog, so focus isn't trapped; Escape and Close work, and focus returns to the bar. That's deliberate, so the chart stays usable beside it on desktop.
- **A dev-overlay "1 Issue" badge** appeared once in a scripted screenshot run. Two follow-up runs with the same data, capturing every console error and page error, showed none. It's recorded here but not reproduced.

## Remaining issues

1. **Your decision: the migration-upgrade test timeouts.** These tests replay the full chain and sit close to Vitest's 5-second default. Giving that `describe` an explicit timeout (for example 30 s, as other long tests do) would remove the intermittent failure. I haven't changed it, because the file is outside this phase. Say if you want it.
2. **Carried over:** the outbox log line at E2E start, and the optional E2E cleanups noted in Phase 13.
3. **Confirm in CI.** CI's switch to `next start` and the artifact upload have run only locally in CI mode. The next GitHub Actions run is their first real test.

## Next-phase readiness

**Phase 15 (AWS POC Deployment) readiness: READY,** subject to review of this report, a decision on Remaining issues item 1, and a green CI run after push. Phase 16's acceptance test should include the timeline on desktop, tablet and phone.
