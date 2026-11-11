# Phase 19 Completion Report: Menu and Stock Signals

```text
PHASE 19 COMPLETION REPORT
```

## Summary

Phase 19 turns stock and sales data the app already records into signals for service, as planned in `docs/Phase-19-Menu-and-Stock-Signals.md` (decisions D1–D10 approved as recommended on 2026-11-11, plus amendments 2–7). Nothing in this phase moves inventory.

- **86 board.** Per-location manual 86 with a reason and restore, read-time portions remaining, opt-in auto-86 from stock, and "sell anyway" for one business date. One sellability check in `getOperationalMenu` serves both draft add and SEND.
- **Low-stock alerts.** Opened and resolved by the posting service when a posting crosses the reorder level, with in-app `INVENTORY_LOW` notifications to purchasing managers at the location.
- **Suggested purchase orders.** DRAFT orders per preferred supplier item, sized to the shortfall minus what is already on order, with idempotent create. They are never submitted.
- **Six report sections** in the existing areas: sales by hour, item mix, menu engineering, server performance, voids/comps/discounts by employee, and 86 history.
- **One new permission** (138 in all), migrations `0037` and `0038`, the validation seed step, and README, CLAUDE.md and User Guide updates.

## Environment

- Node v26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker Compose)
- Windows 11; tests run from PowerShell (Git Bash breaks vitest's config path)
- No dependency added or changed

## Policies (as built)

- **Per-location 86, restore, sell anyway:**
  - `menu_item_outages`: one ACTIVE per item and location (partial unique index). Every 86 needs a reason. Restoring checks `version`, and a second 86 of an item that's already 86'd is refused with `ITEM_ALREADY_86ED`. A trigger refuses deletes and any change once RESTORED.
  - `menu_item_stock_overrides`: one uncleared override per item, location and business date (from `BusinessDateService`). An override lifts only auto-86, and setting one is refused while auto-86 is off (`AUTO_86_DISABLED`).
  - Audited under category `MENU`: `menu.item-marked-out`, `menu.item-restored`, `menu.sell-anyway-set`, `menu.sell-anyway-cleared` and `menu.stock-availability-setting-changed`. Each change emits `menu.availability-changed` through the outbox.
- **Portions remaining and auto-86:**
  - Portions = the lowest `floor(on hand ÷ per-portion requirement)` over the current recipe revision's ingredients. Modifiers are ignored. An ingredient that isn't stocked counts as zero, and an item with no recipe or no ingredients has no figure.
  - Requirements come from `resolveCurrentRequirementsForMenuItems` (Recipes), which uses SEND's conversion and per-portion meaning. A test proves it matches `resolveRevisionRequirements`. On-hand comes from the Inventory read door (`item-facts`).
  - Auto-86 is `location_settings.auto_86_from_stock` (default false), changed through `PATCH /api/menu/stock-settings` under `locations.manage`. It is worked out on every read and never stored.
- **Sellability check (draft add and SEND):** `getOperationalMenu` leaves out items that are 86'd here, or auto-86'd with no override. A draft whose item was 86'd after it was added is refused at SEND with `ITEM_NOT_SELLABLE`, and sent items are never touched.
- **The 86 board:** `/menu/86` shows 86'd now, running low (1–5 portions), sell anyway today, restored today, the 86 form and the auto-86 toggle. Actions show only with the right permission, and every API checks it again. The board refetches on `menu.availability-changed`, on `order.items-submitted`, and every 30 s.
- **The order screen:**
  - It shows "N left" for running-low items and lists what is 86'd at the location.
  - It fetches these figures from `/api/menu/stock-signals` after the page loads, so the order page's own render does no extra work.
  - It refetches them on `menu.availability-changed`, on this check's own changes, and every 60 s.
- **Low-stock alerts and notifications:**
  - `inventory_stock_alerts`: one OPEN per item and location. `postInventoryTransaction` opens one when stock moves from above the reorder level to at or below it, and resolves it on the way back above. This runs in the posting's transaction under the balance lock, and a trigger freezes each alert's facts.
  - `INVENTORY_LOW` notifications go to active users at the location who hold `purchasing.manage` (`findUserIdsHolding`, auth module), plus `notification.created` outbox events. The text has no cost.
  - A rolled-back posting leaves no alert. Changing the reorder level opens or closes nothing until the next posting. `/inventory/low-stock` shows "Alert since".
- **Preferred supplier and suggested POs:**
  - `inventory_item_locations.preferred_supplier_item_id` has a composite FK to a supplier item for the same inventory item and organization, and must be active. It's set on the stocked-item form.
  - Need = Phase 8 suggested quantity − outstanding (DRAFT, SUBMITTED and PARTIALLY_RECEIVED lines less received), rounded up to whole purchase units (`suggestPurchaseLines`).
  - `GET`/`POST /api/purchasing/suggested-orders` need `purchasing.manage`; POST uses idempotency scope `purchasing.suggest`. POST takes an advisory lock per location and creates one DRAFT per supplier through `createPurchaseOrderIn`/`addPurchaseOrderLineIn`, the same rules as Phase 8. It is audited as `purchasing.suggested-orders-created`.
  - Items with no preferred supplier are listed and left off. Cost estimates show only with `inventory.cost.view`.
- **Report additions** (added after each area's existing sections, which are unchanged):
  - Sales by hour: the local hour opened, laid out from the business-day cutoff, all 24 hours.
  - Item mix and menu engineering: across the whole menu (amendment 7). Kasavana–Smith classes, compared by exact cross-multiplication. Engineering is shown only with cost.
  - Server performance: tips column only with `reports.tips` or `tips.manage`.
  - Voids, comps and discounts by the user who did them: facts only, no thresholds.
  - 86 history (Inventory area).

## Results

```text
- 86 at one location leaves others sellable: PASS
- 86'd draft item refused at SEND; sent items untouched: PASS
- Auto-86 only when enabled; sell anyway ends with the business date: PASS
- One alert per crossing; rolled-back posting leaves none: PASS
- Suggested POs are DRAFT, idempotent, no ledger rows: PASS
- Report sections exact; cost and tips hidden without permission: PASS
- Canonical Bacon Cheeseburger unchanged: PASS (tests/integration/orders/submission.test.ts, unchanged)
```

## Architectural decisions

1. **Auto-86 is computed, not stored** (D3). There is no posting hook and no outbox consumer. The figure is always current, and the only stored records are the human ones (outages and overrides).
2. **Module boundaries kept.**
   - Menu reads Inventory only through `item-facts`, where `quantitiesOnHand` and the batched `toItemBaseQuantities` were added, and Recipes through a new `queries/menu-item-requirements.ts`. The existing boundary tests enforce this.
   - Who acted on the 86 board is returned as user IDs and named by the page through `findDisplayNamesByUser` (Employees). That keeps Menu from reading another domain's people.
   - Inventory writes notifications in the posting transaction, as Kitchen already does for ready tickets.
3. **Conversion contexts are batched** (`loadConversionContexts`): units and generic conversions once, plus all items' packaging conversions in one query. The result equals per-item `loadConversionContext`.
4. **Auto-86 setting endpoint.** The plan said the setting would be audited "under the existing location settings permission". The location settings update has no audit, so the setting got its own endpoint, following the Phase 17 tax and drawer settings: permission `locations.manage`, audit `menu.stock-availability-setting-changed`. The audit action format allows no digits, so "auto-86" couldn't appear in the name.
5. **The toggle lives on the 86 board**, not the admin locations page as the execution plan said. It sits where the result is visible, and it is shown only to `locations.manage` holders.
6. **"Server performance" is a new section** next to the unchanged Phase 12 "Closed orders by server", rather than an extension of it, so Phase 12 output and CSVs stay byte-for-byte the same.
7. **Preferred-supplier changes aren't audited.** Stocked-item level changes weren't audited before either (no existing action), so none was added. This is recorded as remaining work.

Amendments recorded in the plan: 2 (Phase 8 supplier preference superseded), 3 (Phase 7 availability note), 4 (D2 rationale corrected), 5 (bulk requirement query), 6 (operational menu contract), 7 (item mix and menu engineering across the whole menu, decided by the owner during implementation).

## Migrations

- `0037_menu_stock_signals.sql` (generated, reviewed):
  - new tables `menu_item_outages`, `menu_item_stock_overrides` and `inventory_stock_alerts`;
  - new columns `location_settings.auto_86_from_stock`, `inventory_item_locations.preferred_supplier_item_id` and `notifications.inventory_stock_alert_id`;
  - a unique constraint on `supplier_items (id, inventory_item_id, organization_id)`;
  - the `notifications` type CHECK now includes `INVENTORY_LOW`.

  Two review fixes, made before the migration was committed or applied anywhere shared:
  - the new unique constraint now comes before the FK that depends on it;
  - the notification FK has an explicit name (`notifications_stock_alert_fk`), because the generated one went over 63 characters. The snapshots were updated to match, and the local dev database's constraint was renamed.
- `0038_menu_stock_signals_guards.sql` (custom): guard triggers on the three new tables, and `notifications_guard` now also freezes `inventory_stock_alert_id`.
- After both, `npm run db:generate` reports no changes.

## Validation results

- `npm run lint`: clean
- `npm run typecheck`: clean
- `npm run test:unit`: 49 files, 796 tests passed
- `npm run test:integration`: 79 files, 1,270 tests passed (includes migration reconstruction, the Phase 18 → 19 upgrade, seed idempotency and the reset safeguards)
- `npm run test:e2e`:
  - **Final run, CI mode** (production build, `CI=true`, 2 workers): 144 passed, 0 failed, 0 retried.
  - Earlier full runs on the dev server, during the fixes below:
    - run 1: 137 passed, 4 failed;
    - run 2: 139 passed, 5 failed.
  - Phase 19 caused failures in those runs, and they are fixed:
    - the new spec selected its item by a label that includes "(20 left)";
    - the order screen refreshed on every SEND at the location;
    - the order page computed the stock board during its own render.
  - The other failures (employees, restaurant seating) didn't reproduce when those specs ran alone.
  - A full dev-server run was not repeated after the last fix. The CI-mode run above is the final result.
- `npm run build`: succeeds
- `npm audit --omit=dev`: 0 vulnerabilities
- Seeds: `db:seed` twice on the dev database. The first run applied `security.menu-stock-permissions`; the second applied nothing (22 already applied).
- No Phase 19 path writes the ledger: only Phase 8 services and SEND/void call `postInventoryTransaction`. Phase 19 adds a read-and-alert step inside it, and the inventory boundary test ("writes stock only through the posting service") passes.

## Tests executed

- **New unit tests:**
  - `src/modules/menu/rules/stock-signals.test.ts`: portions remaining, sellability order, running low.
  - Decimal `wholeQuotient`/`wholeQuotientCeiling`.
  - Alert crossings and `suggestPurchaseLines` in `inventory-rules.test.ts`.
  - Hour buckets and menu engineering in `reporting/rules/rules.test.ts`.
  - Navigation entries.
- **New integration tests:**
  - `tests/integration/menu/stock-signals.test.ts` (7): bulk equals single requirements, per-location 86, SEND refusal, version and duplicate checks, Server refused, auto-86 on and off, sell anyway by business date, audit and outbox.
  - `tests/integration/inventory/stock-alerts.test.ts` (5).
  - `tests/integration/inventory/suggested-orders.test.ts` (6).
  - Phase 19 sections in `reports.test.ts` (6).
  - Phase 18 → 19 migration upgrade.
  - `security.menu-stock-permissions` seed upgrade.
  - The Phase 19 validation seed step.
- **New E2E spec:** `tests/e2e/menu-stock-signals.spec.ts` (4), at its own location:
  - the cook 86es and restores, and a Server sees the board but gets no actions and is refused by the API;
  - auto-86 then sell anyway;
  - a low-stock alert in the bell leads to a suggested draft PO;
  - the report sections render.
- **Updated existing tests:**
  - permission and seed counts (137 → 138; 22 seeds);
  - the expected table list;
  - the purchasing test that asserted "no preferred supplier" (superseded by amendment 2);
  - the inventory internal-operation list (`applyStockAlert`);
  - E2E cleanups now clear Phase 19 rows (`tests/helpers/e2e-stock-signals.ts`).

## Files changed

- **Schema and migrations:** `src/db/schema/menu-outages.ts` (new), `inventory.ts`, `notifications.ts`, `organization.ts`, `index.ts`; `drizzle/migrations/0037_*`, `0038_*` and their snapshots and journal.
- **Menu:** `queries/stock-signals.ts`, `rules/stock-signals.ts`, `services/outage-service.ts` (new); `queries/operational-menu.ts`, `validators/menu-validators.ts`.
- **Recipes:** `queries/menu-item-requirements.ts` (new).
- **Inventory:**
  - new: `rules/stock-alerts.ts`, `services/stock-alerts.ts`, `services/suggested-order-service.ts`;
  - changed: `services/posting-service.ts`, `services/purchase-order-service.ts`, `services/item-service.ts`, `queries/item-facts.ts`, `queries/stock-queries.ts`, `repositories/conversion-repository.ts`, `rules/replenishment.ts`, `validators/inventory-validators.ts`.
- **Auth and auditing:** `services/permission-holders.ts` (new), `permission-catalog.ts`, `role-catalog.ts`, `audit-actions.ts`; seed `src/db/seeds/menu-stock-permissions.ts` (new) and `registry.ts`.
- **Employees:** `queries/employee-display-names.ts` (`findDisplayNamesByUser`).
- **Reporting:** `queries/signals-report.ts`, `rules/hour-buckets.ts`, `rules/menu-engineering.ts` (new); `report-context.ts`, `services/report-service.ts`.
- **Shared:** `src/shared/decimal/decimal.ts`.
- **API:**
  - `src/app/api/menu/outages/`, `stock-overrides/`, `stock-signals/` and `stock-settings/`;
  - `src/app/api/purchasing/suggested-orders/`.
- **UI:**
  - new pages: `/menu/86`, `/purchasing/suggested`;
  - changed pages: the inventory item page and the low-stock page;
  - components: `order-workspace.tsx`, `notification-bell.tsx`, `realtime-provider.tsx`, navigation and icons, `stock-board-refresh.tsx`, `create-suggested-orders-button.tsx`.
- **Validation seed:** `scripts/validation-menu-stock.ts` (new), `scripts/seed-validation.ts`, `src/db/demo/validation-fixture.ts`.
- **Tests:** the files listed above.
- **Docs:** `docs/Phase-19-Menu-and-Stock-Signals.md` (plan and amendments), `README.md` (sections 14, 16, 21 and 22, the Phase 7, 8 and 19 notes in 33, and 36), `CLAUDE.md`, `docs/User-Guide.md`, this report.

## Risks

- **SEND does slightly more work.** Every posting now reads the item's reorder level, and on a crossing it looks up recipients and writes notifications inside the SEND transaction. That's a few small indexed queries and no network call. A location with many `purchasing.manage` holders writes one notification each, once per crossing.
- **Wrong counts.** With auto-86 on, a bad count takes an item off sale. Sell anyway covers this for the day, and the setting is off by default.
- **Notifications reference alerts.** Test and maintenance cleanups that delete users, ledger rows, supplier items or menu items must clear Phase 19 rows first. The E2E helpers do; Phase 16 retention doesn't delete any of these.
- **Live figures.** "N left" on the order screen can be up to 60 s behind other screens' sends. The server still decides at SEND.

## Remaining issues

- Item mix and menu engineering by category would need a category snapshot on order items (amendment 7). Not built.
- Modifier 86 (D10), scheduled or daypart 86, and the auto-86 running-low threshold (fixed at 5) are out of scope.
- Preferred-supplier and stock-level changes aren't audited (pre-existing gap, see decision 7).
- The plan's extension of `restaurant-day.spec.ts` was put in the new `menu-stock-signals.spec.ts` instead, at its own location, because turning auto-86 on at MAIN would change what parallel specs can sell.
- E2E runs on the dev server were flaky in specs Phase 19 doesn't touch (employees, restaurant seating). The final CI-mode run was clean.
- Carried over and unchanged: the `migrations.test.ts` timeout question, browser-local times in some panels, and the Playwright webServer/globalSetup "Outbox batch failed" log line.

## Next-phase readiness

Phase 19 is complete once this report is reviewed. No Phase 20 is named or planned. Cloud deployment remains on hold by owner decision; nothing in this phase changes the app's provider independence.
