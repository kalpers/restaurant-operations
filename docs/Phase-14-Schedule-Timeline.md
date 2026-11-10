# Phase 14: Schedule Timeline (Gantt) Design and Implementation Plan

## Purpose

Phase 14 adds a day-by-day Gantt view of the schedule. For one day at the current Location, each scheduled shift appears as a bar on a time axis, grouped by Employee or by Position. Selecting a bar opens a details panel for that shift and assignment.

The timeline is a read-only view over the Phase 4 Scheduling data. It adds no table, no column, no permission and no write path. Managers still build and change schedules on the existing period page, and published changes still go through the shift-swap workflow.

Phase 14 was inserted by owner decision on 2026-11-10. AWS deployment moves to Phase 15 and AWS acceptance to Phase 16, so the AWS acceptance test also covers the timeline on desktop, tablet and phone. Earlier completion reports that mention "Phase 14" for AWS work (for example `btree_gist` on RDS, session extension, login rate limiting) now refer to Phase 15.

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially section 11 (Domain 04: Scheduling), section 30 (Responsive UI) and the Phase 4 Scheduling notes in section 33.
2. Read `docs/Phase-4-Scheduling.md` and `docs/Phase-4-Completion-Report.md`.
3. Read `docs/accepted-risks.md`.
4. Read `docs/Audit-Domain-Completion-Report.md` (the rules for which reads are audited).
5. Inspect `src/modules/scheduling/`, `src/app/(app)/scheduling/`, `src/app/api/scheduling/`, `src/components/scheduling/`, the scheduling schema and its tests.

## Approved Phase 14 Policies

1. **Read-only.** The timeline never writes. There's no drag, resize, assign or remove on the chart. A reviewer's details panel links to the shift on the existing period page, where every edit keeps its current validation, versioning and audit. No migration, table, column or permission is added. If a missing index turns up (policy 14), it gets a generated, reviewed migration and is reported.
2. **The day is `shift_date`.** A day shows every uncancelled shift whose `shift_date` is that date. That's the location-local date of the shift's start, the same "worked day" that Phase 4 rules and scoring use. A shift that runs past midnight shows in full on the day it starts. The timeline doesn't compute business dates and doesn't call `BusinessDateService`, because scheduling's day is already defined. A shift that started the previous evening isn't repeated on the next day.
3. **Time axis in the location timezone.** The axis runs from the hour at or before the earliest start to the hour at or after the latest end, and is never narrower than 06:00 to 24:00 local. It's built from real instants, so a 23-hour or 25-hour daylight-saving day draws the correct number of hours and the labels repeat or skip as the clock does. The server sends ISO instants and the location timezone; positions are computed from instants, never from wall-clock strings.
4. **Two groupings, chosen in the URL.**
   - *By employee* (default): one row per Employee with at least one assignment that day. Each bar shows the Position and the start and end times.
   - *By position*: one group per Position. Inside it, one row per assigned Employee, then one **Open** row with a hatched bar for each unfilled slot (`required_employee_count` minus active assignments).
   - Rows are sorted deterministically. Employees sort by display name, then employee number, then UUID. Positions sort by name, then code, then UUID.
5. **What appears.** Only `ACTIVE` assignments on uncancelled shifts at the actor's Location. `REMOVED` and `SWAPPED` assignments don't appear, so after a completed swap the bar shows the new holder. Open slots appear in both groupings: in *By employee* as an **Open shifts** section at the bottom. The period page already shows open counts to every `schedule.view` holder, so this exposes nothing new.
6. **Visibility matches the period page.** `schedule.view` is required for the page and the API. Holders of `schedule.edit`, `schedule.generate` or `schedule.publish` (the existing `canReviewSchedules`) also see DRAFT periods. Draft bars are drawn outlined and labeled *Draft*. An *Include drafts* toggle (default on) can hide them. Everyone else sees PUBLISHED and ARCHIVED periods only, and a draft-only day looks like an empty day, never like a forbidden one. Published periods can't overlap, but a draft can overlap a published period. If the same Employee then has two overlapping bars, they stack in separate lanes of that row instead of covering each other.
7. **Selecting a bar.** A click, tap, or Enter or Space on a focused bar opens the details panel: a side panel on desktop, a bottom sheet at phone width. Escape or the close button closes it and returns focus to the bar. The selected assignment is kept in the URL (`?selected=<assignmentId>` or `?selected=open:<shiftId>:<n>`), so a link or a page reload reopens it.
8. **What the panel shows.** It never shows a field the period page hides from that actor.
   - *Everyone with `schedule.view`:* Employee display name, Position, restaurant area, shift date, local start and end, duration, period name and status, and filled count against required count. Overnight shifts are labeled "ends next day".
   - *Reviewers also see:* assignment source (`MANUAL`, `GENERATED`, `SHIFT_SWAP`), who assigned it and when, the "Why this assignment" generation rationale (checks and score reasons, the same component the period page uses), the station note and shift notes, any current hard violation for the assignment (for example `EMPLOYEE_NOT_SCHEDULABLE`), whether an open swap request exists on it, and the Employee's scheduled hours for the day and for the period. Each reviewer panel links to the shift on the period page.
   - *An Open slot panel shows:* the shift fields, plus, for reviewers, the unfilled reason from the latest generation run when one exists.
   - *Never shown:* wage, compensation, labor cost, employment status beyond the single `EMPLOYEE_NOT_SCHEDULABLE` code, contact details, HR records, time-off reasons or types, or availability details.
9. **Time-off overlay (reviewers only).** Approved time off that overlaps the axis shows as a grey band on the Employee's row, labeled *Time off*, with no type or reason. Pending time off shows as a dashed band labeled *Pending time off*. The overlay rows are limited to Employees already on the day's timeline. Non-reviewers see no time-off overlay.
10. **Day summary.**
    - *Headcount strip:* a strip above the chart shows scheduled headcount for each hour of the axis, per Position, computed on the server from the same rows.
    - *Row totals:* each Employee row ends with that Employee's scheduled time for the day.
    - Durations are integer minutes, shown as `h:mm`. No money appears anywhere on the timeline.
11. **Day navigation.** Previous day, Next day, Today (in the location timezone) and a date input. Date, grouping, draft toggle and selection all live in query parameters, so the browser Back button and shared links work. When the date is today, a "now" line marks the current local time.
12. **Not real-time, not audited.** The timeline loads when the page loads or the date changes. It doesn't subscribe to SSE. Ordinary reads aren't audited (Audit Domain policy), so viewing the timeline writes no `audit_events` row.
13. **No new dependency.** Bars are positioned elements in React with Tailwind, inside the same app shell. No chart or Gantt library is added, so `npm audit --omit=dev` doesn't change.
    - *Position colors:* each Position gets a color from a fixed palette, assigned by the sorted position order of that day.
    - *Not color alone:* every bar also carries the Position name as text, and drafts and open slots are told apart by outline and hatching as well as color.
    - *Themes:* the colors meet contrast requirements in light and dark mode.
14. **Layering and query budget.**
    - *Layering:* a timeline query service in `src/modules/scheduling/` (for example `services/timeline-service.ts`, with repository reads in `repositories/` or `queries/`) returns a plain DTO. A thin route handler and the page both call it. React components never touch Drizzle and hold no visibility logic.
    - *Query budget:* one day loads in a fixed number of queries, whatever the staff count: periods covering the date, shifts with assignments, scheduling facts for names, and, for reviewers, time off, open swaps and the latest run's unfilled details. There are no per-shift or per-employee queries.
    - *Indexes:* the existing indexes on `schedule_periods (location_id, start_date)`, `shifts (schedule_period_id, shift_date)` and `shift_assignments (shift_id, status)` are expected to be enough. Confirm with `EXPLAIN` against the Phase 13 validation fixture.
15. **Scheduling only.** The timeline reads Scheduling tables and the scheduling-facts query that Employees already exposes. It doesn't read compensation, restricted HR tables, orders, or seating.

### Amendments decided at planning (2026-11-10)

These replace the conflicting text in policies 8 and 13 above:

- **Light theme only.** The app has no dark mode, so the timeline matches the rest of the app. Colors meet contrast in the light theme, and the dark-mode checks are removed from this plan and the report.
- **No "who assigned it".** Users have only an email, which is a contact detail. The reviewer panel shows the assignment source and the time it was assigned, not who made it.
- **Shift notes and station note are shown to reviewers.** In policy 8, "hides" means withheld by permission. The period page doesn't render notes for anyone, but they're operational schedule data written by schedulers, not HR data.

## 1. Objectives

Deliver:

- A day timeline query service in the Scheduling module, with unit-tested layout and summary rules
- `GET /api/scheduling/timeline`
- The `/scheduling/timeline` page with both groupings, the details panel, day navigation, the headcount strip, the reviewer time-off overlay and the open-slot rows
- Links: a *Timeline* navigation entry (`schedule.view`), a "View day" link per date on the period page, and a "View day" link on My Schedule
- Unit, integration and Playwright tests
- README and CLAUDE.md updates and `docs/Phase-14-Completion-Report.md`

## 2. Scope Boundary

In scope: one day, one Location, read-only, Employee and Position groupings, selection with details.

Out of scope (don't build):

- Editing from the chart (drag, resize, assign, remove, swap)
- A week or multi-day Gantt, or a cross-location view
- Actual worked time or a time clock (none exists)
- Labor cost, wage or overtime-cost overlays
- Availability overlays
- Real-time updates
- CSV, PDF or print export of the timeline
- Any change to scheduling rules, eligibility, scoring or the publish and swap workflows

## 3. Review Existing Foundation Before Changes

Confirm, from code rather than memory:

- How `getPeriodDetail`, `requireVisiblePeriod` and `canReviewSchedules` decide draft visibility and rationale visibility. The timeline must reuse these rules, not restate them.
- `findPeriodShifts`, `findActiveAssignmentsForPeriod` and `findSchedulingFacts`, and whether one query can cover every period overlapping a date.
- `shiftTimes` in `src/components/scheduling/format.ts`, and how the period page formats overnight shifts.
- The coverage analyzer's per-assignment hard-violation codes, and how they can be computed for one day without running the whole period.
- How time-off visibility is enforced (reasons only for the requester and approvers) and how swap requests are queried.
- `apiRoute`, the error envelope, and how other scheduling routes validate query strings with Zod.
- Existing dark-mode and responsive conventions in `src/components/`.

If any of these conflicts with the policies above, stop and explain before changing it.

## 4. Timeline Query Contract

`GET /api/scheduling/timeline?date=YYYY-MM-DD&includeDrafts=true|false`

- `date` is required and must be a valid calendar date (Zod). `includeDrafts` defaults to `true` and is ignored for non-reviewers. Grouping is a client concern; the response carries what both groupings need.
- `401` without a session, `403` without `schedule.view`, `400` for a bad date, using the standard error shape.
- Always scoped to `actor.locationId`. There's no location parameter.

The response, as a sketch (finalize field names to match existing DTOs):

```ts
{
  date: "2026-11-14",
  timeZone: "America/Chicago",
  window: { startAt: string; endAt: string },          // ISO instants, policy 3
  isReviewer: boolean,
  positions: { id; name; code; colorIndex }[],
  employees: { id; displayName; employeeNumber; scheduledMinutes }[],
  bars: {
    kind: "ASSIGNMENT" | "OPEN";
    key: string;                                         // assignment id, or open:<shiftId>:<n>
    shiftId; positionId; employeeId: string | null;
    restaurantAreaName: string | null;
    startAt; endAt; endsNextDay: boolean;
    periodId; periodName; periodStatus;
    requiredCount; filledCount;
    lane: number;                                        // policy 6
    reviewer?: {                                         // present only for reviewers
      assignmentSource; assignedByName; assignedAt;
      rationale; stationNote; notes;
      violations: string[]; openSwap: boolean;
      employeePeriodMinutes; openSlotSummary;
    };
  }[],
  headcount: { hourStartAt; byPosition: Record<positionId, number> }[],
  timeOff?: { employeeId; startAt; endAt; status: "APPROVED" | "PENDING" }[],  // reviewers only
}
```

The `reviewer` and `timeOff` keys are left out entirely for non-reviewers. They aren't sent as `null`.

## 5. Unit Tests (deterministic rules)

Put the layout and summary logic in pure functions, for example `rules/timeline-layout.ts`, and test:

- **Axis window:**
  - the 06:00–24:00 minimum;
  - widening for an early open or a late close;
  - an overnight shift ending 02:00 the next day;
  - a 23-hour and a 25-hour daylight-saving day, checked by hour count and labels.
- **Bar placement:** instant to offset and width, at the window edges.
- **Lanes:**
  - no overlap gives one lane;
  - a draft overlapping a published bar for the same Employee gives two lanes;
  - back-to-back shifts (half-open intervals) share a lane.
- **Open slots:** `required − filled`, never negative. Over-filled shifts produce no open bar.
- **Headcount:**
  - a shift covering part of an hour counts in that hour;
  - half-open boundaries are respected;
  - counts are per Position.
- **Minutes totals:**
  - a day total across several shifts;
  - an overnight shift counted once, on its start day.
- **Ordering:** Employees by display name, then employee number, then UUID. Positions by name, then code, then UUID. Ties break the same way every run.
- **Colors:** position colors are stable for the same position order.

## 6. Integration Tests (PostgreSQL)

- **Visibility:**
  - a non-reviewer doesn't see draft bars, and a draft-only day returns an empty timeline, not `403` or `404`;
  - a reviewer sees drafts by default, and `includeDrafts=false` hides them;
  - ARCHIVED periods are visible.
- **Scope:**
  - another Location's shifts never appear;
  - cancelled shifts never appear;
  - `REMOVED` and `SWAPPED` assignments never appear;
  - after a completed swap, the new holder appears with source `SHIFT_SWAP`.
- **Day boundary:** an overnight shift appears on its start date only. A shift with `shift_date` of the previous day is absent.
- **Redaction:**
  - a non-reviewer response has no `reviewer` or `timeOff` keys;
  - no response, for any actor, has a key matching wage, rate, salary, compensation, cost, status (employment), phone, email, address or reason;
  - time-off rows carry no type or reason.
- **Violations:** a scheduled Employee who's since been terminated shows `EMPLOYEE_NOT_SCHEDULABLE` to a reviewer, and nothing to a non-reviewer.
- **Authorization:** `401` with no session, `403` without `schedule.view` (permission checked, not role name), `400` for an invalid date.
- **Read-only:** row counts of every scheduling table and `audit_events` are unchanged after the call.
- **Query budget:** the number of queries for a day with 3 staff equals the number for a day with 30 staff.
- **Canonical scenario:** on the Phase 13 restaurant day, the timeline shows the published shifts that the simulated day staffs.

## 7. E2E Tests (Playwright)

- **Manager:**
  - opens Timeline from navigation and moves to the day with shifts;
  - switches between *By employee* and *By position*;
  - selects an assigned bar and sees Position, times, source and the rationale;
  - selects an Open bar and sees filled against required;
  - closes the panel with Escape, and focus returns to the bar;
  - reloads with `?selected=` and the panel reopens.
- **Staff role (for example Server):**
  - sees published bars only;
  - the panel has no source, rationale, notes or time-off band.
- **Keyboard:** Tab reaches the bars, and Enter opens the panel.
- **Phone viewport:**
  - no horizontal page scroll; the chart scrolls inside its frame with sticky names;
  - the panel opens as a bottom sheet.
- **Day navigation:** Previous, Next and Today change the URL and the content.

## 8. Documentation

Already done when this plan was written: README section 36 lists Phase 14 and renumbers AWS to Phases 15 and 16; the `CLAUDE.md` phase list matches; the review triggers in `docs/accepted-risks.md` and the Phase 13 seed doc say Phase 15.

At completion:

- **README:**
  - section 33: add a "Phase 14 Schedule Timeline" note with the policies as built;
  - section 11: one line pointing to it.
- **`docs/User-Guide.md`:** add a short "Viewing the day's schedule" section.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` (stop `npm run dev` first)
- [ ] `npm run build`
- [ ] `npm audit --omit=dev` clean, and no new dependency
- [ ] No migration generated, or, if an index was needed, migration reviewed and an empty DB rebuilt from checked-in migrations
- [ ] `npm run db:seed` twice creates no duplicates (unchanged by this phase)
- [ ] `EXPLAIN` of the timeline queries on the validation fixture uses indexes
- [ ] Manual check in the browser at desktop, tablet and phone widths, in light and dark mode

## 10. Required Phase 14 Completion Report

Write `docs/Phase-14-Completion-Report.md`:

```text
PHASE 14 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL / Drizzle ORM / Drizzle Kit

Policies (as built)
- Day definition (shift_date):
- Axis window and DST handling:
- Groupings and ordering:
- Visibility (drafts, reviewers, location):
- Details panel fields per permission:
- Time-off overlay:
- Open slots:
- Headcount strip and totals:

Timeline
- By employee: PASS / FAIL
- By position: PASS / FAIL
- Open slots: PASS / FAIL
- Overnight shift: PASS / FAIL
- DST 23h / 25h day: PASS / FAIL
- Lane stacking: PASS / FAIL
- Selection + URL restore: PASS / FAIL
- Keyboard + focus return: PASS / FAIL
- Phone layout, no page horizontal scroll: PASS / FAIL
- Dark mode: PASS / FAIL

Security and data
- schedule.view enforced on page and API: PASS / FAIL
- Drafts hidden from non-reviewers: PASS / FAIL
- Reviewer-only fields absent for non-reviewers: PASS / FAIL
- No wage/HR/time-off-reason fields: PASS / FAIL
- Read-only (no rows, no audit events): PASS / FAIL
- Location scoping: PASS / FAIL

Performance
- Query count independent of staff count: PASS / FAIL
- EXPLAIN results:

Architectural decisions
Migrations (expected: none)
Validation results (lint, typecheck, unit, integration, e2e, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness (Phase 15 AWS POC Deployment)
```
