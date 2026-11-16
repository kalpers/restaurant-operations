# Phase 25: Prep and Purchasing Forecast Design and Implementation Plan

## Purpose

Phase 25 carries the Phase 24 demand forecast past staffing, into the kitchen and purchasing. README section 39 lists "forecasting sales, prep or purchasing" as remaining future work; the owner chose prep and purchasing on 2026-11-16.

- **Item forecast.** For each menu item and business date, the expected portions sold, from the same weekday in recent weeks of closed checks, by the Phase 24 method and settings.
- **Ingredient forecast.** Expected portions × what one portion takes: the recipe in effect on that date, plus the modifiers guests usually choose.
- **Prep lists.** Per prep station and business date, the items expected and the ingredients they take, for the kitchen to print or read.
- **Forecast-based suggested orders.** The Phase 19 suggested orders gain a "from the forecast" basis: what the coming days will use, plus the reorder level as a safety floor, minus what is on hand and on order. Creating them still makes DRAFTs only.
- **Forecast vs actual.** For dates whose forecast was used to order, expected and actual portions per item.
- **Leftovers.** The two dev-server E2E flakes Phase 24 left open, and the unused Docker volumes.

Left out on purpose:

- forecasting money (sales amounts, food cost, budgets)
- prep recipes / sub-recipes (batches of sauce or dough as their own stocked items): recipes today hold only menu items' ingredients, and there is no prepared-stock concept
- prep task tracking (who prepped what, done ticks, holding times): prep lists are read-only
- supplier lead times, delivery days or order schedules (the manager chooses how far ahead to order each time)
- submitting purchase orders automatically, or creating them on a timer
- machine learning, external data, any new dependency
- loyalty, delivery, accounting, payroll, cloud deployment (on hold)

What exists today (checked against the code on 2026-11-16):

- **Phase 24 forecast.** Pure rules in `src/modules/scheduling/rules/demand-forecast.ts` (`selectHistoryDates`, integer `weightedAverage`, `forecastDate`, headcount); settings `forecast_lookback_weeks` and `forecast_minimum_samples` on `scheduling_rules`; `demand_excluded_dates` per location; `getDemandHistory` in `orders/queries/demand-history.ts` (closed checks by business date and local hour). Counts only.
- **Items sold.** `order_items` hold `quantity` (integer), menu item code and name snapshots, `recipe_version_id`, `prep_station_ids_snapshot`, status (`SUBMITTED`, `SPLIT` count as sold; the item-mix report uses that rule on CLOSED checks). Chosen modifiers are in `order_item_modifiers`. Consumption at SEND is in `order_item_inventory_consumption` (base quantity per line and ingredient, with the per-unit requirement and modifier effects in `source_snapshot`).
- **Recipes.** One recipe per menu item, effective-dated immutable revisions with a yield; `recipe_version_ingredients` per revision; `modifier_inventory_effects` (ADD / REMOVE / ADJUST per modifier and menu item); `modifier-recipe-effects.ts` resolves a chosen set of modifiers against a revision; unit conversion rules exist. No sub-recipes or prepared items.
- **Stations.** `prep_stations` per location (KITCHEN, BAR, EXPO) and `menu_item_prep_routing` (an item can route to several).
- **Purchasing.** `suggested-order-service.ts` (Phase 19): per stocked item, the Phase 8 par rule (`evaluateStock`: at or below reorder level → up to reorder target or par) minus outstanding open-PO quantity, as whole purchase units of the preferred supplier item, grouped by supplier; `createSuggestedOrders` makes one DRAFT per supplier, idempotent under `purchasing.suggest`, audited. Suppliers have no lead time or delivery days.
- **Module dependencies.** Inventory imports only Auth and Auditing; Recipes and Menu import Inventory; Orders imports Menu and Recipes; Scheduling imports Orders. So Inventory can't read orders, recipes or scheduling without a cycle; cross-domain orchestration goes in `src/workflows/`.
- **Permissions.** 149. Relevant: `kitchen.view`, `purchasing.manage`, `inventory.cost.view`, `reports.inventory`, `schedule.rules.manage`.
- **Leftovers.** Dev-server E2E: `settlements.spec.ts` dine-in "Complete session" clicks lost before hydration; `online-booking.spec.ts` computes "tomorrow" at each use, so a run crossing midnight changes the date mid-file. Docker has 16 unnamed volumes.

It changes these written contract points, which the owner approves with this plan:

- **README section 16 (Inventory):** suggested orders gain the forecast basis; new tables `purchasing_forecasts`, `purchasing_forecast_items`, `purchasing_forecast_lines`; `purchase_orders.purchasing_forecast_id`.
- **README section 18 (Kitchen):** a read-only prep list per station.
- **README section 11:** the Phase 24 look-back settings and excluded dates also drive the item forecast.
- **README section 21:** the Inventory area gains "Item forecast vs actual".
- **README section 39:** forecasting prep and purchasing is built (money stays future work).
- **Phase 19 plan:** an amendment noting the forecast basis was added in Phase 25.
- **CLAUDE.md:** the Phase 25 line and a short policy under "Inventory".

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially sections 11, 14–18 and 21, and the Phase 8, 19 and 24 notes in section 33.
2. Read the Phase 7, 8, 19 and 24 plans and completion reports. Phase 24 is the model for the forecast and its snapshots; Phase 19 for suggested orders.
3. Read `docs/accepted-risks.md`. No new dependency is planned.

## Decisions for the owner

Approved by the owner on 2026-11-16 as recommended. The policies below follow them.

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | What is forecast for items? | **Portions per menu item per business date** at the location, from CLOSED checks, items `SUBMITTED` or `SPLIT` (the item-mix rule; voided and draft items left out; a split item counts once). The Phase 24 method: same weekday, weighted 6…1, the location's `forecast_lookback_weeks` and `forecast_minimum_samples`, its excluded dates, at most 12 weeks back, fewer usable dates than the minimum → `NOT_ENOUGH_HISTORY`. A usable date on which an item didn't sell counts as **zero** for it. Daily totals only, no hours. Results two-decimal strings. | Same method managers already trust and tune for staffing; one settings place. Prep and ordering are planned by the day, not the hour. Zero for "not sold that day" is correct for an item on the menu, and a new item is flagged (D3). |
| D2 | How do reservations count? | **They don't.** Items forecast from history only. | Booked covers raise staffing in Phase 24 because a party needs a server; turning covers into burgers would be a guess. History already includes the usual bookings. |
| D3 | Which items? | Items **active at the location's operational menu** on the forecast date's start (in catalog, placed on a menu at the location; `available` and 86 state ignored, since an 86 today says nothing about next Tuesday). An item whose first sale at the location is after the oldest sample date is flagged **`NEW_ITEM`** (forecast shown, with the warning that early zeros pull it down). Items with history but no longer on the menu are left out. | The forecast should list what can be sold, not what used to be. |
| D4 | How do portions become ingredients? | **Recipe in effect on that date, plus the usual modifiers.** Per portion: the recipe revision effective at the date's start ÷ its yield, in base units. Then for each modifier with an inventory effect on that item: its **share of portions** in the sample dates (weighted like the forecast) × its **current** effect (resolved by the existing modifier rule against the same revision, one modifier at a time). An item with no published recipe takes no ingredients and is listed as `NO_RECIPE`. Remakes and waste are left out. | Future use follows today's recipe (a changed recipe changes the need at once); how often guests ask for extra pickles is a fact of history. Taking the frequency from history and the effect from current config keeps rule 4 honest: no history is recalculated, and nothing future is guessed from an old recipe. Modifier interactions are ignored (one at a time), a small, stated approximation. |
| D5 | Prep lists? | **Per prep station and business date, read-only, worked out when opened, never stored.** For a KITCHEN or BAR station, each item routed to it at the location (current routing; an item on several stations appears on each): forecast portions **rounded up to whole portions**, the usual modifiers as "about N with Extra Pickles" (rounded), and the ingredients those portions take (base units, 4 places, also shown in the item's count unit where a conversion exists). Today, the list shows the forecast **minus portions already sold today** (not below zero). Dates: today's business date and the next 6. Page: Kitchen → Prep list, under `kitchen.view` at the location. Counts only. | Cooks need "how many burgers and how much ground beef", per station. Nothing operational rests on a prep list, so storing it adds rows without a reason (purchasing forecasts are stored, D7). |
| D6 | Forecast-based suggested orders? | **A second basis on the Suggested orders page: "From the forecast through {date}"** (the manager picks a date, from tomorrow to 14 days ahead, default 7). Per stocked item: **need = forecast usage from now through that date + the reorder level − on hand − on order**, if positive, as whole purchase units of the preferred supplier item (the Phase 19 rounding and grouping). Forecast usage for today is today's remaining forecast (D5). An item no forecast uses (no recipe links it, or every item using it is `NOT_ENOUGH_HISTORY` or `NO_RECIPE`) **falls back to the par rule**, labelled "par". Each line shows forecast usage, on hand, on order, the reorder floor and which basis it used. The par-only basis stays the default and unchanged. | Par levels are a fixed guess; the forecast says what the next days will actually use. The reorder level already means "don't fall below this", so it is the natural safety floor without a new setting. Without supplier lead times, the manager's "through date" is the honest input. Falling back per item means cleaning supplies and new items still get ordered. |
| D7 | Is the purchasing forecast stored? | **Yes, append-only, when drafts are created from it** (preview stores nothing). `purchasing_forecasts` (location, user, time, through date, method JSONB: settings, sample dates per date, excluded dates applied, recipe revision per item, modifier shares), `purchasing_forecast_items` (date, menu item, forecast portions, status), `purchasing_forecast_lines` (inventory item, forecast usage, reorder floor, on hand, on order, need, basis `FORECAST`/`PAR`). Each DRAFT made from it records `purchase_orders.purchasing_forecast_id`. Written in the same transaction as the drafts. Append-only by trigger. | Rule 4 and the Phase 24 pattern: why a draft ordered 40 lb of beef must stay readable after more history, a recipe change or a count. It also gives D8 the forecast that was used. |
| D8 | Forecast vs actual? | **"Item forecast vs actual" in the Inventory report area** (`reports.inventory`): for each past business date in range with a stored purchasing forecast (the latest one that covered the date), per menu item the forecast and actual portions (the D1 rule), the difference and percentage. CSV export. "All my locations" shows per-location totals. No ingredient-level comparison (actual ingredient use includes waste, remakes and counts). | Tells purchasing whether to trust the basis. Item level is what the forecast predicts directly. |
| D9 | Where does the code live? | **Pure rules in `src/shared/forecasting/`**: `selectHistoryDates` and the weighted average move there from Scheduling (Scheduling re-imports them, behaviour unchanged) and gain a decimal weighted average; item and ingredient rules in `src/shared/forecasting/item-forecast.ts`. **Read queries in the owning modules**: `orders/queries/item-sales-history.ts` (portions and modifier choices per item and date), `recipes/queries/forecast-requirements.ts` (revision per item and date, per-portion requirements, modifier deltas), `menu/queries/forecast-menu.ts` (items on the menu, station routing), `scheduling/queries/forecast-settings.ts` (look-back, minimum, excluded dates). **Orchestration in `src/workflows/forecast-items/`** (item and ingredient forecast, prep list). **Inventory** owns the snapshot tables and `createForecastSuggestedOrders`, which receives the forecast usage per inventory item from the workflow, never reading other domains itself. | Inventory, Recipes, Menu, Orders and Scheduling can't import each other in a circle (the cycle is real: Scheduling→Orders→Menu→Inventory). Sharing the pure rules keeps one forecasting method. This is the substantial cross-domain orchestration `src/workflows/` exists for. |
| D10 | Permissions? | **No new permission; the count stays 149.** Prep list: `kitchen.view`. Forecast suggestions preview and create: `purchasing.manage`; estimated costs only with `inventory.cost.view` (as Phase 19). Report: `reports.inventory`. The look-back settings and excluded dates stay under `schedule.rules.manage`. | The people who see station tickets can see expected portions; the people who make draft POs can make these. |
| D11 | History for demo and tests? | **Tests:** the Phase 24 fake-clock fixture, extended to sell recipe items with modifiers. **Demo seed:** adds 6 weeks of history at `MAIN` selling three existing demo items that have recipes and modifiers (for example the Bacon Cheeseburger with its usual modifiers), through the real SEND, with a matching demo receipt posted first so balances stay positive. Local dev DB only, idempotent, skipping dates already done. | The Phase 24 demo history sells a plate with no recipe, so prep and purchasing would show nothing. Going through SEND keeps the ledger, consumption snapshots and balances consistent. |
| D12 | Leftovers? | **First build step.** (a) `settlements.spec.ts`: a test helper that clicks and retries until the expected result shows (the Phase 24 forecast-test pattern), used on both "Complete session" clicks. (b) `online-booking.spec.ts`: one booking date computed once at file load, **two days ahead** in the location's zone (inside the 30-day window, past the 2-hour lead), so midnight can't move it. (c) Then the full E2E suite twice against `npm run dev` with no re-run. (d) **Docker volumes:** list the unnamed volumes with whether a container uses them; the owner confirms before any is deleted. Not a code change; recorded in the report. | (a) and (b) are what the Phase 24 report offered; the owner chose fixing them. (d) was offered earlier and accepted. |

## Approved Phase 25 Policies

Binding since the owner approved D1–D12 on 2026-11-16. Numbers are for reference in the build and the report.

### A. Item forecast

1. **Shared rules (D9).** `src/shared/forecasting/history-dates.ts` holds `selectHistoryDates` and `weightedAverage` (integers in, two-place string out), moved unchanged from Scheduling; Scheduling imports them from there and every Phase 24 test passes unchanged. A `weightedAverageDecimal` takes decimal strings (for modifier shares) and uses decimal arithmetic only.
2. **Item history (D1).** `getItemSalesHistory(executor, { locationId, fromDate, toDate })` in `orders/queries/item-sales-history.ts`: per business date and menu item, portions sold (sum of `quantity` of `SUBMITTED`/`SPLIT` items on CLOSED orders at the location), and per modifier chosen on those items the portions that carried it; plus the dates with at least one closed check and each item's first sale date. Its portions for a date equal the item-mix report's quantities for that date (tested).
3. **Item rule (D1, D3).** Pure: for a target date, the Phase 24 history dates (same settings and excluded dates); per item on the menu, the weighted average of its portions on those dates (zero where it didn't sell); `NOT_ENOUGH_HISTORY` below the minimum; `NEW_ITEM` when its first sale is after the oldest sample date. Target dates from today's business date to 14 days ahead.
4. **Menu (D3).** `getForecastMenu(executor, { locationId, at })` in `menu/queries/forecast-menu.ts`: active items placed on an active menu at the location at that instant, with their current station routing. Availability and 86 state are ignored.

### B. Ingredients

5. **Requirements (D4).** `getForecastRequirements(executor, { menuItemIds, at })` in `recipes/queries/forecast-requirements.ts`: per item the revision effective at that instant, its per-portion requirements in base units (requirement ÷ yield, via the existing conversion rules), and per modifier with an effect on the item the per-portion delta (resolved with that modifier alone minus without it). `NO_RECIPE` when no revision is effective.
6. **Modifier shares (D4).** Per item and modifier, the weighted average of (portions with that modifier ÷ portions of the item) over the sample dates, decimal, 4 places; dates where the item didn't sell are skipped for its shares.
7. **Ingredient rule.** Per date and inventory item: Σ over items of forecast portions × (per-portion requirement + Σ modifier share × delta), 4 places, never below zero per item. Decimal arithmetic only.
8. **Today.** For today's business date, portions = max(forecast − portions already sold today on any non-voided sent item, 0).

### C. Prep lists (D5)

9. **Query.** `GET /api/kitchen/prep-list?date=&stationId=` (`kitchen.view`, actor's location): per station of type KITCHEN or BAR, per item routed to it, forecast portions rounded up to whole portions, the usual modifiers with rounded counts (shown when at least 1), and the ingredients; per date the status and sample dates. Stores nothing.
10. **Page.** Kitchen → Prep list: date picker (today to +6), station tabs, a print-friendly layout. Items with `NOT_ENOUGH_HISTORY` are listed with no number and the reason; `NO_RECIPE` items show portions without ingredients.

### D. Forecast-based suggested orders (D6, D7)

11. **Preview.** `GET /api/purchasing/suggested-orders?basis=forecast&through=` (`purchasing.manage`): the Phase 19 shape plus per line `basis` (`FORECAST` or `PAR`), `forecastUsageBaseQuantity`, `reorderFloor`; per date the forecast status. `basis=par` (default) is the Phase 19 response, unchanged.
12. **Need rule (pure, in Inventory).** For a stocked item with forecast usage: need = usage + (reorder level or 0) − on hand − outstanding; positive need → whole purchase units, rounded up, from the preferred supplier item (existing rule); no preferred supplier → "without supplier" as today. An item with no forecast usage uses the Phase 19 par rule.
13. **Create.** `POST /api/purchasing/suggested-orders` with `{ basis: "forecast", through, idempotencyKey }`: in one transaction, under the existing location lock and idempotency scope, compute again, store the `purchasing_forecasts` snapshot with its items and lines, create one DRAFT per supplier (notes "Suggested from the forecast through {date}.") with `purchasing_forecast_id` set, and audit `purchasing.suggested-orders-created` with the basis, through date and counts. A retry with the key returns the first result. Nothing is submitted; no stock moves.
14. **Snapshot.** `purchasing_forecasts`, `purchasing_forecast_items`, `purchasing_forecast_lines` are append-only (update and delete refused by a trigger). Quantities `NUMERIC(14,4)`, portions `NUMERIC(14,2)`.

### E. Report (D8)

15. **Item forecast vs actual** in the Inventory area (`reports.inventory`): for each business date in range before today covered by a stored purchasing forecast (the latest), per item forecast and actual portions, difference and percentage (decimal strings). Actuals from `getItemSalesHistory`. Cross-location view: totals per location. CSV export. Read-only.

### F. Leftovers (D12)

16. **E2E helper.** `clickUntilShown(locator, expectation, { attempts })` in the E2E helpers; the two settlements clicks use it. No suite-wide timeout changes.
17. **Booking date.** `online-booking.spec.ts` computes one booking date at load, two days ahead in `America/Detroit`.
18. **Docker.** Unused volumes listed with sizes; deleted only on the owner's confirmation.

### G. Boundaries

19. The forecast reads closed checks, recipes, menu placement and settings only; it never writes to Orders, Menu, Recipes or Scheduling, and never moves stock.
20. No money in the item forecast, prep list, snapshots, audit rows or outbox payloads; estimated PO costs only as Phase 19 shows them, under `inventory.cost.view`.
21. The canonical Bacon Cheeseburger test, every Phase 19 suggested-order test and every Phase 24 forecast test pass unchanged.

## Amendments decided at implementation

1. **Per portion (D4, policy 5).** SEND takes a recipe revision's ingredient quantities as one portion; it doesn't divide by the yield. The forecast does the same, so a forecast portion takes exactly what a sold one does.
2. **Where the rules live (D9, policy 1).** Only the history-date rules and the weighted averages moved to `src/shared/forecasting/`. The item and ingredient rules use the Recipes modifier rule (`applyModifierEffects`), which `src/shared` may not import, so they are in `src/workflows/forecast-items/item-forecast-rules.ts` with their unit tests.
3. **Modifier effects (policy 5).** Modifier inventory effects are Menu's configuration, so the Menu query `forecast-menu.ts` reads them (with the SEND unit conversion). The revision and its per-portion requirements come from the existing Recipes query `menu-item-requirements.ts`, extended to return the revision, rather than a new file.
4. **Station access (D5, D10).** The kitchen screens already scope stations by type, so the prep list shows KITCHEN stations under `kitchen.view` and BAR stations under `bar.view`. The navigation entry is under `kitchen.view`.
5. **Units (D5).** Inventory items have no separate count unit, so prep-list ingredients are shown in the item's base unit only.
6. **Snapshot tables (policy 14).** `purchasing_forecasts` and `purchasing_forecast_lines` are in the Inventory schema; `purchasing_forecast_items` is in `inventory-links.ts`, the schema file allowed to reference both Menu and Inventory. Lines are stored only for items with a positive need (what was suggested). The generated foreign key to `recipe_versions` reached PostgreSQL's 63-character limit, so it is named and `0063`–`0064` were regenerated before being applied anywhere but throwaway test databases. Modifier shares are stored per date in `method`.
7. **Audit (policy 13).** The `purchasing.suggested-orders-created` allow-list gains `basis`, `throughDate` and `purchasingForecastId`.
8. **Today (policy 8).** "Already sent today" counts items SUBMITTED or SPLIT on any check of today's business date that isn't voided, open checks included.
9. **Demo history (D11).** The demo kitchen items' prices and recipes start the day they were seeded, so SEND rightly refuses them at past times. The seed makes three clearly fake copies ("Demo prep burger", "Demo prep fries", "Demo prep wings") with the clock moved back, using the Phase 24 demo tax category, and sells those. A first, failed run left one empty open check on the local dev database, which was voided through `voidOrder`. The seed now counts only CLOSED checks as done.
10. **E2E (section 7).** `prep-purchasing.spec.ts` covers the prep list and ordering from the forecast. The report needs a stored forecast on a past date, which the app can only make from today onward, so the integration tests cover it. The spec's cleanup disables its accounts only, because its checks made kitchen tickets that the shared order cleanup can't remove; the E2E database is rebuilt each run.
11. **Settlements test limit (policy 16).** With the click helper in place, the dine-in settlements test failed both of the first two dev-server runs on the 30-second test limit, while an assertion was still inside its own 15-second wait. It now has a 90-second limit of its own, as other long dev-mode tests do. No suite-wide timeout changed.

## 1. Objectives

Deliver policies 1–21, the migrations, the tests in sections 5–7, README, CLAUDE.md and User Guide updates, and `docs/Phase-25-Completion-Report.md`.

## 2. Scope Boundary

Out of scope (don't build):

- Forecasting money; sub-recipes or prepared stock; prep task tracking
- Supplier lead times, delivery schedules, automatic submission or timed suggestions
- Hourly item forecasts; booking-based item uplift
- Changing the Phase 24 staffing forecast's behaviour
- Loyalty, delivery, accounting, payroll, cloud deployment (on hold)

## 3. Review Existing Foundation Before Changes

Confirm from code before each step:

- `demand-forecast.ts` and its tests, and every import of `selectHistoryDates`/`weightedAverage`.
- The item-mix query (`SOLD_ITEM_STATUSES`, `closedScope`), for the item history rule.
- `modifier-recipe-effects.ts`, unit conversion, `menu-item-requirements.ts` and `order-consumption.ts`, for per-portion requirements.
- The operational menu and placements, and `menu_item_prep_routing`.
- `suggested-order-service.ts`, `replenishment.ts` and their tests; the Suggested orders page.
- The kitchen pages and navigation, for the Prep list page.
- `BusinessDateService` and location time zones.

If any conflicts with the policies, stop and explain before changing it.

## 4. Build Order

Migrations start at 0063. Each step generates its own migration (plus a custom one for triggers), reviewed before applying, and leaves lint, typecheck, unit and integration tests green.

1. **Leftovers:** E2E click helper and booking date (policies 16–17); list Docker volumes for the owner (policy 18).
2. **Shared forecasting rules:** move and re-import, Phase 24 tests unchanged; decimal weighted average (policy 1).
3. **Read queries:** item sales history with the item-mix equality test, forecast menu, forecast requirements, forecast settings (policies 2, 4, 5).
4. **Item and ingredient rules** (pure) and the `forecast-items` workflow (policies 3, 6–8).
5. **Prep list:** route and page (policies 9–10).
6. **Forecast-based suggested orders:** snapshot tables, need rule, preview, create, page (policies 11–14).
7. **Item forecast vs actual report** (policy 15).
8. **Demo seed, E2E, documentation and the completion report** (D11).

## 5. Unit Tests

- *Shared rules:* the moved functions give identical results (Phase 24 tests unchanged); decimal weighted average hand-worked, no floating error.
- *Item rule:* zero for unsold usable dates; excluded and closed dates skipped; not enough history; `NEW_ITEM`.
- *Modifier shares:* weighted per date; dates without the item skipped; four places.
- *Ingredients:* per-portion from yield and unit conversion; ADD, REMOVE and ADJUST deltas; substitution as two deltas; never below zero; `NO_RECIPE`.
- *Today:* remaining forecast never below zero.
- *Need rule:* usage + floor − on hand − on order; negative on hand used as is; whole purchase units rounded up; par fallback when no usage.
- *Prep rounding:* portions up, modifier counts rounded, shown only when at least 1.

## 6. Integration Tests

- **Item history equals item mix** for several dates, including split items (once), voided items and open checks left out.
- **Requirements:** the revision effective at the date (a revision taking effect mid-range changes later dates only); modifier deltas match what SEND consumes for the same choice (Bacon Cheeseburger with No Onion, Extra Pickles, Swiss instead of American).
- **Ingredient forecast:** on fixture history equals the hand-worked figure.
- **Prep list:** per station from routing; an item on two stations appears on both; today minus sold today; stores nothing; `kitchen.view` required at the actor's location.
- **Suggested orders, forecast basis:** preview stores nothing; create stores the snapshot and DRAFTs in one transaction with `purchasing_forecast_id`; a retry with the key creates nothing more; par fallback per item; `basis=par` identical to Phase 19.
- **Snapshot immutability:** update and delete refused; a later recipe or count change doesn't change a stored forecast.
- **Report:** latest stored forecast per date; actuals equal item history; cross-location totals equal per-location runs.
- **Permissions:** every new API refuses without its permission at the actor's location.
- **Boundaries:** no ledger rows, no order or menu writes from forecasting.
- **Canonical scenario** and the Phase 19 and 24 suites unchanged. **Migrations:** reconstruction and upgrade from Phase 24; existing POs have a null forecast column.

## 7. E2E Tests (Playwright)

- **New `prep-purchasing.spec.ts`:** with fixture history, a cook opens the prep list for the grill station and sees burgers with their usual modifiers and ingredients; a purchasing manager previews suggested orders from the forecast through a date, sees forecast and par lines, creates the drafts and opens one; the Inventory report shows item forecast vs actual for a past date.
- **Leftovers:** settlements and online-booking specs as changed.
- **Every existing spec** still passes in CI mode, and twice against `npm run dev` with no re-run.

## 8. Documentation

- **README sections 11, 16, 18, 21 and 39:** the policies as built.
- **README section 33:** a "Phase 25 Prep and Purchasing Forecast" note; **section 36** and the CLAUDE.md phase list: Phase 25, with a short policy in CLAUDE.md.
- **Phase 19 plan:** an amendment noting the forecast basis was added in Phase 25.
- **`docs/User-Guide.md`:** the prep list, suggested orders from the forecast, item forecast vs actual.

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
- [ ] The canonical Bacon Cheeseburger test, Phase 19 suggested orders and Phase 24 forecast tests pass unchanged
- [ ] Item history for a past date equals the item-mix report
- [ ] Forecasting writes no ledger rows; stored forecasts are never updated
- [ ] Unused Docker volumes listed; any deletion confirmed by the owner

## 10. Required Phase 25 Completion Report

Write `docs/Phase-25-Completion-Report.md`:

```text
PHASE 25 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Shared forecasting rules:
- Item forecast (history, menu, new items):
- Ingredients (recipe in effect, modifier shares, today):
- Prep lists:
- Forecast-based suggested orders and snapshots:
- Item forecast vs actual:
- Leftovers (E2E, Docker):
- Permissions, audit and boundaries:

Results
- Item history equals item mix: PASS / FAIL
- Ingredient forecast matches hand-worked values and SEND consumption: PASS / FAIL
- Prep list stores nothing and follows routing: PASS / FAIL
- Forecast suggestions create DRAFTs only, idempotent, with an immutable snapshot: PASS / FAIL
- Phase 19 par basis and Phase 24 forecast unchanged: PASS / FAIL
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
