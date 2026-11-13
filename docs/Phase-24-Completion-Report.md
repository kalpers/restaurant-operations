PHASE 24 COMPLETION REPORT

# Summary

Phase 24 builds the fourth README section 39 group: demand forecasting from historical sales and reservations, used to size the shifts the schedule generator fills. The owner approved the plan (`docs/Phase-24-Demand-Forecasting.md`, D1–D12 as recommended) on 2026-11-12, and it was built the same day with 13 amendments, listed in the plan.

- Each date of a schedule period gets an hourly forecast of dining covers, bar checks, takeout checks and all checks. It is a weighted average of the same weekday over recent weeks of closed checks, never below the covers already booked. Counts only, never money.
- Staffing ratios per position turn the busiest hour of a shift into a suggested headcount.
- Shifts are sized only when a manager asks, on a draft schedule: apply a template with the forecast, or use a suggestion. Each forecast used is stored unchanged, and every sized shift says why. The generator is unchanged.
- The Labor report gains "Forecast vs actual".
- Phase 23 leftovers:
  - staff reservation changes now refresh open reservations boards;
  - Playwright waits 15 seconds per assertion under `next dev`;
  - three missing E2E tests were added.

Lint, typecheck, unit (914), integration (1432/1432), build, audit, seeds and the migration checks pass. E2E passes 169/169 in CI mode. Against `next dev` it did not pass twice with no re-run: the final two runs each had one failure, both in tests this phase didn't change (see Remaining issues). Down from 5, 1 and 6 failures in Phase 23.

# Environment

- Node v26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker Compose), Windows 11.
- No dependency was added or changed. `npm audit --omit=dev`: 0 vulnerabilities.

# Policies (as built)

- **History and booked demand:**
  - `getDemandHistory` (`src/modules/orders/queries/demand-history.ts`) returns, for each business date and local hour opened, dining covers (seated table sessions, counted once per session on its first closed check), bar, takeout and all checks, from CLOSED orders. A date's figures equal its sales-by-hour report (tested).
  - `getBookedCovers` (`src/modules/reservations/queries/booked-demand.ts`) sums the party sizes of PENDING and CONFIRMED reservations by business date and local hour.
  - Both are read-only and live in their owning modules, because Reporting already imports Scheduling.
- **Forecast rule:**
  - Pure functions in `src/modules/scheduling/rules/demand-forecast.ts`.
  - Sample dates: the same weekday, newest first, before today's business date, within 12 weeks, skipping dates with no closed checks and dates on the location's excluded list. It takes `forecast_lookback_weeks` of them (default 6).
  - Weights run from n down to 1. The average is worked out in integer arithmetic and kept as a two-place decimal string.
  - Fewer than `forecast_minimum_samples` dates (default 3) gives `NOT_ENOUGH_HISTORY`, or `BOOKINGS_ONLY` when covers are booked.
  - Dining covers are raised to the booked covers.
  - Excluded dates (`demand_excluded_dates`) need a reason and are deactivated, never deleted.
- **Ratios and suggested counts:**
  - `staffing_ratios`: one active ratio per location and position, with a measure, units per employee-hour (`NUMERIC(8,2)`), a minimum and a maximum. Version checked and audited.
  - Suggestion = ceil(busiest hour the shift touches ÷ units), held between the minimum and maximum, and at least 1.
  - The hours a shift touches follow its local hours across midnight, the business-day cutoff and daylight-saving changes.
  - Every suggestion carries its reason (`FORECAST`, `MINIMUM_APPLIED`, `MAXIMUM_APPLIED`, `NO_RATIO`, `NOT_ENOUGH_HISTORY`, `STARTED`) and a sentence explaining it.
- **Using the forecast:**
  - `GET /api/scheduling/periods/{id}/forecast` previews it and stores nothing.
  - `applyTemplate` with `useForecast` sizes new template shifts in its one transaction. It defaults to off, so existing callers behave exactly as before.
  - `POST /api/scheduling/periods/{id}/forecast/apply` sets listed (or all) template shifts on a DRAFT period to their suggestion, never below the assigned count; hand-added shifts are skipped. It needs the period version.
  - Published periods are never changed; their panel is read-only.
  - The generator is unchanged. A run's rules snapshot lists the stored forecasts that sized its shifts.
- **Snapshots:**
  - `demand_forecasts` holds the settings, the ratios with their versions and the excluded dates.
  - `demand_forecast_dates` holds each date's status and sample dates.
  - `demand_forecast_hours` holds the non-zero hourly figures.
  - All three are append-only (migration `0062` guard) and written in the transaction that uses them.
  - A sized shift keeps `demand_forecast_id`, `forecast_suggested_count` and `template_employee_count`.
- **Forecast vs actual:**
  - In the Labor area (`reports.labor`), for each past business date with a stored forecast (the latest one used): forecast and actual totals per measure, the difference and its percentage, and each side's busiest hour.
  - It reads the snapshot and closed checks only, and exports to CSV like every section.
  - "All my locations" adds forecast and actual dining covers.
- **Phase 23 leftovers:**
  - Staff create, edit, confirm, set tables, check in, cancel, no-show and seat write outbox events (`reservation.created`, `.updated`, `.checked-in`, `.cancelled`, `.no-show`, `.seated`; IDs only, after commit). The board and the realtime provider listen for them.
  - `playwright.config.ts`: `expect.timeout` is 5 s in CI mode and 15 s under `next dev`.
  - New E2E tests for the lot-expiry bell, "Add an existing person" and the live board.
- **Permissions, audit, outbox and boundaries:**
  - No new permission (149). Preview and use need `schedule.edit`; ratios, excluded dates and settings need `schedule.rules.manage`; the report needs `reports.labor`.
  - New audit actions (category SCHEDULING, counts and settings only): `scheduling.forecast-applied`, `scheduling.staffing-ratio-saved`, `scheduling.forecast-date-excluded`, `scheduling.forecast-date-restored`.
  - No money, wages, employee or guest data appears in any forecast, snapshot, audit row or event.

# Results

- History equals sales by hour: PASS
- Forecast is deterministic and matches hand-worked values: PASS (unit and integration: 7.80, 7.33, 9.33, 1.80, 0.40, booked 12.00)
- Shifts sized only on request, only on DRAFT periods: PASS
- Stored forecasts are immutable and explain each sized shift: PASS (the trigger refuses UPDATE and DELETE; a ratio change leaves a stored forecast as it was)
- Generator behaviour unchanged: PASS (all Phase 4 generator tests unchanged; the run records the forecast IDs)
- Dev-server E2E passes twice with no re-run: FAIL (final two runs: 1 failure each, in tests this phase didn't change; down from 5, 1 and 6 in Phase 23)
- Canonical Bacon Cheeseburger unchanged: PASS

# Architectural decisions

- History queries are owned by Orders and Reservations; the forecast rules, service, tables and screens belong to Scheduling; the report section belongs to Reporting. No module boundary moved.
- The forecast is computed on read. It is stored only when used, as an append-only snapshot, so historical facts are never recalculated from current settings (rule 4).
- History for tests, E2E and the demo is made through the real services at the past time, under a fake or shifted clock in that process only. Nothing frozen is rewritten (amendment 1).

# Migrations

- `0061_demand_forecasting.sql`:
  - new tables `staffing_ratios`, `demand_excluded_dates`, `demand_forecasts`, `demand_forecast_dates`, `demand_forecast_hours`;
  - `scheduling_rules.forecast_lookback_weeks` and `forecast_minimum_samples`, with a check;
  - `shifts.demand_forecast_id`, `forecast_suggested_count` and `template_employee_count`, with a foreign key and a check.
- `0062_demand_forecasting_guards.sql` (custom): append-only triggers on the three snapshot tables.
- Both were regenerated once before being applied anywhere but throwaway test databases, to give two foreign keys short names (amendment 13). `npm run db:generate` then reports no changes. Applied to the local dev database with `npm run db:migrate`.

# Validation results

- `npm run lint`: PASS (0 problems)
- `npm run typecheck`: PASS
- `npm run test:unit`: PASS
- `npm run test:integration`: PASS
- `npm run test:e2e` in CI mode: PASS, 169/169, no retries (twice: before and after the forecast-test fix)
- `npm run test:e2e` against `npm run dev`, twice: not clean. Before the forecast-test fix (amendment 12): 168/169 and 167/169, the forecast test failing both times on the 30-second test limit or a click lost before hydration, plus one settlements failure. After the fix, the scheduling spec alone passed 18/18, then the full suite twice:
  - run 1: 168 passed, 1 failed: `settlements.spec.ts` "dine-in cash with change closes the order; the session then completes on the floor" (the floor card never changed after a click; the same test failed in an earlier dev run);
  - run 2: 163 passed, 1 failed, 5 did not run: `online-booking.spec.ts` "a signed-out guest books a table..." couldn't see the 19:00 slot. The run crossed local midnight into 2026-11-13, which moves the test's "tomorrow"; the serial file then skipped its other tests.
  - Neither test was changed by this phase. Both pass in CI mode.
- `npm run build`: PASS
- `npm audit --omit=dev`: 0 vulnerabilities
- Migration reconstruction and upgrade tests: PASS (expected table list updated)
- `npm run db:seed` twice: "0 applied, 27 already applied" both times; permissions stay at 149
- `npm run db:seed:validation` twice: nothing to do both times
- `npm run db:seed:demo` twice: the first run added 414 closed checks over 42 days; the second added 0 ("42 dates already had them") and no ratios
- `npm run db:reset` safeguards: refused a non-loopback host and a wrongly named database

# Tests executed

- Unit: 914 tests in 63 files, 17 of them new (`demand-forecast.test.ts`: sample dates, weighted average, the booked floor, too little history, the hours a shift touches across the cutoff, midnight and daylight saving, suggestions and their explanations).
- Integration: 1432 tests in 98 files. New:
  - `scheduling/demand-forecast.test.ts` (16): history equals sales by hour, booked covers, the preview, minimum samples, excluded dates, ratios, applying a template with and without the forecast, the generator snapshot, using suggestions, snapshot immutability, permissions, location isolation, the booked floor, forecast vs actual;
  - `reservations/reservation-events.test.ts` (3).
  - Updated: migrations, actual-labor and staffing-config.
- E2E: 169 in CI mode (165 before plus 4 new). New tests:
  - `scheduling.spec.ts` "demand forecast";
  - `transfers-and-lots.spec.ts` lot-expiry bell;
  - `locations.spec.ts` "Add an existing person";
  - `online-booking.spec.ts` live board.

# Files changed

- **New source:**
  - `src/modules/scheduling/rules/demand-forecast.ts` (+ test)
  - `src/modules/scheduling/services/forecast-service.ts`
  - `src/modules/scheduling/repositories/forecast-repository.ts`
  - `src/modules/orders/queries/demand-history.ts`
  - `src/modules/reservations/queries/booked-demand.ts`
  - `src/modules/reporting/queries/forecast-report.ts`
  - `src/app/(app)/scheduling/[periodId]/forecast-section.tsx`
  - `src/components/scheduling/forecast-settings.tsx`
  - API routes under `src/app/api/scheduling/forecast/` and `src/app/api/scheduling/periods/[periodId]/forecast/`
- **Changed source:**
  - `src/db/schema/scheduling.ts`
  - `src/modules/scheduling/{services/config-service,services/generation-service,services/scheduling-input,repositories/schedule-repository,rules/schedule-rules,validators/scheduling-validators}.ts`
  - `src/modules/auditing/audit-actions.ts`
  - `src/modules/reporting/services/{report-service,cross-location-service}.ts`
  - `src/modules/reservations/services/reservation-service.ts`
  - `src/workflows/seat-guest-party/seat-guest-party.ts`
  - `src/components/realtime/realtime-provider.tsx`
  - `src/components/reservations/reservations-board.tsx`
  - the period and staffing pages
- **Migrations:** `drizzle/migrations/0061_*`, `0062_*`, their snapshots and the journal.
- **Seeds:** `scripts/demo-forecast-history.ts` (new) and `scripts/seed-demo.ts`.
- **Tests:**
  - new fixtures and helpers: `tests/fixtures/forecast-fixtures.ts`, `tests/fixtures/forecast-history.ts`, `tests/helpers/e2e-forecast.ts`;
  - changed fixtures and helpers: `tests/fixtures/employee-fixtures.ts`, `tests/helpers/e2e-scheduling.ts`, `tests/helpers/e2e-locations.ts`;
  - the integration and E2E files above;
  - `playwright.config.ts`.
- **Docs:**
  - `README.md` (sections 11, 21, 33, 36 and 39)
  - `CLAUDE.md`
  - `docs/User-Guide.md`
  - `docs/Phase-4-Scheduling.md` (amendment)
  - `docs/Phase-24-Demand-Forecasting.md` (approval and amendments)
  - this report

# Risks

- **Shifting time zones.** History hours use the location's current time zone. A location that changes time zone gets hours shifted for the dates before the change, just as the sales-by-hour report does.
- **Large stored forecasts.** A long period stores one row per non-zero hour and measure (about 500 rows for a busy week). Indexed, and written only when a manager uses the forecast.
- **Demo history.** The demo seed moves its own process's clock (`globalThis.Date`) while it runs, and puts it back afterwards. This is the local dev database only, behind the existing seed guard.
- **Leftover demo item.** The first, failed demo run on the local dev database left an item `DEMO_HISTORY_PLATE` whose price starts today. It was deactivated through the menu service, and the seed now uses `DEMO_FORECAST_PLATE`.

# Remaining issues

- **Dev-server E2E is still not clean twice in a row** (owner decision). The 15-second dev wait (policy 17) took the failures from 5, 1 and 6 down to 1 and 1, but two dev-only flakes remain.
  - `settlements.spec.ts` dine-in: a floor-card click sometimes has no effect under `next dev`, probably because it lands before hydration.
  - `online-booking.spec.ts`: its "tomorrow" can move when a run crosses midnight.
  - Options: retry-until-shown on the settlements clicks and a fixed booking date in the online-booking test, or accept dev-mode E2E as advisory (CI mode is the gate).
- A real SMTP and Twilio send stays a manual check for the owner (Phase 22 leftover).
- No forecasting of sales money, prep or purchasing (out of scope by D1).

# Next-phase readiness

Phase 24 is complete. Every README section 39 group the owner named is now built. Cloud deployment stays on hold. Any next phase needs a plan and the owner's approval first.
