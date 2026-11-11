# Phase 19: Menu and Stock Signals Design and Implementation Plan

## Purpose

Phase 19 turns stock and sales data the app already records into signals people act on during service. Today:

- **Par levels exist, but nothing speaks up.** `inventory_item_locations` has `par_level`, `reorder_level` and `reorder_target`, and `/inventory/low-stock` lists items at or below the reorder level with a suggested quantity (Phase 8). Nobody is told when an item crosses the line, and the suggestion has to be typed into a purchase order by hand.
- **"86" is all or nothing.** `menu_items.available` is one flag for the whole organization, set on the menu editor under `menu.edit`. A kitchen that runs out of salmon can't mark it out at one location, can't say why, and no one on the floor is told. Nothing compares stock against recipes, so an item can be sold long after its ingredient has run out.
- **The reports stop short of the questions managers ask.** The Phase 12 reports have sales by date and order type, menu items with theoretical cost and margin, closed orders by server, and voids and discounts by reason. There is no sales by hour, no item mix or menu engineering view, no richer server figures, and nothing shows voids, comps and discounts by the employee who did them.

Phase 19 was named by owner decision on 2026-11-10, when Tier 2 was split into Phase 18 (labor and tips) and Phase 19 (menu and stock signals).

It changes these written contract points, which the owner approves with this plan:

- **README section 14:** `available` stays the organization-wide "can be sold" flag. A per-location 86 list is added next to it, and an item is sellable at a location only when it is active, available, **and** not 86'd there.
- **README section 22:** `notifications` gains the `INVENTORY_LOW` kind (named there as a future kind).
- **README section 21 and the Phase 12 notes in section 33:** new sections in the existing Sales, Menu and Orders report areas. No new area and no new report permission.

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially sections 14 (Menu), 15 (Recipes), 16 (Inventory and Purchasing), 17 (Orders), 21 (Reporting), 22 (Notifications), 23 (Outbox), 24 (Transaction Boundaries) and the Phase 7, 8, 9, 10 and 12 notes in section 33.
2. Read the Phase 7, 8, 10 and 12 plans and completion reports: `active` vs. `available`, the operational menu, replenishment rules, the in-transaction notification precedent, and the menu report's cost rule.
3. Read `docs/accepted-risks.md`. This phase should add no dependency.

## Decisions for the owner

Approved by the owner on 2026-11-11 as recommended. The policies below follow them.

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | `menu_items.available` is organization-wide, but stock is per location. How is an item 86'd at one location? | **A per-location 86 list** (`menu_item_outages`), checked by the operational menu alongside `available`. `available` keeps its meaning: "not sold anywhere". | Keeps Phase 7's data and meaning. Multi-location capable (CLAUDE.md). No rename migration. |
| D2 | Should the app 86 items from stock automatically? | **Yes, opt-in per location** (`location_settings.auto_86_from_stock`, default off). With it on, an item whose current recipe can't cover one more portion from on-hand stock isn't sellable. | Recorded stock can be wrong (a bad count, or a location that allows negative stock). With negative stock off, SEND already refuses a shortfall; auto-86 shows the item as out before anyone tries. Off by default means nobody loses sales to a bad count without choosing to. |
| D3 | Is auto-86 a stored record written when stock moves, or worked out when the menu is read? | **Worked out on read** ("portions remaining", one aggregation query). It is never stored, so nothing has to catch every stock change. | A stored version needs a hook in every inventory posting, which makes Inventory write Menu data or adds an outbox consumer (a new pattern). A read-time figure is always current. |
| D4 | A manager knows stock is there but the count says zero. Can they keep selling? | **Yes: "sell anyway" for the business date**, audited, under the same permission as a manual 86. It ends at the business-date cutoff. | Stops a wrong count from blocking service, and needs no "crossing" logic to stay correct. |
| D5 | Who may 86 and restore items at a location? | **A new `menu.availability.manage`** for Owner, General Manager, Manager, Cook and Bartender. Everyone with `menu.view` sees the 86 board. | The kitchen and bar 86 items in practice. Giving them `menu.edit` would let them change the catalog. |
| D6 | Who gets low-stock alerts, and how often? | **Users at the location who hold `purchasing.manage`**, once per crossing: one OPEN alert per item and location, which closes by itself when stock goes back above the reorder level. | Reuses an existing permission; one alert per crossing avoids a notification on every sale. |
| D7 | What does "suggested PO" create? | **DRAFT purchase orders, one per supplier, never submitted.** The manager reviews, edits and submits them through the existing Phase 8 flow. | Phase 8 is recommendation only, and creating a PO adds no stock. Submitting stays a human action. |
| D8 | Which supplier does a suggestion use? | **A preferred supplier item per stocked item and location** (`inventory_item_locations.preferred_supplier_item_id`, optional). An item with none is listed as "choose a supplier" and isn't put on a draft. | No guessing by cost; the schema notes there is no preferred-supplier field today. |
| D9 | Which hour does "sales by hour" use? | **The hour the order was opened, in the location's time zone**, laid out from the business-date cutoff (for example 4 AM to 3 AM). | Shows when guests arrived, which is what staffing questions need. Close time is skewed by long tables. |
| D10 | Are modifiers 86'd too (for example "Swiss instead of American" when Swiss is out)? | **No, menu items only in this phase.** Manual modifier 86 is recorded as remaining work. | Keeps the phase to one sellability check. Modifier stock depends on the menu-item context (README section 15). |

## Approved Phase 19 Policies

### A. The 86 board

1. **Ownership.** The Menu module owns sellability at a location: the 86 list, the "sell anyway" overrides and the portions-remaining figure. Stock figures come from the Inventory module's public query, and recipe requirements from the Recipes module's, not from their tables directly.
2. **Manual 86.** `menu_item_outages`:
   - organization, location, menu item;
   - `status` `ACTIVE` or `RESTORED`;
   - `reason` (required, short text), marked out by and at;
   - restored by and at (null while ACTIVE);
   - `version`.

   A partial unique index allows one ACTIVE outage per item and location. Rows are never deleted: restoring sets the restored fields, and a trigger refuses any other change once RESTORED. A manual 86 lasts until someone restores it. It doesn't end at close.
3. **Portions remaining** (pure rule `portionsRemaining` in `src/modules/menu/rules/`). For a menu item at a location: its recipe version in effect now, and for each ingredient the base-unit requirement of **one sold item**. That requirement comes from the same function SEND consumption uses (shared, not copied). Portions remaining = the lowest `floor(on hand ÷ requirement)` across the ingredients, never below zero. Modifiers are ignored, because they're a choice per order. An item with no recipe, or a recipe with no ingredients, has no figure and is never auto-86'd.
4. **Auto-86** (when `location_settings.auto_86_from_stock` is on). An item whose portions remaining is 0 isn't sellable at that location, unless it has a "sell anyway" override for the current business date (policy 5). Turning the setting on or off is audited under the existing location settings permission.
5. **Sell anyway.** `menu_item_stock_overrides`: location, menu item, `business_date`, set by and at, reason, cleared by and at. One uncleared override per item, location and business date (partial unique index). It only overrides auto-86. It never overrides a manual 86 or `available = false`. It ends by itself when the business date changes, so nothing has to expire it.
6. **The sellability check.** `getOperationalMenu` (which both the draft-add path and SEND already use, through `resolveSellableItem`) leaves out an item that is 86'd at the location, or auto-86'd with no override. So one place decides, and a draft item whose menu item was 86'd after it was added is refused at SEND with the existing `ITEM_NOT_SELLABLE`. Already-sent items are never touched (rule 7).
7. **Board.** `/menu/86` shows, for the signed-in user's location:
   - *86'd now:* manual outages (reason, who, since when) and auto-86'd items (with the ingredient that ran out);
   - *Running low:* items with 1–5 portions remaining (the threshold is fixed at 5 in this phase);
   - *Sell anyway today*;
   - *Restored today*.

   Actions are 86 (with reason), restore, and sell anyway. They show only with `menu.availability.manage`, and every API checks it again. The order screen marks 86'd items as unavailable rather than hiding them, and shows "N left" for running-low items.
8. **Concurrency.** Restore and clearing an override check `version`. A second 86 of an item that's already 86'd is refused (`ITEM_ALREADY_86ED`), and the partial unique index is the final guard.
9. **Events.**
   - Audit (category `MENU`): `menu.item-marked-out`, `menu.item-restored`, `menu.sell-anyway-set`, `menu.sell-anyway-cleared`. Details: item code, location, reason.
   - Outbox: `menu.availability-changed` (location-scoped, after commit) for each of those, so the 86 board and order screens refetch.
   - Auto-86 has no event of its own, because nothing is written. The board and order screens also refetch on `order.items-submitted` and every 30 seconds.

### B. Low-stock alerts

10. **Ownership.** The Inventory module owns low-stock alerts. They're about the reorder level it already owns.
11. **Alerts.** `inventory_stock_alerts`: organization, location, inventory item, `status` `OPEN` or `RESOLVED`, quantity on hand and reorder level when opened, opened at, resolved at, and quantity when resolved. A partial unique index allows one OPEN alert per item and location.
12. **When an alert opens and closes.** `postInventoryTransaction` (every ledger posting goes through it) compares the balance before and after the posting, in the same transaction:
    - from above the reorder level to at or below it: open an alert, unless one is already OPEN;
    - from at or below to above: resolve the OPEN alert.

    Items with no reorder level, or that are inactive or not stocked at the location, never alert. Changing the reorder level doesn't open or close an alert. The next posting does. This adds a few reads and at most one insert to each posting, and no network call (rule 5).
13. **Notifications.** When an alert opens, an `INVENTORY_LOW` notification is written in the same transaction for each active user at the location who holds `purchasing.manage` (D6). The body names the item, on hand and reorder level, without cost. `notifications` gains a nullable `inventory_stock_alert_id`, a unique (alert, recipient), and `INVENTORY_LOW` in its type CHECK. They're delivered by the existing `notification.created` realtime path. Resolving an alert sends nothing.
14. **Low-stock page.** `/inventory/low-stock` gains an "alert open since" column and a filter for open alerts. The suggested quantity rule (`evaluateStock`) is unchanged.

### C. Suggested purchase orders

15. **Preferred supplier.** New nullable `inventory_item_locations.preferred_supplier_item_id`, with a foreign key to a supplier item for the same inventory item and organization. It's set on the stocked-item form under `inventory.configure` and audited with the existing item-location changes.
16. **Suggestion** (pure rule `suggestPurchaseLines` in `src/modules/inventory/rules/replenishment.ts`). For each low item at the location:
    - need (base units) = `evaluateStock` suggested quantity − quantity still outstanding on this location's DRAFT, SUBMITTED and PARTIALLY_RECEIVED purchase orders for that item;
    - if the need is above zero and there's a preferred supplier item: order quantity = need ÷ `base_units_per_purchase`, **rounded up** to a whole purchase unit;
    - the line cost estimate is the supplier item's `last_unit_cost` (shown only with `inventory.cost.view`).

    Lines are grouped by supplier. Items without a preferred supplier are listed separately and left out.
17. **Create drafts.** `POST /api/purchasing/suggested-orders` (`purchasing.manage`, idempotency scope `purchasing.suggest`) creates one DRAFT purchase order per supplier through the existing purchase order service, in one transaction. A retry with the same key returns the same POs. Running it again later subtracts the drafts already made, so it doesn't double the order. It never submits, and it changes no stock (README section 16).
18. **Events.** Audit `purchasing.suggested-orders-created` (category `INVENTORY`): PO numbers and line count. The created POs carry the normal Phase 8 PO audit.

### D. Reports

All sections go in existing areas under their existing permissions, read only CLOSED orders and snapshots (rule 4), export to CSV, and use indexed aggregation queries with no materialized view.

19. **Sales by hour** (Sales area, `reports.sales`). By hour opened (D9), across the date range: closed checks, covers, net sales, average check. Optionally split by order type. All 24 hours appear, zero-filled.
20. **Item mix** (Menu area, `reports.sales`). By menu item and category: quantity sold, % of item count within the category, net sales, % of net sales. Uses the existing theoretical cost and margin, under the menu report's existing cost rule.
21. **Menu engineering** (Menu area). Each item sold in the range gets a popularity flag (its count is at least 70% of an even share of its category, the usual Kasavana–Smith rule) and a margin flag (its contribution margin is at least the category's weighted average). Together they give Star, Plowhorse, Puzzle or Dog. Shown only when the viewer can see cost. Items without a theoretical cost are listed as "no cost" and not placed.
22. **Server performance** (Orders area, `reports.orders`). Extends "Closed orders by server" with covers, checks, net sales, average check, average per cover, items per check, average check duration (opened to closed), and void, comp and discount amounts on that server's checks. Tip figures appear only for a viewer who also holds `reports.tips` or `tips.manage` (the Phase 18 rule).
23. **Voids, comps and discounts by employee** (Orders area). By the employee who did it: the user who voided (`voided_by_user_id`) or applied the discount (`applied_by_user_id`), resolved to their linked employee, and otherwise shown as the user's display name. Count, amount, % of the net sales they served (where they're also a server), and reasons. These are facts only. There are no thresholds and no "abuse" label, so a manager decides what's unusual.
24. **86 history** (Inventory area, `reports.inventory`). Manual 86s and sell-anyway overrides in the range: item, reason, who, duration.

### E. Permissions and boundaries

25. **Permissions.** One new code, 138 in all: `menu.availability.manage` (Owner, General Manager, Manager, Cook, Bartender). It's seeded by an idempotent `security.menu-stock-permissions` seed. Viewing the board uses `menu.view`. Alerts and suggestions reuse `purchasing.manage`, and reports reuse their area permissions.
26. **Rule 6.** Nothing in this phase moves inventory. Alerts read balances inside a posting. Suggestions create DRAFT POs only.
27. **Rule 4.** Reports read snapshots of CLOSED orders. Portions remaining and the 86 board are live operational state and are never stored as history, apart from the manual outages and overrides, which are records.
28. **Not forecasting.** Suggestions follow par and reorder levels only. Demand forecasting stays a README section 39 future capability.

## Amendments decided at planning

Decided on 2026-11-11, when Phase 19 was planned:

1. **Owner decisions:** D1–D10 approved as recommended.

Decided on 2026-11-11, when `/phase 19` was planned (owner approved the execution plan):

2. **Phase 8 supplier preference superseded.** The approved Phase 8 policy (no preferred-supplier field, nothing chooses a supplier, nothing creates an order) is replaced by D7/D8. README section 33's Phase 8 note is rewritten at completion.
3. **Phase 7 availability note superseded.** "Nothing infers availability from stock or recipes" holds only where `auto_86_from_stock` is off. README section 33's Phase 7 note is updated at completion.
4. **D2 rationale corrected.** `allow_negative_inventory` defaults to false, so SEND already refuses a shortfall there; the wording above was fixed. No policy change.
5. **Bulk requirement query.** Portions remaining uses a bulk Recipes query that reuses the SEND conversion (`toItemBaseQuantity`) and per-portion meaning; a test proves it equals `resolveRevisionRequirements`. This is what policy 3's "same function" means in practice.
6. **Operational menu contract.** `getOperationalMenu` gains only the sellability filter. "N left" figures come from `GET /api/menu/stock-signals`.

Decided on 2026-11-11, during implementation (owner decision):

7. **Item mix and menu engineering across the whole menu.** Order items carry no category snapshot, so grouping past sales by category would read today's menu placements (rule 4). Policies 20 and 21 compare items across all items sold instead. Grouping by category stays remaining work.

## 1. Objectives

Deliver:

- Per-location manual 86 with reason and restore; read-time portions remaining; opt-in auto-86; sell anyway for the business date; one sellability check at draft add and SEND
- The 86 board (`/menu/86`), with "N left" and unavailable states on the order screen, refreshed through `menu.availability-changed`
- Low-stock alerts opened and resolved by inventory postings, with `INVENTORY_LOW` in-app notifications
- Preferred supplier per stocked item; suggested DRAFT POs per supplier with idempotent create
- Report sections: sales by hour, item mix, menu engineering, server performance, voids/comps/discounts by employee, 86 history
- One new permission (138 in all), role grants and the idempotent seed
- README, CLAUDE.md and User Guide updates, and `docs/Phase-19-Completion-Report.md`

## 2. Scope Boundary

Out of scope (don't build):

- Modifier 86 (D10), 86 by menu or daypart, or scheduled 86 ("off at 9 PM")
- Auto-submitting POs, emailing suppliers, vendor EDI, or choosing a supplier by price
- Demand forecasting, prep lists or par levels that change with the day of the week
- SMS, email or push alerts (in-app only, README section 22)
- Fixed thresholds or alerts for void and comp patterns
- Any change to SEND consumption, the ledger, or how negative stock is allowed
- Cloud deployment (on hold)

## 3. Review Existing Foundation Before Changes

Confirm from code rather than memory:

- `src/modules/menu/queries/operational-menu.ts` and `order-menu-facts.ts` (`resolveSellableItem`): the single place to add the location 86 and auto-86 checks. Confirm both the draft-add path (`draft-item-service.ts`) and `src/workflows/submit-order` go through it.
- The SEND consumption calculation in `src/modules/inventory/services/order-consumption.ts` and the recipe resolution in the Recipes module: expose the "base-unit requirement of one sold item, no modifiers" as a shared function rather than copying it.
- `postInventoryTransaction` in `posting-service.ts`: that it sees the balance before and after, and that every caller (stock operations, receiving, counts, order consumption) goes through it.
- `src/modules/inventory/rules/replenishment.ts` (`evaluateStock`, `assertThresholds`) and `listLowStock`: reuse them.
- The purchase order service: creating a DRAFT with lines from a service call, numbering, and its audit.
- `notifications` (type CHECK, the ticket unique) and the `notification.created` realtime path; `location_settings` and its form and audit allow-list.
- `src/modules/reporting/queries/order-report.ts` and `menu-report.ts`: the cost rule, and the void and discount actor columns.
- The `audit_events_action_format` and `outbox_events_event_type_format` CHECKs accept `menu.item-marked-out`, `menu.availability-changed` and `purchasing.suggested-orders-created`.
- The role catalog: Cook and Bartender exist under those codes; which roles hold `purchasing.manage`.
- The demo and validation seeds, and `tests/integration/database/migrations.test.ts`.

If any of these conflicts with the policies above, stop and explain before changing it.

## 4. Build Order

Each step generates its own migration with `npm run db:generate` (plus a custom migration for triggers), reviewed before applying. Migrations start at 0037. Each step leaves lint, typecheck, and unit and integration tests green before the next starts.

1. **86 list and sellability:** `menu_item_outages`, `menu_item_stock_overrides`, `location_settings.auto_86_from_stock`; `portionsRemaining`; the operational menu check; the permission seed.
2. **Low-stock alerts:** `inventory_stock_alerts`, the posting hook, the notification kind.
3. **Suggested POs:** preferred supplier column, `suggestPurchaseLines`, create-drafts endpoint.
4. **Reports:** the six sections and CSV.
5. **UI and E2E:** `/menu/86`, order-screen states, low-stock page additions, suggested PO review screen, report sections, navigation by permission.
6. **Validation seed:** an 86'd item, an open low-stock alert and a suggested draft PO on the validation fixture day.
7. **Documentation and the completion report.**

## 5. Unit Tests

- *Portions remaining:* one and several ingredients, the lowest wins, floor, zero and negative on hand, unit conversion, recipe yield above one, no recipe gives no figure.
- *Sellability:* manual 86 beats sell anyway; sell anyway beats auto-86 only on its business date; `available = false` beats everything; auto-86 setting off ignores portions.
- *Alert crossing:* above → at, at → below, below → above, no reorder level, a posting that doesn't cross.
- *Suggestion:* outstanding PO quantity subtracted; round up to whole purchase units; no preferred supplier; grouping by supplier; need of zero or less gives no line.
- *Menu engineering:* the 70% popularity line, the weighted-average margin, ties at the line, items with no cost.
- *Sales by hour:* hour buckets from the cutoff, time zone and daylight saving change.

## 6. Integration Tests

- **86:**
  - an 86'd item at one location is still sellable at another;
  - a draft item 86'd before SEND is refused with `ITEM_NOT_SELLABLE`, and sent items are untouched;
  - a second 86 is refused, and restore checks `version`;
  - auto-86 at zero portions only when the setting is on; sell anyway lets it be sold today and not tomorrow;
  - a Server can't 86 (API refuses), and a Cook can;
  - audit details hold only allow-listed fields; `menu.availability-changed` is in the outbox after commit only.
- **Alerts:**
  - a SEND that takes an item to its reorder level opens one alert and one notification per `purchasing.manage` user at the location, and the next SEND adds none;
  - a receipt above the level resolves it; a rolled-back posting leaves no alert or notification;
  - a user without the permission, or at another location, gets nothing.
- **Suggested POs:**
  - drafts per supplier with rounded quantities, never submitted, no ledger rows;
  - a retry with the same key returns the same POs; a second run subtracts the drafts;
  - costs hidden without `inventory.cost.view`.
- **Reports:** each new section exact against a fixture; cost-dependent figures hidden without cost permission; tips hidden without `reports.tips`; location scoping; a later price or recipe change doesn't change past figures.
- **Canonical scenario:** the Bacon Cheeseburger test still passes unchanged.
- **Migrations:** reconstruction from all migrations and the upgrade-from-Phase-18 checks pass. Existing `location_settings` rows get `auto_86_from_stock = false`.

## 7. E2E Tests (Playwright)

- **`restaurant-day.spec.ts` (extended):** the cook 86s an item with a reason. The server sees it as unavailable on the order screen and can't send it. The manager restores it, and it can be ordered again. A SEND crosses a reorder level, and the manager sees the low-stock notification, opens the low-stock page and creates a suggested draft PO.
- Auto-86: with the setting on, an item with no stock shows as 86'd. Sell anyway makes it orderable.
- A Server sees the 86 board but no 86 actions, and the API refuses them.
- The new report sections render and export.
- Every existing spec still passes.

## 8. Documentation

- **README section 14:** per-location 86, auto-86 and sell anyway.
- **README section 16:** low-stock alerts, preferred supplier, suggested POs.
- **README section 21 and the Phase 12 notes:** the new sections.
- **README section 22:** `INVENTORY_LOW` as built.
- **README section 33:** a "Phase 19 Menu and Stock Signals" note with the policies as built.
- **README section 36 and the `CLAUDE.md` phase list:** Phase 19 as planned (on approval), and the Menu/recipes and Inventory summaries at completion.
- **`docs/User-Guide.md`:** 86ing and restoring an item, sell anyway, low-stock alerts, creating suggested POs, the new reports.

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
- [ ] No inventory ledger row is written by any Phase 19 code path

## 10. Required Phase 19 Completion Report

Write `docs/Phase-19-Completion-Report.md`:

```text
PHASE 19 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Per-location 86, restore, sell anyway:
- Portions remaining and auto-86:
- Sellability check (draft add and SEND):
- Low-stock alerts and notifications:
- Preferred supplier and suggested POs:
- Report additions:

Results
- 86 at one location leaves others sellable: PASS / FAIL
- 86'd draft item refused at SEND; sent items untouched: PASS / FAIL
- Auto-86 only when enabled; sell anyway ends with the business date: PASS / FAIL
- One alert per crossing; rolled-back posting leaves none: PASS / FAIL
- Suggested POs are DRAFT, idempotent, no ledger rows: PASS / FAIL
- Report sections exact; cost and tips hidden without permission: PASS / FAIL
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
