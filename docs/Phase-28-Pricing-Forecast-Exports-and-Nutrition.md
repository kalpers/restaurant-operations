# Phase 28: Happy Hour Pricing, Sales Forecast, Accounting Exports and Nutrition Design and Implementation Plan

## Purpose

Owner request, 2026-11-18: a phase built from the enhancement list's "features that fit the existing design". The owner chose four:

1. **Happy hour / daypart pricing**: prices by time window per location.
2. **Sales forecast in dollars**: expected net sales per day and hour, by the Phase 24 method.
3. **Accounting and payroll exports**: a daily sales and tax journal and an hours-by-employee-and-position file, both CSV. No integration, and no payroll.
4. **Nutrition information**: calories and macros worked out from recipes and modifiers, the same way allergen labels are.

**FIFO lot costing** and **guest loyalty** were on the same list. The owner deferred both, because each would change a rule in the contract. Section 11 explains what each would mean for a later phase.

What already exists (reviewed 2026-11-18):

| Area | What is there | Where |
|---|---|---|
| Prices | Effective-dated `menu_item_prices` (location row wins over the organization default); `resolveMenuItemPrice` is the only lookup; SEND re-resolves at `sentAt` and snapshots `base_price_snapshot` | `src/modules/menu/services/pricing-service.ts`, `rules/price-resolution.ts`, `submit-order.ts` via `getOperationalMenu` |
| Placement price overrides | Deferred since Phase 7 ("a price is resolved only from `menu_item_prices`") | README section 10 (Menu), line ~685 |
| Menu time windows | `menu_availability` (effective instants per menu and location), not times of day | `src/db/schema/menu.ts` |
| Demand forecast | Phase 24 weighted same-weekday average per local hour; counts only, **no money** by Phase 24 D1, "to keep sales figures inside `reports.sales`"; append-only `demand_forecasts` / `demand_forecast_hours` when used | `scheduling/rules/demand-forecast.ts`, `forecast-service.ts`, `orders/queries/demand-history.ts` |
| CSV export | Every report section exports through `exportReportCsv` (needs `reports.export`, audited `reports.exported`) | `reporting/services/report-service.ts`, `rules/csv.ts` |
| Sales and tax figures | Sales summary, by date, tax by category, tax-exempt checks | `reporting/queries/sales-report.ts` |
| Hours | Actual labor: worked, regular and overtime hours per employee (Phase 18/20 daily and weekly overtime) | `reporting/queries/actual-labor-report.ts` |
| Allergen labels | Worked out on read from each line's final ingredients; the review mark keeps an unchecked ingredient from reading as "free" | `recipes/queries/allergen-facts.ts`, `rules/allergen-label.ts`, `menu-item-requirements.ts` (`PortionRequirement` in base units) |

Permissions stay at 149 unless the owner chooses otherwise (D7, D13, D16).

## Decisions for the owner

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D1 | Scope? | **The four features above.** FIFO lot costing and guest loyalty are deferred (section 11). Placement price overrides stay deferred: happy hour covers the common case, which is a different price at certain times. | The four fit the current rules. Placement overrides would need SEND to choose between overlapping placements. Nobody has asked for them. |
| D2 | What is a price period? | **`price_periods` per location**: name, days of the week, local start and end time (the end may be after midnight; the period then belongs to the day it starts), optional order types (`DINE_IN`, `BAR`, `TAKEOUT`; none = all), optional first and last date, active flag, `version`. Times are in the location's time zone (Phase 20). | It matches how managers describe happy hour ("weekdays 4–6, bar only"). A late-night period ("10 pm–1 am") is common, so it has to cross midnight. |
| D3 | What does a period change? | **A fixed price per menu item** (`price_period_items`: period, menu item, price `NUMERIC(12,2)`). Modifier price adjustments are unchanged. Percent-off rules on whole categories are out. | A fixed price is what the menu prints, and it never needs rounding. A percent-off rule would need its own rounding rule and could stack in unclear ways. |
| D4 | Which instant decides? | **The SEND instant**, as today: SEND already re-resolves the price at `sentAt`. Drafts show a preview price with a "Happy hour" badge, and the badge says when the period ends. An item sent after the period ends gets the regular price. A manager who wants to honour the period price records a discount, as today. | One rule for every price, with no new exception. Using "the time the item was added" would let a draft from 5:59 be sent at 9 pm at the happy hour price. |
| D5 | Overlaps and resolution? | **Two active periods at one location may not both price the same item for an order type at the same time.** The service refuses the save under the location's row lock (`PRICE_PERIOD_OVERLAP`). `resolveMenuItemPrice` stays the only lookup. It gains the order type and returns the period price when one applies, otherwise the regular effective-dated price (location, then organization). An item with no regular price in effect is not sellable, even if a period would price it. | A refused overlap keeps the result deterministic and explainable. Requiring a regular price means "86 by expiry" still works. |
| D6 | What is snapshotted? | **On `order_items` at SEND:** `price_period_id`, `price_period_name_snapshot` and `regular_price_snapshot` (the regular price at that instant). `base_price_snapshot` holds the period price. All three are null for items sent outside a period and for items sent before Phase 28. Moves and shares (Phases 17 and 20) carry them unchanged. | Rule 4 and rule 7: reports show what the period gave away without reading the current configuration. |
| D7 | Reports and permissions? | **A "Price periods" section in the Sales area**: per period and business date, the items sold, sales at the period price, their regular value and the difference. Item mix and menu engineering keep using the snapshots, so they already reflect happy hour prices. Periods are edited under `menu.pricing.edit` and viewed under `menu.pricing.view`. Changes are audited (`menu.price-period-created`, `-updated`, `-deactivated`). **No new permission.** | The same people who set prices set happy hour. The difference column answers "what did happy hour cost us". |
| D8 | What is the sales forecast? | **A fifth Phase 24 measure, `NET_SALES`**: net sales (the sales report's `netSales`) of CLOSED checks per business date and local hour opened (the sales-by-hour rule). It uses the same weighted same-weekday average, look-back, minimum and excluded dates. There is no booked-covers floor. Values are money, `NUMERIC(12,2)`. History comes from a new function in `orders/queries/demand-history.ts`. | It is the same method, the same history and the same settings. A past date's history equals the sales-by-hour report, so it can be checked by hand. |
| D9 | Who sees money? | **Only holders of `reports.sales`.** A "Sales forecast" section in the Sales report area shows each of the next 14 days with an hourly table for each date. The Overview dashboard gets a "Forecast net sales today" tile for `reports.sales` holders. The schedule's Forecast panel (`schedule.edit`) stays counts only. The schedule APIs never return `NET_SALES` rows. | This keeps Phase 24 D10 true: schedulers see how busy the restaurant will be, not how much it will take. |
| D10 | Is it stored, and forecast vs actual? | **Shown on read; stored only with the Phase 24 snapshot.** When a demand forecast is stored (apply template or use suggestion), its `NET_SALES` rows are stored with it. A "Sales forecast vs actual" section in the Sales area reads those stored rows and the CLOSED checks only, so it covers only the dates whose forecast was used for scheduling. | Rule 4: an accuracy figure must come from the forecast that was made then. Recomputing it would use today's settings. There is no separate "save" action and no extra table. The trade-off is that accuracy exists only for scheduled dates (see Risks). |
| D11 | What is in the sales journal? | **One CSV, one row per location, business date and line**: `line_type` (`SALES`, `DISCOUNT`, `COMP`, `TAX`, `TENDER`, `TIPS_PAYABLE`, `REFUND`, `TIP_REFUND`, `CASH_OVER_SHORT`), `code` (menu category name snapshot, tax category code, tender type), `debit` and `credit` as decimal strings. Sales come from CLOSED orders (as the sales report); refunds and tip refunds fall on their own business date; cash over/short comes from closed drawer sessions as a balanced pair. **Each date's debits equal its credits**; a test checks this, and the export refuses a date that doesn't balance (`JOURNAL_OUT_OF_BALANCE`). | The bookkeeper maps fixed line codes to their own chart of accounts. Building a chart of accounts here would be the "accounting integration" that README section 39 keeps out. A file that doesn't balance would cause more harm than no file. |
| D12 | What is in the payroll hours file? | **One row per employee, position and overtime week** in the range: employee number, name, position code, regular hours, overtime hours and total hours (decimal strings, two places). It uses the same Phase 18/20 overtime allocation as the actual labor report, so the totals match. Tip columns (finalized pool share, declared cash tips) are included only for holders of `reports.tips` or `tips.manage`. **No rates, wages or pay.** **The export is refused while any time entry in the range is open** (it lists them), and dates whose tips are not finalized are marked in a `tips_finalized` column. | The payroll provider holds the rates. Leaving pay out keeps this an export and not payroll. Refusing open entries follows the tip-finalize rule: a missed clock-out counts zero, which would underpay someone. |
| D13 | Where are the exports, and who may use them? | **A new "Exports" page under Reports** (`/reports/exports`) with both files, a location and date range, and "All my locations" (adds a `location_code` column). The journal needs `reports.export` + `reports.sales` + `reports.settlements`. The payroll file needs `reports.export` + `reports.labor`. Both are audited as `reports.exported` with the file kind and a row count. **No new permission.** | They use the existing permissions for the same figures. A separate `reports.accounting` permission could be added later if the owner wants one person limited to exports. |
| D14 | Nutrition facts per ingredient? | **`inventory_item_nutrition`, one current row per item**: a basis quantity in the item's base unit (default 100 g, 100 ml or 1 each), with calories, total fat, saturated fat, carbohydrate, sugars, fibre and protein in grams and sodium in mg, all `NUMERIC(14,4)` and nullable. Each row has a `version`; edits are audited, with field names only. Edited under `recipes.edit`. | These are the US label core figures. Storing per base-unit basis means the existing unit conversion (`PortionRequirement` in base units) gives the amounts. |
| D15 | How is an item's nutrition worked out? | **On read, from the current recipe's portion requirements after the chosen modifiers' ingredient effects**, as allergen labels are. A figure is **incomplete** if any ingredient with a quantity has no value for it; it is then shown as "incomplete (N ingredients have no data)" and never as a complete number. **Declared nutrition** per menu item (`menu_item_nutrition`) replaces the calculation, for bought-in items with no recipe. Display rounding follows the FDA rounding rules, and stored values stay exact. **No SEND snapshot.** | One rule, used by every screen. A missing value must never read as zero, just as an unreviewed allergen never reads as "free". Nutrition doesn't affect money, stock or the kitchen, so no historical fact depends on it (it differs from allergens, which SEND checks). |
| D16 | Where is nutrition shown? | **On the menu item page** (all figures, with which ingredients are missing) and **in the order screen's item dialog** (calories for the chosen combination, with the other figures in a "Nutrition" disclosure). Not on the public booking page and no printed menu. Viewing needs `menu.view`. **No new permission.** | Staff answer guests' questions at the table. A public menu page would be a new public endpoint (Phase 22 rules), so it is left for a later phase if wanted. |
| D17 | Seeds and leftovers? | **The demo seed** gets a weekday 16:00–18:00 BAR happy hour at MAIN, with a few drinks repriced, and nutrition facts for the demo ingredients (idempotent, local dev DB only). The validation fixture is unchanged. The Phase 27 leftovers stay as decided there: table/section configuration reaches boards on the 30-second fallback, and the real SMTP/Twilio send is the owner's manual check. | The demo shows each feature. Nothing in the Phase 27 leftovers is new work. |

## Approved Phase 28 Policies

Approved by the owner on 2026-11-18: D1–D17 as recommended. FIFO lot costing and guest loyalty stay deferred (section 11); the "latest cost" and cost-change alert alternatives were offered and not added. These are binding.

1. **Scope (D1).** Price periods, the `NET_SALES` forecast, the sales journal and payroll hours exports, and nutrition. Placement price overrides, percent-off rules, FIFO costing and loyalty stay out.
2. **Price periods (D2, D3).** `price_periods` per location: name, days of the week, local start and end time (may cross midnight, belonging to the start day), optional order types, optional first and last date, active, `version`. `price_period_items` gives a fixed `NUMERIC(12,2)` price per menu item. Modifier adjustments are unchanged.
3. **Instant and resolution (D4, D5).** The SEND instant decides; drafts preview with a badge showing the period's end. Overlapping active periods pricing the same item for the same order type are refused (`PRICE_PERIOD_OVERLAP`) under the location lock. `resolveMenuItemPrice` stays the only lookup, takes the order type, and returns the period price only when a regular price is also in effect.
4. **Snapshots (D6).** `order_items.price_period_id`, `price_period_name_snapshot`, `regular_price_snapshot` set at SEND; null outside a period and for older items; carried unchanged by moves and shares.
5. **Price period report and permissions (D7).** "Price periods" section in the Sales area. Edit `menu.pricing.edit`, view `menu.pricing.view`; audited `menu.price-period-created`, `-updated`, `-deactivated`.
6. **Sales forecast (D8, D9).** `NET_SALES` is a fifth Phase 24 measure: CLOSED-check net sales by business date and local hour opened, same method and settings, no booked floor, money values. Visible only with `reports.sales` (Sales forecast section for the next 14 days, dashboard tile); schedule APIs never return it.
7. **Storage and accuracy (D10).** Shown on read; stored only with a Phase 24 demand forecast snapshot. "Sales forecast vs actual" reads stored rows and CLOSED checks only.
8. **Sales journal (D11).** One row per location, business date and line (`SALES`, `DISCOUNT`, `COMP`, `TAX`, `TENDER`, `TIPS_PAYABLE`, `REFUND`, `TIP_REFUND`, `CASH_OVER_SHORT`) with code, debit, credit. Each date balances or the export is refused (`JOURNAL_OUT_OF_BALANCE`).
9. **Payroll hours (D12).** One row per employee, position and overtime week: regular, overtime and total hours, matching the actual labor report. Tip columns only with `reports.tips` or `tips.manage`. No rates, wages or pay. Refused while any time entry in the range is open; `tips_finalized` column.
10. **Exports page (D13).** `/reports/exports`; journal needs `reports.export` + `reports.sales` + `reports.settlements`; payroll needs `reports.export` + `reports.labor`; "All my locations" adds `location_code`; audited `reports.exported`.
11. **Nutrition facts (D14).** `inventory_item_nutrition`, one current row per item with a base-unit basis and eight nullable `NUMERIC(14,4)` figures, `version`, audited by field name, edited under `recipes.edit`.
12. **Nutrition label (D15, D16).** Worked out on read from the current recipe after modifier effects; a figure with any missing ingredient value is incomplete, never zero; declared `menu_item_nutrition` replaces the calculation; FDA display rounding; no SEND snapshot. Shown on the menu item page and the order item dialog under `menu.view`.
13. **Seeds and leftovers (D17).** Demo seed gets a weekday 16:00–18:00 BAR happy hour at MAIN and demo ingredient nutrition; validation fixture unchanged.
14. **Boundaries.** One migration (0065), no new permission (149), no change to settlement, inventory, kitchen or tip rules.

## Amendments decided at implementation

Approved by the owner on 2026-11-18 with the execution plan.

1. **Two migrations (policy 14).** The `order_items` freeze trigger names every snapshot column, so the three price-period snapshots need it replaced in a custom migration: `0065` (generated) and `0066` (custom guards), as in every phase since 17.
2. **Included tax in the journal (policy 8).** Line totals contain tax included in the price, which is worked out per tax category, not per menu category. `SALES` lines per menu category are at line totals; one `SALES` debit line with code `TAX_INCLUDED` takes the included tax back out; `TAX` credits per tax category carry all tax.
3. **Declared cash tips in the payroll file (policy 9).** Declarations have no position, so an employee's declared tips for the week go on their row with the most hours that week (ties: position code).
4. **Payroll range in whole weeks (policy 9).** The file covers whole overtime weeks (`week_start_day`): a first week and 1–6 weeks. Any other range is refused (`PAYROLL_RANGE_NOT_WHOLE_WEEKS`).
5. **Staffing ratios never use `NET_SALES`.** Ratios keep their own list of the four count measures.
6. **A third migration, `0067` (found during validation).** `0065` gave `price_period_items` → `price_periods` `ON DELETE CASCADE`, which breaks the project rule (checked by `migrations.test.ts`) that every foreign key is RESTRICT. `0065` had already been applied to the local development database, and applied migrations are never edited, so a generated `0067` replaces the key with RESTRICT. Periods are never deleted anyway (`0066`), and the service replaces a period's items explicitly.
7. **Drawer over/short date (policy 8).** The journal places a closed drawer session's variance on the session's business date, as the Settlements report's drawer section does, so the two agree.

## 1. Objectives

The restaurant can run happy hour without manual discounts. Managers see the expected takings for the next two weeks and later how close the forecast was. The bookkeeper and payroll provider each get a CSV they can load without retyping. Staff can answer a guest's calorie question from the order screen.

## 2. Scope Boundary

In: price periods, their resolution at SEND, snapshots and report section; the `NET_SALES` forecast measure, Sales forecast and forecast-vs-actual sections, and the dashboard tile; the Exports page with the sales journal and payroll hours CSVs; ingredient and declared item nutrition, the worked-out label, and the menu item and order screen displays; migrations, tests, the demo seed and documentation for these.

Out: FIFO lot costing and guest loyalty (section 11); placement price overrides; percent-off category rules; a chart of accounts or any accounting or payroll integration; wages or pay in any export; a public menu or nutrition page; nutrition snapshots at SEND; any change to settlement, inventory, kitchen or tip rules; cloud deployment.

## 3. Review Existing Foundation Before Changes

- `menu/services/pricing-service.ts`, `menu/rules/price-resolution.ts` (and its tests), `selection-service.ts` (`priceProspectiveItem`), `queries/operational-menu.ts`, and `workflows/submit-order/submit-order.ts`, where the price is resolved at `sentAt`.
- `orders/services/draft-item-service.ts` (preview prices), the move/share workflows (`move-order-items`, `split-order-item`) that copy snapshots.
- `shared/time/business-date-service.ts` and the Phase 20 location time zone helpers, for local day and time.
- `scheduling/rules/demand-forecast.ts`, `forecast-service.ts`, `orders/queries/demand-history.ts`, `reporting/queries/forecast-report.ts`, and the `DEMAND_MEASURE_SQL` check on `demand_forecast_hours`.
- `reporting/queries/sales-report.ts` (net sales, tax by category), `settlement-report.ts` (tenders, tips, refunds, drawers), `actual-labor-report.ts` (overtime allocation), `tips-report.ts`, `reporting/rules/csv.ts`, `services/cross-location-service.ts`.
- `recipes/queries/allergen-facts.ts`, `menu-item-requirements.ts`, `rules/allergen-label.ts`, the menu item page and the order screen's item dialog.

## 4. Build Order

1. **Migration 0065** (generated and reviewed): `price_periods`, `price_period_items`; the three `order_items` snapshot columns; `NET_SALES` added to the demand-measure check (and money-sized values for it); `inventory_item_nutrition`, `menu_item_nutrition`.
2. **Price periods**: pure rules (does a period apply at an instant in a time zone, across midnight; overlap check), service and API under `menu.pricing.*`, audit; `resolveMenuItemPrice` with order type; SEND snapshots; draft badge; management screen on the item pricing page.
3. **Price periods report section** (D7).
4. **Sales forecast**: the net-sales history query, the `NET_SALES` measure in the Phase 24 rules and snapshot, schedule APIs filtering it out, the Sales forecast and forecast-vs-actual sections, and the dashboard tile.
5. **Exports**: journal and payroll builders as pure row builders plus queries in Reporting, the balance and open-entry checks, the Exports page and route, and audit.
6. **Nutrition**: pure label rule (sum, incomplete fields, FDA display rounding), facts queries beside the allergen ones, ingredient and declared editing, menu item page and order dialog.
7. Demo seed (D17).
8. Tests (sections 5–7), docs (section 8), validation (section 9), completion report.

## 5. Unit Tests

- Price period applies: weekday and time in the location's time zone; end after midnight belongs to the start day; first/last date; order type filter; daylight-saving change days.
- Overlap detection between two periods (days, times, order types, dates).
- `resolvePrice` with periods: period wins inside the window, regular price outside, no regular price means no price.
- Forecast rules with `NET_SALES`: money averaging to two places, no booked floor, minimum-history rule unchanged for the count measures.
- Journal row builder: each date balances; refunds and tip refunds fall on their own date; cash over/short pair; codes stable.
- Payroll row builder: regular + overtime = total; daily-then-weekly overtime matches the labor rules; tip columns present only when allowed.
- Nutrition label: per-portion sums from base quantities; modifier add/remove/substitute; a missing value makes only that figure incomplete; declared values replace the calculation; FDA display rounding.

## 6. Integration Tests

- **Canonical Bacon Cheeseburger** passes unchanged (no period applies). A variant at happy hour: SEND snapshots the period price, `regular_price_snapshot` and the period name; the idempotent retry adds nothing.
- Sending after the period's end gets the regular price; a draft added during the period and sent after it gets the regular price.
- Overlap refused with `PRICE_PERIOD_OVERLAP`; editing a period with a stale `version` gives a conflict; changes are audited.
- Moving and sharing a period-priced item keep its snapshots.
- Price periods section totals equal the snapshots.
- `NET_SALES` history for a past date equals the sales-by-hour report; storing a demand forecast stores the `NET_SALES` rows; schedule APIs never return them; a user without `reports.sales` can't see the forecast sections or tile.
- Journal: debits equal credits per date on a fixture with discounts, comps, included and added tax, an exemption, split tenders, tips, a refund and a tip refund, and a drawer variance; tenders total CLOSED `total_due` plus tips.
- Payroll: hours match the actual labor report; refused while a time entry in the range is open; tip columns hidden without `reports.tips`/`tips.manage`; no wage or rate appears in any column.
- Exports need `reports.export` plus the area permissions; each is audited as `reports.exported`; "All my locations" adds `location_code` and covers only locations the actor holds the permissions at.
- Nutrition: a menu item with a full recipe and facts gives exact sums; missing facts mark the figure incomplete; declared values win; the order dialog's figures for a modifier combination equal the rule.

## 7. E2E Tests (Playwright)

- A manager creates a BAR happy hour that is in effect now. A bartender adds a priced drink and sees the badge and the period price, sends it, and the check shows the period price.
- The Sales report shows the Price periods and Sales forecast sections; exporting the forecast CSV works.
- The Exports page downloads a journal and a payroll file; the payroll export shows the open-entry refusal when a time entry is open.
- A manager enters nutrition for ingredients; the menu item page shows the label; the order dialog shows calories for a chosen modifier combination.

## 8. Documentation

- README: Menu (price periods, placement overrides still deferred), Orders (period snapshots at SEND), Scheduling (the `NET_SALES` measure and its visibility), Reporting (new sections, Exports page, journal and payroll formats), Recipes (nutrition), section 39 (the light accounting export is built; integrations, payroll processing, loyalty stay future), and Phase 28 entries in sections 33 and 36.
- CLAUDE.md: add Phase 28 to the phase list, and short policy lines for price periods, the sales forecast, exports and nutrition.
- `docs/User-Guide.md`: happy hour, exports and nutrition steps.
- `docs/Phase-28-Completion-Report.md`.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first); a dev-server run is advisory
- [ ] `npm run build`, with no new warnings
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] Migration 0065 generated and reviewed; `npm run db:generate` then reports no changes; migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants (149); `db:seed:validation` and `db:seed:demo` twice create no duplicates
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] Canonical Bacon Cheeseburger, including the idempotent retry, passes unchanged
- [ ] Every journal date balances; no export contains a wage, rate, contact detail or note

## 10. Risks

- **Happy hour at the boundary.** An item sent one minute after the period ends gets the regular price (D4). The badge's end time and the manager discount cover it, but staff need to know this.
- **Forecast accuracy only for scheduled dates (D10).** If a location never uses the schedule forecast, the sales accuracy section stays empty. A separate "save sales forecast" action could be added later.
- **Journal balance on old checks.** Included tax and order-level discounts are recorded per order, not per category. Where they can't be split, the journal uses one total line so the date still balances. Checks from before Phase 20 have no category snapshot and report as "Uncategorized".
- **Nutrition accuracy.** Figures are only as good as the facts entered. The label says "calculated from recipes" and shows which data is missing.

## 11. Deferred: FIFO Lot Costing and Guest Loyalty

The owner deferred both on 2026-11-18. Each needs a rule changed in `CLAUDE.md` and README before any work starts, so each would be its own later phase, planned like this one.

### FIFO lot costing

**Today:** Phase 23 lots track quantity and expiry, and SEND takes stock first-to-expire-first-out. **Cost stays weighted average**: one moving average cost per item and location, used for every unit no matter which lot it came from (CLAUDE.md "Lots (Phase 23)").

**What it would mean:** each lot keeps the unit cost it was received at, and a removal is costed from the lots it actually took. A plate's food cost would then come from the delivery its ingredients came from, not an average.

**What it would change:**
- The rule "cost stays weighted average" in CLAUDE.md and README would have to change, with a choice of method per item, per location or organization-wide.
- Lot movements and consumption snapshots would carry each lot's cost. The posting service would cost each removal across lots, including at SEND, on voids that restore stock, on counts and on waste.
- Transfers would carry lot costs from one location to the other. Items without lots would still need weighted average, so two methods would live side by side.
- Inventory valuation, food cost, menu engineering and the purchasing reports would change from the switch-over date. **Past costs are never recalculated** (rule 4), so reports would show a break in method on that date, and opening lots would need a starting cost.
- **Size:** large. It touches the inventory ledger, the most heavily tested part of the system.

### Guest loyalty

**Today:** Phase 21 guest profiles exist, and visit history is worked out from linked parties. The contract says **"No loyalty, marketing consent or guest messaging"**. Phase 22 allowed service messages only, and README section 39 lists loyalty as a future capability.

**What it would mean:** a profile earns visits or points from CLOSED checks linked to it, and reaches perks (for example "free dessert after 10 visits") that staff redeem on a check.

**What it would change:**
- The rule against loyalty would have to be lifted. **Marketing consent and marketing messages could stay banned**; loyalty can work without them.
- An append-only loyalty ledger per profile (earned, redeemed, adjusted, expired) would be needed. Redemption would be recorded as a discount or comp on the check through the existing discount rules, so settlement and tax stay unchanged.
- Earning depends on the profile link, which is made by hand and never automatically (Phase 21). Linking late, unlinking, voids and refunds would each need a rule.
- Merge would combine ledgers, and is never undone. Erase would remove the balance with the personal data while keeping the orders.
- New permissions would be needed to adjust balances, plus audit rules and possibly a guest-facing balance on the private manage link, which would mean new public endpoint rules.
- **Size:** medium. Most of the work is deciding the rules, not building them.

## 12. Required Phase 28 Completion Report

Write `docs/Phase-28-Completion-Report.md`:

```text
PHASE 28 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Price periods (model, instant, overlaps, snapshots, report):
- Sales forecast (measure, visibility, storage, forecast vs actual):
- Sales journal (lines, balance rule):
- Payroll hours file (rows, overtime, tips, open-entry refusal):
- Nutrition (facts, worked-out label, incomplete figures, declared values, display):
- Permissions, audit and boundaries:

Results
- Happy hour price applies at SEND inside the window only, snapshotted: PASS / FAIL
- Sales forecast visible only with reports.sales; stored with the demand forecast: PASS / FAIL
- Every journal date balances; payroll hours equal the labor report: PASS / FAIL
- No wage, rate, contact detail or note in any export: PASS / FAIL
- Nutrition label equals the rule; missing data never reads as zero: PASS / FAIL
- Canonical Bacon Cheeseburger and idempotent retry unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e CI and dev, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
