PHASE 28 COMPLETION REPORT

# Summary

Phase 28 (Happy Hour Pricing, Sales Forecast, Accounting Exports and Nutrition) builds four features from the owner's enhancement list, approved on 2026-11-18 (D1–D17 as recommended):

- **Happy hour.** Price periods per location (local days and times, optional order types and dates, a fixed price per item), decided at the SEND instant and snapshotted on the item, with overlapping periods refused. There is a Happy hour page, badges on the order screen and a Price periods section in the Sales report.
- **Sales forecast in dollars.** Expected net sales per hour (`NET_SALES`) by the Phase 24 method, shown only to `reports.sales` holders (Sales forecast, Sales forecast vs actual, a dashboard tile) and stored with each demand forecast that is used.
- **Accounting and payroll exports.** An Exports page with a daily sales and tax journal that must balance per date, and a payroll hours file per employee, position and overtime week. Both are CSV, with no rates or pay.
- **Nutrition.** Ingredient figures and declared item figures, with labels worked out on read from the recipe and chosen modifiers. Missing data is marked "incomplete", never zero. Labels show on the menu item page and in the order dialog.

FIFO lot costing and guest loyalty were deferred by the owner; the plan's section 11 explains what each would take. There are no new permissions (still 149) and no dependency change. There are three migrations, one more than planned (amendment 6).

# Environment

- Node v26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker Compose), Windows 11.
- `npm audit --omit=dev`: 0 vulnerabilities.

# Policies (as built)

- **Price periods (model, instant, overlaps, snapshots, report):**
  - Tables `price_periods` and `price_period_items` (Menu, `src/db/schema/price-periods.ts`).
  - The pure rule `menu/rules/price-periods.ts` compares wall-clock time in the location's time zone. An end at or before the start crosses midnight and belongs to the start day.
  - `loadPeriodPriceFacts` / `sellingPrice` (`menu/queries/price-period-prices.ts`) serve both `getOperationalMenu(…, { orderType })` and `resolveMenuItemPrice(…, orderType)`. No regular price means not sellable.
  - SEND prices at `sentAt` for the order's type and writes `price_period_id`, `price_period_name_snapshot` and `regular_price_snapshot`. These are frozen by the replaced `order_items_freeze` trigger (0066).
  - Drafts preview the period price. The order screen shows "<name> until <time>" and the regular price.
  - Overlaps: `PRICE_PERIOD_OVERLAP` under the location row lock. Date ranges are compared as ranges, so two short ranges on different weekdays are refused conservatively.
  - Periods are deactivated, never deleted (trigger). Audit actions: `menu.price-period-created`, `-updated`, `-deactivated`.
  - The "Price periods" Sales section is built from snapshots on CLOSED orders (the item-mix rule).
- **Sales forecast (measure, visibility, storage, forecast vs actual):**
  - `demand-history.ts` returns `netSales` per hour, equal to sales by hour (tested).
  - `forecastDate` adds `netSales` hours using `weightedAverageDecimal`, with the same samples and status and no booked floor. The count measures and staffing ratios are untouched (`STAFFING_MEASURE_SQL`).
  - Schedule responses never contain `NET_SALES` (tested).
  - Stored demand forecasts include the `NET_SALES` rows and `method.netSales = true`.
  - "Sales forecast" (14 days, plus hours) is worked out on read. "Sales forecast vs actual" reads only stored forecasts flagged `netSales`. The Overview tile "Forecast net sales today" appears for `reports.sales` holders.
- **Sales journal (lines, balance rule):**
  - The pure builder `reporting/rules/sales-journal.ts` and the read-only query `queries/sales-journal.ts` use CLOSED orders by business date. Lines come from SUBMITTED items plus ACTIVE shares by category snapshot, applied discounts (comps separate), `order_tax_lines` and RECORDED tenders on COMPLETED settlements.
  - Refunds are dated by their own business date. Drawer variance uses the session's business date (amendment 7).
  - Included tax is taken back out as a `SALES/TAX_INCLUDED` debit (amendment 2).
  - A day that doesn't balance is refused with `JOURNAL_OUT_OF_BALANCE`.
- **Payroll hours file (rows, overtime, tips, open-entry refusal):**
  - `rules/payroll-hours.ts` and `queries/payroll-hours.ts` use `findWorkedEntries` and `allocateOvertime`, as the actual labor report does.
  - The range must be whole weeks, 1–6 (`PAYROLL_RANGE_NOT_WHOLE_WEEKS`, amendment 4).
  - The export is refused while any entry in the range is OPEN (`TIME_ENTRIES_OPEN`, naming employee numbers and dates).
  - Tip columns (finalized shares, declared tips on the employee's row with most hours that week, `tips_finalized`) appear only if tips are visible at every included location (amendment 3).
  - No rate, wage or pay columns (tested against `rate|wage|pay|cost`).
- **Exports page:**
  - `/reports/exports` and `GET /api/reports/exports/{journal|payroll}` (`services/export-service.ts`).
  - The page needs `reports.export`. Each file checks its own permission set at every included location and supports "All my locations" (a `location_code` column).
  - Exports run in a READ ONLY snapshot and are audited as `reports.exported` (`exports:journal`, `exports:payroll`).
  - Files are plain CSV with snake_case headers; the existing formula-injection guard applies.
- **Nutrition (facts, worked-out label, incomplete figures, declared values, display):**
  - Tables `inventory_item_nutrition` (per a basis amount of the base unit) and `menu_item_nutrition` (declared), owned by Recipes. The figure list lives in `src/shared/nutrition/figures.ts` so the client bundle doesn't load the schema.
  - `recipes/rules/nutrition-label.ts` sums per portion, tracks incomplete figures with counts, applies declared figures, and rounds for display by FDA rules.
  - `queries/nutrition-facts.ts` builds the labels. `menu/services/nutrition-quote-service.ts` applies modifier effects with `applyModifierEffects`, the SEND rule.
  - Edits need `recipes.edit`, are version-checked, and are audited by field name only. Reads need `menu.view`. There is no SEND snapshot.
- **Permissions, audit and boundaries:** no new permission (149). Five new audit actions. Settlement, inventory, kitchen and tip rules are unchanged. Reporting stays read-only.

# Results

- Happy hour price applies at SEND inside the window only, and is snapshotted: **PASS** (`menu/price-periods.test.ts`, 8 tests; E2E "a manager sets up a takeout happy hour…")
- Sales forecast visible only with `reports.sales`, and stored with the demand forecast: **PASS** (`scheduling/demand-forecast.test.ts`, 17 tests)
- Every journal date balances, and payroll hours equal the labor report: **PASS** (`reporting/exports.test.ts`, 8 tests: tax added and included, an exemption, a discount, a comp, cash with a drawer, a card tip, a refund with a tip, and a drawer short)
- No wage, rate, contact detail or note in any export: **PASS**
- Nutrition label equals the rule, and missing data never reads as zero: **PASS** (`recipes/nutrition.test.ts`, plus unit tests)
- Canonical Bacon Cheeseburger and idempotent retry unchanged: **PASS** (full integration suite; a happy-hour SEND retry adds nothing)

# Architectural decisions

- Price periods were added to the one price lookup rather than as a discount, so totals, tax and settlement are unchanged.
- `NET_SALES` lives in the existing Scheduling forecast and snapshot tables. No new table, and money is kept out of the schedule APIs by construction (the four-measure maps are unchanged).
- The exports are Reporting services that write nothing but the audit row.
- Nutrition sits beside the allergen tables in Recipes. The order-screen quote lives in Menu, because Menu already depends on Recipes and not the other way round.

# Migrations

- `0065_pricing_forecast_nutrition.sql` (generated): the four tables, the three `order_items` columns and their check, and `NET_SALES` in the demand-measure check.
- `0066_pricing_forecast_nutrition_guards.sql` (custom): price periods can't be deleted; `order_items_freeze` now covers the new snapshots.
- `0067_price_period_items_restrict.sql` (generated, amendment 6): the period items key is RESTRICT. `0065` had already been applied to the local dev database, so it was not edited.
- `npm run db:generate` afterwards: "No schema changes".

# Validation results

| Check | Result |
|---|---|
| `npm run lint` | Clean |
| `npm run typecheck` | Clean |
| `npm run test:unit` | 965 passed (69 files) |
| `npm run test:integration` | 1474 passed (104 files). The first full run failed 8 tests: 3 in `migrations.test.ts` (table list, plus the cascading key → 0067), 2 older tests that expected the old price lookup shape and section order (updated), and 2 kitchen authorization setup timeouts while a build ran alongside (they passed on rerun). The second full run passed. |
| `npm run test:e2e` (CI mode, after `npm run build`) | 178 passed, including the 4 new Phase 28 tests. A dev-server run wasn't done (advisory). |
| `npm run build` | Succeeds with no warnings |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migration reconstruction and upgrade | Pass (`database/migrations.test.ts`) |
| `db:seed` twice | 0 applied, 27 already applied, both times; 149 permissions |
| `db:seed:demo` twice | First run: 1 happy hour and 6 ingredients' nutrition; second run: nothing added |
| `db:seed:validation` | **Failed on the local dev database** (see Risks): not enough stock for the validation burger, because the demo service history used up MAIN's demo-kitchen stock. Idempotency of this seed wasn't re-shown this phase. Its flow is exercised by `tests/integration/validation` (passing). |
| `db:reset` safeguards | Pass (database integration tests). Not run against the dev database. |

# Tests executed (new or changed)

- Unit: `menu/rules/price-periods.test.ts` (12), `reporting/rules/sales-journal.test.ts` (6), `reporting/rules/payroll-hours.test.ts` (4), `recipes/rules/nutrition-label.test.ts` (8), `scheduling/rules/demand-forecast.test.ts` (+2), `app-shell/navigation.test.ts` (updated for 51 links).
- Integration: `menu/price-periods.test.ts` (8), `reporting/exports.test.ts` (8), `recipes/nutrition.test.ts` (4), `scheduling/demand-forecast.test.ts` (extended, plus 1 new test), and the updated `database/migrations.test.ts`, `menu/pricing.test.ts` and `reporting/reports.test.ts`.
- E2E: `pricing-exports-nutrition.spec.ts` (4).

# Files changed

- Schema and migrations: `src/db/schema/price-periods.ts`, `nutrition.ts`, `orders.ts`, `scheduling.ts`, `index.ts`; `drizzle/migrations/0065`–`0067` with their snapshots and journal.
- Menu: `rules/price-periods.ts`, `queries/price-period-prices.ts`, `queries/operational-menu.ts`, `queries/order-menu-facts.ts`, `services/price-period-service.ts`, `services/pricing-service.ts`, `services/selection-service.ts`, `services/nutrition-quote-service.ts`, `validators/menu-validators.ts`.
- Orders and SEND: `orders/services/draft-item-service.ts`, `orders/queries/demand-history.ts`, `workflows/submit-order/submit-order.ts`.
- Scheduling: `rules/demand-forecast.ts`, `services/forecast-service.ts`.
- Recipes: `rules/nutrition-label.ts`, `queries/nutrition-facts.ts`, `services/nutrition-service.ts`, `validators/recipe-validators.ts`; `src/shared/nutrition/figures.ts`.
- Reporting: `queries/price-period-report.ts`, `queries/sales-forecast-report.ts`, `queries/sales-journal.ts`, `queries/payroll-hours.ts`, `rules/sales-journal.ts`, `rules/payroll-hours.ts`, `services/export-service.ts`, `services/report-service.ts`, `validators/report-filters.ts`.
- Audit: `auditing/audit-actions.ts`.
- API routes: `api/menu/price-periods/**`, `api/menu/operational`, `api/menu/nutrition-quote`, `api/menu/items/[itemId]/nutrition`, `api/inventory/items/[itemId]/nutrition`, `api/reports/exports/[kind]`.
- UI: `(app)/menu/happy-hour`, `(app)/reports/exports`, `(app)/orders/[orderId]`, `(app)/menu/items/[itemId]`, `(app)/inventory/items/[itemId]`; `components/menu/price-period-editor.tsx`, `components/nutrition/*`, `components/orders/item-nutrition.tsx`, `components/orders/order-workspace.tsx`, `components/reports/export-download.tsx`, `components/app-shell/navigation.ts`, `nav-icons.tsx`.
- Seeds: `scripts/demo-pricing-nutrition.ts`, `scripts/seed-demo.ts`.
- Tests: as listed above, plus `tests/helpers/e2e-phase28.ts`.
- Docs: `README.md` (sections 11, 14, 15, 17, 21, 33, 36, 39), `CLAUDE.md`, `docs/User-Guide.md`, the plan (amendments 1–7), this report.

# Risks

- **Local dev database left with partial validation data.** Running `db:seed:validation` on the dev database (which has six weeks of demo history) failed at the validation burger's SEND. It left validation employees, a published 2030 week, a seated "Phase 13 Validation Diner" party and probably an open dine-in check with an unsent burger. The owner should decide whether to clean these up (cancel the seating and void the check in the app) or reset the database. This is not caused by Phase 28, but it is a gap: the validation and demo seeds don't work together on one database.
- **Happy hour boundary.** An item sent one minute after the period ends gets the regular price (D4); the badge shows the end time.
- **Sales forecast accuracy only for scheduled dates.** It needs a demand forecast that was used (D10).
- **Overlap check is conservative with dates.** Two short date ranges on different weekdays are refused even if their days never meet.
- **Journal on pre-Phase-20 checks.** Items with no category snapshot appear as "Uncategorized". If an old day doesn't balance, the export is refused rather than guessed.

# Remaining issues

- Decide what to do about the partial validation data on the dev database (above).
- A dev-server E2E run wasn't done (advisory; CI mode is the gate).
- The real SMTP and Twilio send remains the owner's manual check (Phase 22 leftover). Table and section configuration still reach boards on the 30-second fallback (Phase 27 D5).

# Next-phase readiness

Phase 28 is complete and validated, apart from the validation-seed gap noted above. No later phase is scheduled. The deferred candidates are FIFO lot costing and guest loyalty (each needs a rule change; plan section 11), plus placement price overrides and a public nutrition menu if wanted. Nothing is committed yet.
