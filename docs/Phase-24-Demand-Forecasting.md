# Phase 24: Demand Forecasting for Scheduling Design and Implementation Plan

## Purpose

Phase 24 builds the fourth README section 39 group the owner named: **demand forecasting based on historical sales and reservations**, used to size the shifts the schedule generator fills. Phase 4 said not to build this yet, and it is the last future capability the owner listed.

- **Forecast.** For each date of a draft schedule period, the expected demand per local hour (dining covers, bar checks, takeout checks), worked out from the same weekday in recent weeks of closed checks, raised to at least the covers already booked by reservations.
- **Staffing ratios.** Per location and position, how much demand one employee handles in an hour, with a minimum and maximum headcount.
- **Forecast-sized shifts.** Applying a staffing template can size each new shift from the forecast instead of the template's fixed count, with an explanation per shift. The manager can see and use the forecast's suggestion on existing draft shifts. The generator itself is unchanged: it still fills the shifts it is given, and never publishes.
- **Forecast vs actual.** Once the dates have passed, a report compares the forecast that was used with what happened.
- **Phase 23 leftovers.** The dev-server E2E timing, realtime events for staff reservation changes, and the three missing E2E tests.

Left out on purpose:

- machine learning, external data (weather, events, holidays calendars), or any new dependency
- forecasting sales money, items, prep lists or purchasing quantities (Phase 19 suggestions stay par-based)
- creating shifts that no template asks for, or changing shift times from the forecast
- forecasting across locations (each location forecasts from its own history)
- automatic re-forecasting of a published schedule
- delivery, loyalty, accounting, payroll, cloud deployment (on hold)

What exists today (checked against the code on 2026-11-12):

- **Demand side of scheduling.** `staffing_templates` and `staffing_template_requirements` (day of week, position, optional area, start and end time, `required_employee_count`, priority). `applyTemplate` (`config-service.ts`) creates each requirement's shift for each matching date of a DRAFT period at most once (`shifts_period_requirement_date_unique`), copying the fixed count. Existing shifts are never touched. There is no other source of demand.
- **Generator.** `runGeneration` fills shifts that exist (`GENERATE_DRAFT`, `FILL_OPEN_SHIFTS`), records `schedule_generation_runs` with a rules snapshot, warnings and unfilled details. It never creates shifts. Coverage analysis (`coverage-analyzer.ts`) reports required, filled and open by date, position and area.
- **History.** CLOSED orders have `order_type` (`DINE_IN`, `BAR`, `TAKEOUT`), `business_date`, `opened_at`; dine-in covers come from `table_sessions.party_size`, counted once per session (the sales report and the Phase 19 sales-by-hour rule). Sales by hour uses the **local hour the order was opened**, laid out from the business-day cutoff (`hour-buckets.ts`).
- **Booked demand.** `reservations` (`reservation_at`, status `PENDING`/`CONFIRMED`/…, `source` including `ONLINE`), party size on the linked `guest_parties` row.
- **Module dependencies.** Reporting imports Scheduling (labor reports), so Scheduling can't import Reporting. Scheduling already reads other domains through their own query files (for example `settlements/queries/tip-facts.ts`).
- **Permissions.** 149. Scheduling has `schedule.view`, `.edit`, `.generate`, `.publish`, `.templates.manage`, `.rules.manage` and others.
- **Leftovers.** Dev-server E2E failed 5, 1 and 6 tests on three runs (different sets each time, all 5-second waits, all passing in CI mode) after the Phase 23 route warm-up. Staff reservation changes emit no realtime events, so the reservations board picks them up only on its 30-second fallback. No E2E covers the `LOT_EXPIRING` bell, "Add an existing person" or the board refreshing on an online booking.

It changes these written contract points, which the owner approves with this plan:

- **README section 11:** generator inputs gain "demand forecast (optional, per template application)"; new tables `staffing_ratios`, `demand_forecasts`, `demand_forecast_hours`; a "Demand forecast (Phase 24)" subsection.
- **README section 21:** the Labor area gains "Forecast vs actual".
- **README section 39:** "Demand forecasting based on historical sales/reservations" is built (for staffing).
- **Phase 4 plan:** an amendment noting forecasting was added in Phase 24.
- **CLAUDE.md:** the Phase 24 line and a short forecasting policy under "Scheduling".

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially sections 11, 13, 14, 15, 21 and the Phase 4, 12 and 19 notes in section 33.
2. Read the Phase 4, 12, 14, 19 and 23 plans and completion reports. Phase 4 is the model for templates and the generator; Phase 19 for hour buckets.
3. Read `docs/accepted-risks.md`. No new dependency is planned.

## Decisions for the owner

Approved by the owner on 2026-11-12 as recommended. The policies below follow them.

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | What is forecast? | **Four demand measures per business date and local hour:** `DINING_COVERS` (party size of dine-in table sessions, once per session), `BAR_CHECKS`, `TAKEOUT_CHECKS` and `ALL_CHECKS`. Counts only: **no money**. Hours are the local hour a check was opened, laid out from the cutoff, exactly as the sales-by-hour report. | These are what drive server, bartender, host and cook headcount. Using the existing sales-by-hour rule means a past date's history equals that report, which is easy to check. Leaving out money keeps sales figures inside `reports.sales`. |
| D2 | How is it worked out? | **A weighted average of the same weekday over the last 6 weeks**, most recent weighted highest (weights 6, 5, 4, 3, 2, 1), per hour and measure. A past date is skipped if the location had **no closed checks** that business date (closed) or it is on the location's **excluded dates** list (D7); skipped dates go back further, up to 12 weeks, to find 6. Fewer than **3** usable dates for a weekday means **not enough history**: that date gets no forecast and its shifts keep the template count, with a warning. Results are decimals (two places), never rounded until headcount (D4). The look-back weeks (default 6) and minimum (default 3) are location settings in `scheduling_rules`. | Deterministic, explainable in a sentence and testable by hand. Same-weekday averaging is the standard simple method for restaurants. A new location (Phase 23) gets template counts until it has three weeks. |
| D3 | How do reservations count? | **For `DINING_COVERS`, each hour's forecast is raised to at least the covers already booked for it** (reservations `PENDING` or `CONFIRMED` whose `reservation_at` falls in that local hour, party size from the guest party). `ALL_CHECKS` is not raised (a reservation is not a check). The booked figure is shown beside the history figure, so the manager sees which one set the number. | Bookings are known demand; history already includes typical walk-ins. "At least the booked covers" is safe and doesn't double count. A walk-in multiplier would be guesswork. |
| D4 | How does demand become headcount? | **Staffing ratios** per location and position (`staffing_ratios`): the measure that drives it, how much one employee handles per hour (for example servers: 1 per 16 dining covers), minimum and maximum headcount, active flag. A shift's **suggested count** = the shift window's **busiest hour** of that measure ÷ ratio, rounded **up**, then held between minimum and maximum. A position with no active ratio is never sized: it keeps the template count. Ratios are edited under `schedule.rules.manage` on the Staffing page. | The busiest hour is what a shift must cover; average demand would understaff the rush. Per-position ratios match how managers already think ("one server per four tables"). |
| D5 | Where does the forecast change the schedule? | **Only when the manager asks, on a DRAFT period.** (a) **"Apply template"** gains **"Size shifts from the forecast"**: new shifts get the suggested count where there is one and the template count otherwise. (b) The period page gains a **Forecast** panel: per date, the hourly demand chart and, per shift from a template, template count, current count and suggested count with the reason; **"Use suggestion"** on one shift or **"Use all suggestions"** is an ordinary versioned shift edit. Shifts with more assignments than the suggestion are never lowered below their assigned count. The generator is unchanged; generation runs record which forecast the shifts came from in their warnings. Nothing changes a PUBLISHED period. | Keeps "the generator creates a draft starting point" and "only drafts are editable" true, and leaves every number in the manager's hands. |
| D6 | Is the forecast stored? | **Yes, as an append-only snapshot when it is used.** Previewing computes on read and stores nothing. Applying a template with the forecast, or using a suggestion, first saves a `demand_forecasts` row (location, period, user, time, method settings, ratios used, the history dates used per weekday) and its `demand_forecast_hours` rows (date, hour, measure, history value, booked value, forecast value, sample count). Shifts sized from it record `demand_forecast_id`, `forecast_suggested_count` and `template_employee_count`. Later forecasts are new rows; nothing is overwritten. | Rule 4: the reason a shift has four servers must still be readable after more history arrives or ratios change. It also gives D8 the forecast that was actually used. |
| D7 | Can odd days be kept out? | **Yes: an excluded-dates list per location** (`demand_excluded_dates`: date, reason, user), under `schedule.rules.manage`. Excluded dates are skipped as history (D2) and shown in the explanation. Removing one deactivates it; past forecasts keep the dates they used. | A snowstorm, a private buy-out or a holiday would skew six weeks of averages. Holidays as a calendar would be guesswork; a manager's list is honest. |
| D8 | Forecast vs actual? | **A "Forecast vs actual" section in the Labor report area** (`reports.labor`): for each past business date in the range that has a stored forecast (the latest one used for that date), forecast and actual per measure, as daily totals and the busiest hour, with the difference and percentage. CSV export. "All my locations" shows the daily totals per location as in Phase 23. | Managers need to know whether to trust it. It reads the snapshot and closed checks only, never recomputes. |
| D9 | Which module owns what? | **The forecast lives in Scheduling**: pure rules in `src/modules/scheduling/rules/demand-forecast.ts` (averaging, booked floor, headcount), service `forecast-service.ts`, tables in the scheduling schema. History comes from **read-only query functions in the owning modules**: `orders/queries/demand-history.ts` (closed checks and covers by business date and local hour) and `reservations/queries/booked-demand.ts`. The report query lives in Reporting. | Scheduling can't import Reporting (Reporting already imports Scheduling). Owning modules exposing read queries is the existing pattern (`tip-facts.ts`). |
| D10 | Permissions? | **No new permission; the count stays 149.** Preview and use the forecast: `schedule.edit`. Ratios, excluded dates and the look-back settings: `schedule.rules.manage`. Forecast vs actual: `reports.labor`. The forecast shows counts of guests and checks, never money, wages or employee data. | The people who build schedules already see how busy the restaurant is. No money keeps the sales permission meaningful. |
| D11 | History for demo and tests? | **Tests:** a fixture creates closed checks through the real order and settlement services, then moves their business date and timestamps back with test-only SQL. **Demo seed (`db:seed:demo`):** adds 6 weeks of history at `MAIN` the same way (local dev DB only, idempotent, clearly fake: demo customer names), plus ratios for Server, Bartender, Line Cook and Host. **The validation seed and base seed get no history.** | Without history the feature shows only "not enough history". Moving fake rows' dates is acceptable only in seeds and tests on the local dev database; no application code ever does it. |
| D12 | Phase 23 leftovers? | **First build step.** (a) **Dev-only E2E wait:** `playwright.config.ts` `expect.timeout` = 5 s in CI mode, 15 s against `next dev`; then the full suite twice against the dev server with no re-run. (b) **Staff reservation realtime:** create, edit, cancel, check-in, no-show and seat emit outbox events (`reservation.created`, `.updated`, `.cancelled`, `.checked-in`, `.no-show`, `.seated`, IDs only) and the board listens. (c) **E2E:** the `LOT_EXPIRING` bell, "Add an existing person", and the board refreshing on an online booking. The real SMTP and Twilio send stays the owner's manual check. | (a) was offered after Phase 23 and is the owner's call; the slow waits are dev compile time, not app behaviour. (b) and (c) close the gaps the Phase 23 report listed. |

## Approved Phase 24 Policies

Binding since the owner approved D1–D12 on 2026-11-12. Numbers are for reference in the build and the report.

### A. History and forecast

1. **History query (D1, D9).** `getDemandHistory(executor, { locationId, fromDate, toDate })` in `orders/queries/demand-history.ts` returns, per business date and local hour (the location's current time zone), `diningCovers`, `barChecks`, `takeoutChecks`, `allChecks` from CLOSED orders, with covers counted once per table session on its first closed order, plus the set of business dates that had at least one closed check. Its numbers for a date equal the sales-by-hour report for that date (tested).
2. **Booked query (D3).** `getBookedCovers(executor, { locationId, fromDate, toDate })` in `reservations/queries/booked-demand.ts`: covers per business date and local hour from reservations `PENDING` or `CONFIRMED`, by `reservation_at`, business date from `BusinessDateService`.
3. **Forecast rule (D2).** Pure function: for a target date, the usable history dates are earlier dates with the same weekday, newest first, within 12 weeks, not excluded and having a closed check, taking the first `forecast_lookback_weeks` (default 6). Weights run from that number down to 1. Each hour's value is the weighted mean, as a decimal string to two places (no JS `number` arithmetic on results; integer counts in, decimal out). Fewer than `forecast_minimum_samples` (default 3) usable dates: `NOT_ENOUGH_HISTORY`, no values. The target date must be on or after today's business date.
4. **Booked floor (D3).** `DINING_COVERS` forecast per hour = max(history value, booked covers). Other measures are unchanged. With not enough history and some bookings, the forecast is the booked covers only, flagged `BOOKINGS_ONLY`.
5. **Settings.** `scheduling_rules` gains `forecast_lookback_weeks` (1–12, default 6) and `forecast_minimum_samples` (1–12, not above look-back, default 3), edited with the other rules.
6. **Excluded dates (D7).** `demand_excluded_dates` (location, date, reason required, created by user, active). Unique active date per location. Deactivated, never deleted. Audited.

### B. Ratios and headcount

7. **Ratios (D4).** `staffing_ratios` (location, position, measure, `units_per_employee_hour` NUMERIC(8,2) > 0, `minimum_employees` ≥ 0, `maximum_employees` ≥ minimum and ≥ 1, active, version). One active ratio per location and position. Under `schedule.rules.manage`; optimistic concurrency; audited with before and after.
8. **Suggested count.** For a shift window (start and end instants, cross-midnight allowed), the busiest forecast hour of the ratio's measure among the hours the window touches; suggestion = clamp(ceil(peak ÷ units), minimum, maximum), and at least 1 (shifts require ≥ 1). No ratio, no forecast for that date, or a measure with all zeros below the minimum: explained (`NO_RATIO`, `NOT_ENOUGH_HISTORY`, `MINIMUM_APPLIED`, `MAXIMUM_APPLIED`).
9. **Explanation.** Each suggestion carries: measure, busiest hour, its history and booked values, sample dates, ratio and the rounding or clamp applied, in plain words ("Busiest hour 19:00–19:59: 48 covers (history 41, booked 48) ÷ 16 per server = 3").

### C. Using the forecast

10. **Preview.** `GET /api/scheduling/periods/{id}/forecast` (`schedule.edit`): per date the hourly values per measure, booked covers, sample dates, status; per template-sourced shift the template, current and suggested count with explanation. Stores nothing.
11. **Snapshot (D6).** `demand_forecasts` (location, period, created by user, created at, method JSONB: look-back, minimum, ratios used with their versions, history dates used per date, excluded dates applied) and `demand_forecast_hours` (forecast, date, hour, measure, history value, booked value, forecast value, sample count). Append-only, enforced by a trigger. Written in the same transaction as the shifts it sizes. Audit `schedule.forecast-applied` (counts only).
12. **Apply template (D5).** `applyTemplate` takes `useForecast` (default false, so existing callers are unchanged). With it, in one transaction: lock the DRAFT period, compute and store the forecast, create missing shifts with the suggested count (template count where there is none), set `demand_forecast_id`, `forecast_suggested_count` and `template_employee_count` on each. The response lists created, skipped and sized shifts.
13. **Use suggestions (D5).** `POST /api/scheduling/periods/{id}/forecast/apply` with `{ shiftIds | all, expectedPeriodVersion }`: stores a new forecast and sets each listed DRAFT shift's count to its suggestion, never below its current assignment count, with each shift's version checked. Shifts not from a template are never changed. Audited per shift as the existing shift edit.
14. **Generator.** Unchanged in what it does. A run's `rules_snapshot` records the forecast IDs of the period's shifts; its warnings include `FORECAST_NOT_ENOUGH_HISTORY` for dates without a forecast where `useForecast` was asked.
15. **Published periods.** Never changed by the forecast. Preview on a published period is read-only.

### D. Report (D8)

16. **Forecast vs actual** in the Labor area (`reports.labor`): for each business date in range before today with a stored forecast, the latest forecast used for that date; per measure the forecast and actual daily totals and busiest hour, difference and percentage (worked out from the totals, decimal strings). Actuals from `getDemandHistory`. Cross-location view: daily totals per location plus total. CSV export. Read-only.

### E. Phase 23 leftovers (D12)

17. **Dev E2E wait.** `expect.timeout` 5 s when `isCi()`, else 15 s; no other timeout changes.
18. **Reservation events.** The reservation services write outbox events for staff create, edit, cancel, check-in, no-show and seat, after the existing audit, IDs and location only; the reservations board's `useRealtimeRefresh` subscribes to them.
19. **E2E gaps.** The three tests in section 7.

### F. Boundaries

20. Forecasting reads closed checks and reservations only; it never writes to Orders or Reservations.
21. No money, wages or employee data in any forecast, snapshot, audit row or outbox payload.
22. The canonical Bacon Cheeseburger test and every Phase 4 generator test pass unchanged.

## Amendments decided at implementation

1. **History in tests, demo and E2E (D11).** Instead of moving closed checks' dates back with SQL (closed orders are frozen by `orders_closed_frozen`), the history is made through the real services *at* the past time: integration tests use the existing fake clock; the demo seed and the E2E helper move only their own process's clock. Business dates, tenders, sessions and the ledger all agree, and nothing frozen is rewritten.
2. **Demo history (D11).** The checks sell one "Demo history plate" with no recipe and no kitchen route (no tickets, no stock), paid by external card (no drawer). The seed skips any business date that already has history checks, so an interrupted run can be finished. Ratios: Server 12 covers, Bartender 8 bar checks, Host 30 covers, Cook 10 checks per hour (Line Cook isn't a seeded position).
3. **Third snapshot table (policy 11).** `demand_forecast_dates` keeps each date's status and sample dates, so the report finds forecast dates without reading JSON. Hours with a zero forecast and nothing booked aren't stored (they read as zero).
4. **Forecast dates.** A period's forecast also covers the day after its end, for late shifts past the cutoff. Dates before today's business date get no forecast; their shifts show the reason `STARTED`.
5. **Dining covers (D1).** The measure is the sales-by-hour covers figure: seated table sessions, once per session, whichever area (bar seating included).
6. **Audit (policy 13).** Shift edits aren't audited one by one in this codebase, so using suggestions writes one `scheduling.forecast-applied` row (period, mode, how many shifts, how many dates), like applying a template with the forecast. Ratios and excluded dates are audited with before and after.
7. **Generator (policy 14).** A run records `demandForecastIds` in its rules snapshot. It adds no `FORECAST_NOT_ENOUGH_HISTORY` warning, because the generator can't know which dates were applied with the forecast; the apply-template response and the Forecast panel show each date's status instead.
8. **Forecast panel (D5).** Each date's busy hours are a table, not a chart.
9. **Preview (policy 15).** Schedule editors see the panel on any period; the use buttons appear only on drafts. The settings call also returns the active positions, since a rules manager may not hold template permissions.
10. **Cross-location labor (policy 16).** "All my locations" adds forecast and actual dining covers.
11. **E2E placement (section 7).** The forecast test lives in `scheduling.spec.ts`, because that file's cleanup deletes every staffing template; tests in one file run in order. The lot-expiry bell test runs the time-based signals for its own location only, so other specs' accounts get no extra notices.
12. **Forecast E2E under `next dev`.** The test has a 150-second limit of its own and retries its "Apply template" and "Use suggestion" clicks until the result shows (applying again adds only what's missing), because a click before hydration can be lost under `next dev`. The suite-wide timeouts are unchanged apart from policy 17.
13. **Migration names (policy 11).** The generated foreign keys of `demand_forecast_dates` and `demand_forecast_hours` reached PostgreSQL's 63-character limit, so they are named (`demand_forecast_dates_forecast_fk`, `demand_forecast_hours_forecast_fk`) and `0061`–`0062` were regenerated before they were applied anywhere but throwaway test databases.

## 1. Objectives

Deliver policies 1–22, the migrations, the tests in sections 5–7, README, CLAUDE.md and User Guide updates, and `docs/Phase-24-Completion-Report.md`.

## 2. Scope Boundary

Out of scope (don't build):

- Machine learning, external data, holiday calendars, trend or seasonality models beyond the same-weekday average
- Forecasting money, items, prep or purchasing
- Creating shifts or moving shift times from the forecast; changing published schedules
- Cross-location forecasting
- Delivery, loyalty, accounting, payroll, cloud deployment (on hold)

## 3. Review Existing Foundation Before Changes

Confirm from code before each step:

- `applyTemplate`, `buildShiftTimes`, `lockEditableDraft`, `updateShift` and their tests.
- `runGeneration` and `schedule_generation_runs.rules_snapshot`.
- The sales-by-hour query and `hoursFromCutoff`, for the history rule.
- `BusinessDateService` and location time zones.
- The reservation services and the outbox writers, for the new events.
- The Staffing page and the period page, for the new panels.
- `playwright.config.ts` and `isCi()`.

If any conflicts with the policies, stop and explain before changing it.

## 4. Build Order

Migrations start at 0061. Each step generates its own migration (plus a custom one for triggers), reviewed before applying, and leaves lint, typecheck, unit and integration tests green.

1. **Phase 23 leftovers:** the dev E2E wait, reservation events and board subscription (policies 17–18).
2. **History and booked queries** with the equality test against sales by hour (policies 1–2).
3. **Forecast rules** (pure) and their unit tests (policies 3–4, 8–9).
4. **Settings, ratios and excluded dates:** tables, services, Staffing page (policies 5–7).
5. **Preview, snapshot, apply template, use suggestions:** tables, routes, Forecast panel (policies 10–15).
6. **Forecast vs actual report** (policy 16).
7. **Seeds, E2E, documentation and the completion report** (D11, policy 19).

## 5. Unit Tests

- *History dates:* same weekday only, newest first, skips closed and excluded dates, stops at 12 weeks, takes the look-back count.
- *Weighted average:* hand-worked values; two-decimal strings; no floating error (for example weights over 7 samples of 1, 2 and 3 covers).
- *Not enough history* and *bookings only.*
- *Booked floor:* applies to dining covers only.
- *Suggested count:* busiest hour across a cross-midnight window; rounding up; minimum and maximum; at least 1; no ratio.
- *Explanation text* for each reason.
- *Hour mapping:* windows starting before and after the cutoff, and on a daylight-saving change day in the location's zone.

## 6. Integration Tests

- **History equals sales by hour** for several dates, including split checks (covers once), bar and takeout, voided and open checks left out.
- **Booked covers:** only `PENDING` and `CONFIRMED`, by local hour and business date; cancelled and no-show left out.
- **Preview:** stores nothing; matches the unit rule on fixture history; a new location shows not enough history.
- **Apply template with forecast:** one transaction; forecast snapshot and hours stored; shift counts as suggested, template counts where not; columns set; a retry of apply adds no shifts; without `useForecast` behaves exactly as Phase 4.
- **Use suggestions:** never below assigned count; version conflicts refused; shifts not from a template untouched; published period refused.
- **Snapshot immutability:** update and delete of forecast rows refused by the trigger; a later ratio change doesn't change a stored forecast.
- **Ratios and excluded dates:** one active ratio per position; validation; concurrency; audit before and after.
- **Generator:** a run on forecast-sized shifts fills them and records the forecast IDs; every Phase 4 generator test unchanged.
- **Forecast vs actual:** uses the latest stored forecast per date; actuals equal history; cross-location totals equal per-location runs.
- **Permissions:** every new API refuses without its permission at the actor's location.
- **Reservation events:** each staff change writes one outbox event after commit, IDs only.
- **Canonical scenario** unchanged. **Migrations:** reconstruction and upgrade from Phase 23; existing shifts have null forecast columns.

## 7. E2E Tests (Playwright)

- **New `forecasting.spec.ts`:** a manager sets server and bartender ratios and excludes one date; creates a draft period, applies the template with the forecast, sees sized shifts with explanations; uses a suggestion on an edited shift; generates; publishes; the Labor report shows forecast vs actual for a past period.
- **Leftovers:** the `LOT_EXPIRING` bell; "Add an existing person"; the reservations board updating on an online booking and on a staff edit in another tab, without a reload.
- **Every existing spec** still passes in CI mode, and twice against `npm run dev` with no re-run.

## 8. Documentation

- **README sections 11, 21 and 39:** the policies as built.
- **README section 33:** a "Phase 24 Demand Forecasting" note; **section 36** and the CLAUDE.md phase list: Phase 24, with a short forecasting policy in CLAUDE.md.
- **Phase 4 plan:** an amendment noting forecasting was added in Phase 24.
- **`docs/User-Guide.md`:** staffing ratios, excluded dates, applying a template with the forecast, the Forecast panel, forecast vs actual.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first), and twice against `npm run dev` with no re-run
- [ ] `npm run build`
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] Migrations generated, reviewed and committed; `npm run db:generate` then reports no changes
- [ ] Migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants (149); `db:seed:validation` and `db:seed:demo` twice create no duplicates
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] The canonical Bacon Cheeseburger test and the Phase 4 generator tests pass unchanged
- [ ] History for a past date equals the sales-by-hour report
- [ ] No forecast changes a published period; stored forecasts are never updated

## 10. Required Phase 24 Completion Report

Write `docs/Phase-24-Completion-Report.md`:

```text
PHASE 24 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- History and booked demand:
- Forecast rule (look-back, weights, minimum, booked floor, excluded dates):
- Ratios and suggested counts:
- Using the forecast (apply template, suggestions, generator, published periods):
- Snapshots:
- Forecast vs actual:
- Phase 23 leftovers:
- Permissions, audit, outbox and boundaries:

Results
- History equals sales by hour: PASS / FAIL
- Forecast is deterministic and matches hand-worked values: PASS / FAIL
- Shifts sized only on request, only on DRAFT periods: PASS / FAIL
- Stored forecasts are immutable and explain each sized shift: PASS / FAIL
- Generator behaviour unchanged: PASS / FAIL
- Dev-server E2E passes twice with no re-run: PASS / FAIL
- Canonical Bacon Cheeseburger unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e CI and dev, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
