PHASE 25 COMPLETION REPORT

# Summary

Phase 25 carries the Phase 24 demand forecast into the kitchen and purchasing. The owner chose this scope on 2026-11-16 and approved the plan (`docs/Phase-25-Prep-and-Purchasing-Forecast.md`, D1–D12 as recommended) the same day. It was built that day with 11 amendments, listed in the plan.

- **Item forecast:** expected portions per menu item per business date, from the same weekday's closed checks, using the Phase 24 method and settings.
- **Ingredient forecast:** what those portions take, from the recipe in effect on the date plus the modifiers guests usually choose.
- **Prep list:** a read-only list per station (Kitchen → Prep list), for today and the next six days.
- **Suggested orders from the forecast:** a second basis next to the par levels. The need is forecast usage + reorder level − on hand − on order; items the forecast doesn't cover stay on par. Creating drafts stores the forecast unchanged.
- **Report:** "Item forecast vs actual" in the Inventory area.
- **Phase 24 leftovers:**
  - a click-until-shown helper for the settlements clicks lost before hydration under `next dev`;
  - one booking date for the whole online-booking spec;
  - the 16 unused Docker volumes removed after the owner confirmed.

These pass: lint, typecheck, unit (929), integration (1445/1445), build, audit, seeds, the migration checks, and E2E in CI mode (171/171, no retries).

Against `next dev`, four full runs:

- **Runs 1 and 2:** one failure each, the settlements dine-in test on its 30-second limit. Fixed by amendment 11.
- **Run 3:** 171/171.
- **Run 4:** two failures in `scheduling.spec.ts`, which this phase didn't change. The dev server dropped a connection, then a sign-in click was lost.

So two clean runs in a row was not reached (see Remaining issues).

# Environment

- Node v26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker Compose), Windows 11.
- No dependency was added or changed. `npm audit --omit=dev`: 0 vulnerabilities.

# Policies (as built)

- **Shared forecasting rules:**
  - `selectHistoryDates`, the integer `weightedAverage` and `MAXIMUM_HISTORY_WEEKS` moved to `src/shared/forecasting/history-dates.ts`.
  - Scheduling re-exports them, so every Phase 24 caller and test is unchanged.
  - New `weightedAverageDecimal` (newest weighted highest, decimal arithmetic only).
- **Item forecast (history, menu, new items):**
  - `getItemSalesHistory` (`orders/queries/item-sales-history.ts`): portions per business date and menu item from CLOSED checks (items SUBMITTED or SPLIT), the portions carrying each modifier, the dates with a closed check, and each item's first sale. A date's portions equal the item-mix report (tested).
  - The items are those placed on an active menu offered at the location on that date (`menu/queries/forecast-menu.ts`); `available` and 86 state are ignored.
  - Sample dates and settings are those of Phase 24: same weekday, look-back and minimum from `scheduling_rules`, excluded dates, at most 12 weeks.
  - A usable date on which the item didn't sell counts as zero.
  - Fewer samples than the minimum gives `NOT_ENOUGH_HISTORY`.
  - An item first sold after the oldest sample date is marked as new.
  - Dates run from today to 14 days ahead.
- **Ingredients (recipe in effect, modifier shares, today):**
  - One portion = the revision in effect at the date's start, its quantities as SEND uses them (amendment 1), from the extended `recipes/queries/menu-item-requirements.ts`.
  - For each modifier: its weighted share of past portions (dates the item sold) × the change it makes on its own, worked out with the SEND rule `applyModifierEffects` against current effects. No ingredient goes below zero.
  - For today, portions = forecast − portions already sent today on any non-voided check, not below zero.
  - Rules: `src/workflows/forecast-items/item-forecast-rules.ts`.
- **Prep lists:**
  - `GET /api/kitchen/prep-list` and `/kitchen/prep`.
  - Shows KITCHEN stations under `kitchen.view` and BAR stations under `bar.view` (amendment 4).
  - Per item routed to the station (current routing): whole portions rounded up, the usual modifiers ("about N …", shown from 1), and ingredients in base units for those portions.
  - Today to six days ahead; worked out on read, never stored; a plain GET form for date and station.
- **Forecast-based suggested orders and snapshots:**
  - The `forecast-items` workflow computes usage per inventory item (today's remainder through the chosen date) and hands it to Inventory, which never reads other domains.
  - Need rule (`replenishment.ts`): usage + reorder level (or 0) − on hand (negative used as is) − on order, if positive, in whole purchase units of the preferred supplier item. With no usage, the Phase 19 par rule applies.
  - Preview: `GET /api/purchasing/suggested-orders?basis=forecast&through=…`. Lines gain `basis`, `forecastUsageBaseQuantity` and `reorderFloor`. The par response is byte-for-byte the Phase 19 shape.
  - Create: `POST` with `{ basis: "forecast", throughDate, idempotencyKey }`. In one transaction under the existing lock and idempotency scope it:
    - works the forecast out again;
    - stores `purchasing_forecasts` (settings, sample dates, excluded dates, modifier shares per date, sent today, date statuses), `purchasing_forecast_items` (per date and item: status, portions, new item, revision) and `purchasing_forecast_lines` (suggested lines with basis, usage, floor, on hand, on order, need, supplier item, quantity);
    - creates one DRAFT per supplier with `purchasing_forecast_id` and the note "Suggested from the forecast through …".
  - The three tables are append-only (trigger). Nothing is submitted and no stock moves.
- **Item forecast vs actual:**
  - In the Inventory area (`reports.inventory`): for each past business date covered by a stored purchasing forecast (the latest one with status OK), forecast and sold portions per item, the difference and its percentage.
  - It reads the snapshot and closed checks only.
  - "All my locations" adds forecast and sold portions. CSV as every section.
- **Leftovers (E2E, Docker):**
  - `clickUntilShown` in `tests/helpers/e2e-ui.ts` (checks for the result before clicking again), used on both settlements "Complete session" clicks. That test also has a 90-second limit (amendment 11).
  - `online-booking.spec.ts` uses one `BOOKING_DATE` computed at load, two days ahead in America/Detroit.
  - The 16 dangling Docker volumes were listed and, on the owner's confirmation, removed; `restaurant-operations_postgres_data` is untouched.
- **Permissions, audit and boundaries:**
  - No new permission (149).
  - The audit row `purchasing.suggested-orders-created` gains `basis`, `throughDate` and `purchasingForecastId`.
  - Forecasting writes no ledger rows and no order, menu, recipe or schedule data (tested).
  - No money appears in the item forecast, prep list or snapshots; PO estimates stay under `inventory.cost.view` as before.

# Results

- Item history equals item mix: PASS (three dates)
- Ingredient forecast matches hand-worked values and SEND consumption: PASS. Values: burger 2.33 portions; shares 1.0000, 0.5000, 0.1667, 0.1667; beef 18.6400 oz, American 1.9416, pickles 9.3200; SEND consumption for the Swiss choice checked.
- Prep list stores nothing and follows routing: PASS
- Forecast suggestions create DRAFTs only, idempotent, with an immutable snapshot: PASS (a retry creates nothing more; UPDATE and DELETE refused)
- Phase 19 par basis and Phase 24 forecast unchanged: PASS (Phase 19 suggested-order and Phase 24 forecast suites unchanged and passing; the par preview has no new fields)
- Dev-server E2E passes twice with no re-run: FAIL (four runs; run 3 clean; runs 1–2 failed the settlements test fixed by amendment 11; run 4 failed two unchanged scheduling tests after a dev-server connection reset)
- Canonical Bacon Cheeseburger unchanged: PASS

# Architectural decisions

- **Ownership:** each domain keeps its own reads:
  - Orders: item history and portions sent today;
  - Menu: menu for a date, routing, modifier effects;
  - Recipes: revision and requirements;
  - Scheduling: forecast settings and excluded dates.
- **Workflow:** `src/workflows/forecast-items/` joins them; Inventory, the lowest of these modules, receives only the usage. This follows README rule "workflows for substantial cross-domain orchestration" and avoids the Scheduling → Orders → Menu → Inventory import cycle.
- **Shared rules:** the history-date rules are shared so staffing and items use one method.
- **Storage:** prep lists are computed on read. The purchasing forecast is stored only when drafts are made from it, as an append-only snapshot, so why a draft ordered what it did stays readable (rule 4).
- **Demo history:** made through the real services under a shifted clock, with dedicated fake items whose price and recipe exist for the whole history (amendment 9).

# Migrations

- `0063_purchasing_forecasts.sql`: tables `purchasing_forecasts`, `purchasing_forecast_items`, `purchasing_forecast_lines` with checks and named foreign keys; `purchase_orders.purchasing_forecast_id` (nullable, foreign key).
- `0064_purchasing_forecast_guards.sql` (custom): append-only triggers on the three tables.
- Regenerated once before being applied anywhere but throwaway test databases, to name a foreign key that reached 63 characters (amendment 6).
- `npm run db:generate` reports no changes. Applied to the local dev database with `npm run db:migrate`.

# Validation results

- `npm run lint`: PASS (0 problems)
- `npm run typecheck`: PASS
- `npm run test:unit`: PASS (929)
- `npm run test:integration`: PASS (1445/1445)
- `npm run test:e2e` in CI mode: PASS, 171/171, no retries. `settlements.spec.ts` was rerun in CI mode after amendment 11: 4/4.
- `npm run test:e2e` against `npm run dev`:
  - run 1: 170 passed, 1 failed (settlements dine-in, 30 s test limit);
  - run 2: same;
  - after amendment 11, run 3: 171/171;
  - run 4: 169 passed, 2 failed in `scheduling.spec.ts` ("the API refuses without a session…": `ECONNRESET` from the dev server, which logged stream errors; then "demand forecast": sign-in stayed on /login). Neither test was changed by this phase; both pass in CI mode.
- `npm run build`: PASS
- `npm audit --omit=dev`: 0 vulnerabilities
- Migration reconstruction and upgrade tests: PASS (24, including a new upgrade from a Phase 24 database)
- `npm run db:seed` twice: "0 applied, 27 already applied" both times; permissions 149
- `npm run db:seed:validation` twice: nothing to do both times
- `npm run db:seed:demo` twice: the first run added 42 closed takeout checks and topped up 6 ingredients; the second added nothing ("42 dates already had them")
- `npm run db:reset` safeguards: refused a non-loopback host and a wrongly named database

# Tests executed

- **Unit:** 929 in 65 files, 15 of them new:
  - `src/shared/forecasting/history-dates.test.ts` (3);
  - `src/workflows/forecast-items/item-forecast-rules.test.ts` (9);
  - forecast-basis cases in `inventory-rules.test.ts` (3).
  - The navigation test was updated for the new entry.
- **Integration:** 1445 in 99 files. New: `inventory/prep-purchasing-forecast.test.ts` (12), covering:
  - item history equals item mix;
  - hand-worked forecast and ingredients;
  - SEND consumption agreement;
  - not enough history and date limits;
  - writes nothing;
  - prep list and its permissions;
  - preview vs par;
  - create with snapshot, idempotency and immutability;
  - purchasing permissions and dates;
  - today's remainder;
  - item forecast vs actual.
  - Updated: `database/migrations.test.ts` (expected tables, Phase 24 upgrade).
- **E2E:** 171 in CI mode (169 before plus 2 new in `prep-purchasing.spec.ts`: the cook's prep list, ordering from the forecast). Changed: `settlements.spec.ts`, `online-booking.spec.ts`.

# Files changed

- **New source:**
  - `src/shared/forecasting/history-dates.ts`
  - `src/workflows/forecast-items/forecast-items.ts`, `item-forecast-rules.ts`, `forecast-suggested-orders.ts`
  - `src/modules/orders/queries/item-sales-history.ts`
  - `src/modules/menu/queries/forecast-menu.ts`
  - `src/modules/scheduling/queries/forecast-inputs.ts`
  - `src/modules/reporting/queries/item-forecast-report.ts`
  - `src/app/(app)/kitchen/prep/page.tsx`
  - `src/app/api/kitchen/prep-list/route.ts`
- **Changed source:**
  - `src/db/schema/inventory.ts`, `inventory-links.ts`
  - `src/modules/inventory/rules/replenishment.ts`
  - `src/modules/inventory/services/suggested-order-service.ts`, `purchase-order-service.ts`
  - `src/modules/inventory/queries/item-facts.ts`
  - `src/modules/inventory/validators/inventory-validators.ts`
  - `src/modules/recipes/queries/menu-item-requirements.ts`
  - `src/modules/scheduling/rules/demand-forecast.ts` (re-exports)
  - `src/modules/reporting/services/report-service.ts`, `cross-location-service.ts`
  - `src/modules/auditing/audit-actions.ts`
  - `src/app/api/purchasing/suggested-orders/route.ts`
  - `src/app/(app)/purchasing/suggested/page.tsx`
  - `src/components/inventory/create-suggested-orders-button.tsx`
  - `src/components/app-shell/navigation.ts`, `nav-icons.tsx`
- **Migrations:** `drizzle/migrations/0063_purchasing_forecasts.sql`, `0064_purchasing_forecast_guards.sql`, snapshots and journal.
- **Scripts:** `scripts/demo-prep-history.ts` (new), `scripts/seed-demo.ts`, `scripts/demo-forecast-history.ts` (clock helpers exported).
- **Tests:**
  - New: the unit and integration files above, `tests/e2e/prep-purchasing.spec.ts`, `tests/helpers/e2e-prep-forecast.ts`.
  - Changed: `tests/fixtures/forecast-history.ts` (`closedItemsCheckAt`), `tests/helpers/e2e-ui.ts` (`clickUntilShown`), `tests/e2e/settlements.spec.ts`, `tests/e2e/online-booking.spec.ts`, `tests/integration/database/migrations.test.ts`, `src/components/app-shell/navigation.test.ts`, `src/modules/inventory/rules/inventory-rules.test.ts`.
- **Docs:**
  - `docs/Phase-25-Prep-and-Purchasing-Forecast.md` (new), `docs/Phase-25-Completion-Report.md` (new)
  - `README.md` (sections 11, 16, 18, 21, 33, 36, 39)
  - `CLAUDE.md`
  - `docs/Phase-19-Menu-and-Stock-Signals.md` (amendment 8)
  - `docs/User-Guide.md`

# Risks

- **Recipe changes:** the forecast uses today's recipe and modifier effects for future dates, by design. A recipe changed after drafts were made is not reflected in the stored forecast, which keeps the revision it used.
- **Modifier interactions** are ignored: each modifier's change is taken on its own. With REMOVE and ADJUST on the same ingredient, the average can differ slightly from what SEND would consume.
- **New items** are pulled down by their early zero days. They are marked as new, not corrected.
- **Not enough history** contributes nothing to the forecast, so a date without enough history adds no usage; the preview lists those dates.
- **Demo data:** the local dev database has three fake items (`DEMO_PREP_*`, clearly named), 42 fake closed checks and six FOUND_STOCK adjustments marked as demo. One empty check from a failed first seed run was voided through `voidOrder`.

# Remaining issues

- **Dev-server E2E is still not clean twice in a row.** The two Phase 24 flakes are fixed: online-booking passed all four runs, and settlements passed runs 3 and 4 after amendment 11. Run 4 failed two scheduling tests after a dev-server connection reset. Options:
  - keep fixing per test (for example, retry the sign-in in `scheduling.spec.ts`);
  - accept dev-mode E2E as advisory, with CI mode as the gate (CI mode passes 171/171).
  - Owner decision.
- A real SMTP and Twilio send stays a manual check for the owner (Phase 22 leftover).
- No forecasting of sales money; no prep recipes, prepared stock or prep tracking; no supplier lead times (out of scope by the plan).

# Next-phase readiness

Phase 25 is complete. The work is not committed; the owner reviews this report and commits. Cloud deployment stays on hold. Any next phase needs a plan and the owner's approval first.
