# Phase 20: Service Polish and Deferred Features Design and Implementation Plan

## Purpose

Phase 20 closes the work left open by Phases 6 to 19. The owner chose its scope on 2026-11-11: every leftover item, the older gaps, the features deferred in Phases 17 and 18, and the open test and tooling questions. Left out on purpose:

- reopening a CLOSED check (a contract change: nothing reopens a check)
- payments, and the README section 39 future capabilities
- cloud deployment (on hold)

This is the largest phase so far. It's planned as one phase because the owner chose it that way, and it's built in eight steps (section 4) that each leave the repository green.

What is open today (checked against the code on 2026-11-11):

- **Menu and stock.**
  - `order_items` has no category, so item mix and menu engineering can't group past sales by category (Phase 19 amendment 7).
  - Modifiers have only `active`, and nothing marks one out at a location.
  - An 86 lasts until someone restores it. There is no "off at 9 PM".
  - The running-low threshold is the constant `RUNNING_LOW_PORTIONS = 5` (`src/modules/menu/rules/stock-signals.ts`).
  - `setItemLocation` (par, reorder level, target, preferred supplier) writes no audit, and neither does the general location settings update.
  - Sales by hour is a table only. The app has no chart component.
- **Floor.** `moveSession` and `addTableToSession` never check reservation holds. Only seat-party does (`checkHoldsForSeating`).
- **Time clock.** The manager adjust API accepts break changes, but the time-clock page has no break form.
- **Time display.**
  - Five displays use the browser's time zone: the notification bell, the settlement "Settled and closed at", the low-stock page, the 86 board and the tax admin page.
  - Every `datetime-local` input is read in the browser's time zone (`entity-form.tsx`).
- **Notifications.** Only `FOOD_READY`, `BAR_ORDER_READY` and `INVENTORY_LOW` exist. Schedule publish, swaps, time off and certifications send nothing. `certification_types.warning_days` is stored but never acted on.
- **Checks.** Tax is added on top of prices only; there is no exemption. Items move between checks whole, so one item can't be shared between them. Refunds can't return a tip.
- **Labor.** Overtime is weekly only. There is no cash tip declaration, and no notification for overtime or a missed clock-out.
- **Loading.** There are no route `loading.tsx` files (Phase 15 decision); the dashboard is the only page with a `Suspense` boundary.
- **Tests and tooling.**
  - The `migrations.test.ts` upgrade tests run near Vitest's 5 s default.
  - Playwright starts the web server before `globalSetup` rebuilds the test database, so its outbox processor logs `42P01`.
  - No browser test clicks "Reload" after a stale-data conflict, or runs with tax on.
  - Dev-server E2E runs are flaky in the employees and restaurant specs.
  - Most `.gitignore` rules aren't anchored to the repository root.

It changes these written contract points, which the owner approves with this plan:

- **CLAUDE.md and README section 19:** tax may be included in the price (per tax rate) and a check may be tax exempt; one sent item may be shared between checks; a refund may return a tip.
- **CLAUDE.md and README section 11:** overtime is weekly **and**, when configured, daily.
- **README section 14:** modifiers can be 86'd at a location, and an 86 may be scheduled.
- **README section 22:** the remaining example kinds, plus the overtime, missed clock-out and time-off-denied kinds.
- **Phase 17 and 18 plans:** the scope-boundary lines for these features are superseded (amendments recorded in those plans at completion).

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially sections 11, 12, 13, 14, 17, 19, 21, 22, 24 and the Phase 6, 15, 17, 18 and 19 notes in section 33.
2. Read the Phase 6, 15, 17, 18 and 19 plans and completion reports.
3. Read `docs/accepted-risks.md`. This phase should add no dependency (the chart is plain SVG).

## Decisions for the owner

Approved by the owner on 2026-11-11 as recommended. The policies below follow them.

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | An item can sit in several menu categories. Which one does SEND snapshot? | **The placement `resolveSellableItem` already picks**: first by category display order on the location's operational menu. Snapshot `menu_category_id` and `menu_category_name_snapshot`. Older items show as "Uncategorized". | One rule, already used for selling. No guessing from current placements for history (rule 4). |
| D2 | How do modifiers get 86'd? | **A manual per-location modifier 86** (`modifier_outages`), under `menu.availability.manage`. No auto-86 for modifiers. If a required modifier group has no option left, the item is unsellable at that location. | A modifier's stock use depends on the item it's on (README section 15), so a read-time figure would be guesswork. |
| D3 | What does "scheduled 86" mean? | **One-off start and end times** on an outage ("from 9 PM", "until close", "until a time"). It's in effect when `starts_at ≤ now < ends_at`, worked out on read. Recurring dayparts aren't built. | Covers "off at 9 PM" with no job to run. Recurring availability belongs to menus, a bigger change. |
| D4 | Where is the running-low threshold set? | **`location_settings.running_low_portions`** (1–99, default 5), on the stock signals settings under `locations.manage`. | It's per location, like auto-86. |
| D5 | Which stock and settings changes get audited? | **Stocked-item changes** (`inventory.item-location-changed`) and **general location settings** (`organization.location-settings-changed`), with allow-listed before and after values. | Closes the Phase 19 gap and the general settings gap found during planning. |
| D6 | How is sales by hour charted? | **A plain inline SVG bar chart** above the existing table, with the table kept for exact values and accessibility. | No new dependency, and it uses the Phase 15 tokens. |
| D7 | Moving or combining a seated party onto a held table: what happens? | **The same rule as seating**: refused while another party's hold is in effect, unless the user holds `reservations.override-hold` and gives a reason, which is recorded. It runs as a workflow (`src/workflows/move-table-session/`). | Restaurant can't import Reservations, and one rule for all three ways of taking a table. |
| D8 | Break editing on the time clock? | **A break list in the manager's adjust form** (add, change, remove), sent through the existing PATCH and its audit. | The API already exists. |
| D9 | Which time zone do times show in? | **The location's**, everywhere: a shared formatter in `src/shared/time/`, and `datetime-local` inputs read in the location's time zone. | A tablet set to another zone, or a manager working remotely, would otherwise see wrong times. |
| D10 | Who gets the schedule notifications? | `SCHEDULE_PUBLISHED`: each employee with an assignment in the period who has an active linked user. `SHIFT_CHANGED`: both employees of an approved swap. `TIME_OFF_APPROVED` and `TIME_OFF_DENIED`: the requester. All are written in the same transaction as the change. | README section 22 names them. A denial matters as much as an approval. |
| D11 | How are expiring certifications found? | **The existing maintenance runner** checks once a day per location (it runs hourly). It sends `CERTIFICATION_EXPIRING` to the employee and to `hr.certifications.manage` holders at the location when a certification is within its type's `warning_days`, once per certification and expiration date. | No new scheduler. The once-only key stops repeats. |
| D12 | Overtime and missed clock-out notifications? | **Two kinds, from the same maintenance pass**: `OVERTIME_APPROACHING` (once per employee and work week, at the Phase 18 "approaching" line) to the employee and `timeclock.manage` holders; `MISSED_CLOCK_OUT` (once per entry) to `timeclock.manage` holders. Warnings still never block. | Both depend on time passing, not on a write, so a periodic check is the only honest trigger. |
| D13 | Where does "tax included in price" live? | **On the tax rate** (`tax_rates.price_includes_tax`, per category and location, effective-dated with the rate). | A bar can price drinks with tax included and food without. |
| D14 | How is included tax counted? | Tax per group = ROUND_HALF_UP(base × rate ÷ (100 + rate)). `subtotal` stays pre-tax (net sales), and `total_due` = `subtotal` + `tax_total` still holds. A new `included_tax_total` explains the gap between line totals and `subtotal`. | Keeps the reports' meaning of net sales and the settlement rule unchanged. |
| D15 | What is a tax exemption? | **Per check**, on an OPEN order with no OPEN settlement, by a new `tax.exempt` permission (Owner, General Manager, Manager), with a reason and an optional certificate reference. All tax on that check is zero; tax-included items are reduced by their included tax. It can be removed while the check is OPEN. | Matches how exempt guests are handled. A new permission because it lowers what's owed. |
| D16 | How is one item shared between checks? | **Split a sent item into 2–10 equal shares**, each moved to a check on the same session. The original item becomes `SPLIT` and leaves the totals. Shares carry the money (cents by largest remainder) and point to the original. Consumption, kitchen work and item-count reports stay on the original, so nothing is counted twice. Uses `orders.move-items`. | Splitting the money doesn't touch food that was already made once. |
| D17 | How are tips refunded? | **`order_refunds.tip_amount`**, for CASH and EXTERNAL_CARD refunds only, no more than the order's recorded tips in total. It's refused while the order's business date has a FINALIZED tip distribution (void and redo it first). The pool and cash drawer expected cash subtract tip refunds. | Keeps the finalized snapshot true. |
| D18 | Daily overtime? | **Optional `scheduling_rules.daily_overtime_threshold`** (null means off). Hours past it on one business date are overtime. Weekly overtime then counts only the hours that weren't already daily overtime, so no hour counts twice. Same multiplier. No double time. | Common configuration, still business configuration rather than a legal claim. |
| D19 | Cash tip declarations? | **Record only**: `tip_declarations` per employee, location and business date (self under `timeclock.punch`, others under `tips.manage`). Declared tips aren't in the pool. They're frozen while the date's tips are finalized, and shown in the Tips report. | The pool comes from tenders. A declaration is what the employee says they kept. |
| D20 | Loading states? | **`Suspense` with a skeleton inside the slow pages** (reports areas, audit, the 86 board, the time clock), still no route `loading.tsx`. | The Phase 15 decision stands. |
| D21 | The 42P01 log at E2E start? | **Prepare the database before the server starts**: the `webServer` command runs the test database prepare script first, and `globalSetup` only checks that it's ready. | Fixes the order instead of hiding the log. |
| D22 | Tips finalized in `restaurant-day.spec.ts`? | **No**, because `labor-tips.spec.ts` already finalizes. Finalizing at MAIN would freeze time entries that parallel specs use. | The gap is covered, so no change is needed. |
| D23 | Housekeeping outside the repository (`%USERPROFILE%\package-lock.json`, the old `restaurant-ops-postgres-1` container)? | **I list them and ask you before deleting anything.** `.gitignore` rules for root-only folders get a leading `/`. | They're outside the repository. |

## Approved Phase 20 Policies

Binding since the owner approved D1–D23 on 2026-11-11.

### A. Menu and stock

1. **Category snapshot (D1).** SEND writes `order_items.menu_category_id` and `menu_category_name_snapshot` from the placement resolved for the item. Both are added to the `order_items_freeze` trigger. Older rows stay null, and reports show them as "Uncategorized".
2. **Reports by category.**
   - Item mix shows % of count and % of net sales within the category snapshot.
   - Menu engineering classifies each item within its category (Kasavana–Smith: popularity at 70% of an even share, margin against the category's weighted average). The whole-menu view stays as a second section.
3. **Modifier 86 (D2).**
   - `modifier_outages` works like `menu_item_outages`: ACTIVE or RESTORED, reason, by and at, `version`, never deleted, and frozen once RESTORED.
   - `getOperationalMenu` leaves out 86'd modifiers. It leaves out an item when a required group has fewer available options than its minimum.
   - Draft add and SEND refuse an 86'd modifier with `MODIFIER_UNAVAILABLE`. Sent items are untouched.
   - Audit: `menu.modifier-marked-out` and `menu.modifier-restored`. Outbox: `menu.availability-changed`.
4. **Scheduled 86 (D3).**
   - Item and modifier outages gain `starts_at` (defaults to now) and an optional `ends_at`, with `ends_at > starts_at`.
   - An outage is in effect when it is ACTIVE and `starts_at ≤ now < ends_at` (or `ends_at` is null). "Until close" sets `ends_at` to the next business-date cutoff, from `BusinessDateService`.
   - An exclusion constraint forbids two overlapping ACTIVE outages for the same item (or modifier) and location. It replaces the partial unique index.
   - An outage whose time has passed stays ACTIVE in the table but has no effect; the board lists it under "Ended today". Restoring early still works.
5. **Running-low setting (D4).** `location_settings.running_low_portions SMALLINT NOT NULL DEFAULT 5` (1–99) replaces the constant. It's changed with the auto-86 setting and recorded in its existing audit action.
6. **Audit (D5).**
   - `inventory.item-location-changed`, category `INVENTORY`: item code, location, before and after for par, reorder level, reorder target, preferred supplier item and active.
   - `organization.location-settings-changed`, category `ORGANIZATION`: the setting fields that changed. Settings that already have their own audit action keep it.
7. **Chart (D6).** A `BarChart` component in `src/components/reports/`: inline SVG, the design tokens, an `aria-label` summary, and the data table kept below it. It's used for sales by hour only.

### B. Floor

8. **Held tables on move and combine (D7).**
   - A new workflow `src/workflows/move-table-session/` wraps `moveSession` and `addTableToSession`. In one transaction it calls `checkHoldsForSeating` for the target tables and records overrides with `recordHoldOverrides`.
   - It refuses with the existing hold conflict unless the user holds `reservations.override-hold` and gives a reason.
   - The routes call the workflow. The Restaurant module still doesn't import Reservations.

### C. Time and time clock

9. **Location time (D9).**
   - `formatInstant(iso, timeZone, style)` in `src/shared/time/` is the one display formatter.
   - The five browser-local displays switch to it with the location time zone passed from the server page.
   - `EntityForm` `datetime-local` fields take the time zone and convert with `localToInstant`. The Phase 18 clock adjust form uses the same conversion.
10. **Break form (D8).** The manager's adjust form lists the entry's breaks (start, end, paid) with add, change and remove. It's sent as the existing `breaks` PATCH field, with the required reason. The Phase 18 break rules (inside the entry, no overlap) give the errors.

### D. Notifications

11. **Kinds.** The type CHECK gains `SCHEDULE_PUBLISHED`, `SHIFT_CHANGED`, `TIME_OFF_APPROVED`, `TIME_OFF_DENIED`, `CERTIFICATION_EXPIRING`, `OVERTIME_APPROACHING` and `MISSED_CLOCK_OUT`.
12. **Links.**
    - New nullable foreign keys: `schedule_period_id`, `shift_swap_request_id`, `time_off_request_id`, `employee_certification_id`, `time_entry_id`.
    - New nullable columns `dedupe_key` and `recipient` unique together. The keys are certification + expiration date, employee + work week, and entry.
    - The guard trigger checks that each kind has its link.
    - The bell gets each kind's link target from one map.
13. **Writers.**
    - Schedule, swap and time-off notifications are written in the same transaction as the change, through a new `createNotifications` service in the Notifications module, which the existing writers also move to.
    - Recipients must be active users at the location. Bodies hold no compensation or restricted HR data.
14. **Periodic check (D11, D12).**
    - `runMaintenance` gains a `notifyTimeBasedSignals` step under its advisory lock.
    - For each location it finds certifications inside their warning window, on-clock employees at or past the approaching-overtime line this work week, and OPEN entries from an earlier business date.
    - It inserts notifications `ON CONFLICT DO NOTHING` on the dedupe key. Each location runs in its own transaction.

### E. Checks

15. **Tax included in price (D13, D14).**
    - `tax_rates.price_includes_tax BOOLEAN NOT NULL DEFAULT false`. SEND snapshots it (`order_items.tax_included_snapshot`), and it's added to the freeze trigger.
    - `calculateOrderTax` groups by (category, rate, included). An included group's tax = ROUND_HALF_UP(base × rate ÷ (100 + rate)); an added group's is unchanged.
    - `orders.included_tax_total` is new. The check becomes `subtotal = item_subtotal − discount_total − included_tax_total`. `total_due = subtotal + tax_total` is unchanged, with `tax_total` holding both kinds.
    - `order_tax_lines` gains the included flag.
    - Existing rows: `included_tax_total = 0`.
16. **Tax exemption (D15).**
    - `orders` gains `tax_exempt`, `tax_exempt_reason`, `tax_exempt_reference`, `tax_exempt_by_user_id` and `tax_exempt_at`. They're set or cleared by `POST`/`DELETE /api/orders/{id}/tax-exemption` (`tax.exempt`, expected version).
    - Only an OPEN order with no OPEN settlement can change (the settlement guard already treats tax as an amount).
    - An exempt order's `tax_total` is zero. A tax-included item still has its included tax worked out and taken off (`included_tax_total`), but none is added back, so the guest pays the net price.
    - The reference refuses 13 or more consecutive digits (the card-safety rule).
    - Audit: `tax.exemption-set` and `tax.exemption-cleared`. Sales report: exempt sales section.
17. **Shared items (D16).**
    - `POST /api/orders/{id}/items/{itemId}/split` takes a share count (2–10), target orders (existing or new) per share, both versions and an idempotency key (scope `orders.split-item`).
    - Conditions: the item is SUBMITTED, not discounted, on an OPEN order of an ACTIVE session; no order involved has an OPEN settlement. Item discounts must be removed before a split.
    - Effects, in one transaction:
      - the original becomes `SPLIT` (new terminal status, allowed by the freeze trigger only alongside share rows written in the same transaction);
      - `order_item_shares` rows hold order, share number, share count, amount, tax snapshot copied from the original, and the original item;
      - totals and tax for each affected order include shares and leave out SPLIT items.
    - Kitchen work, consumption, modifier snapshots and voids stay with the original. A SPLIT item can't be voided; a share can be voided for money only, never touching stock.
    - Reports count the item once (from the original) and its sales from the shares, so item mix and net sales still agree.
    - Audit: `orders.item-split`. Outbox: `order.item-split`.
18. **Tip refunds (D17).**
    - `order_refunds.tip_amount NUMERIC(12,2) NOT NULL DEFAULT 0`, only above 0 for CASH or EXTERNAL_CARD. `amount` stays the non-tip refund, and either may be zero but not both.
    - Cumulative tip refunds can't exceed the order's recorded tender tips (`REFUND_EXCEEDS_TIPS`).
    - A tip refund is refused while the order's business date has a FINALIZED tip distribution (`TIP_DISTRIBUTION_FINALIZED`).
    - The tip pool subtracts recorded tip refunds of orders on that business date. Cash drawer expected cash subtracts cash tip refunds. The refund audit gains the tip amount.

### F. Labor and tips

19. **Daily overtime (D18).** `scheduling_rules.daily_overtime_threshold NUMERIC(5,2)` is nullable (0 < value ≤ 24), edited on the rules form. `allocateOvertime` first takes the hours past the daily threshold for each business date (latest work first), then applies the weekly threshold to the remaining regular hours. Reports and warnings use the combined result.
20. **Tip declarations (D19).**
    - `tip_declarations`: employee, location, business date, `amount NUMERIC(12,2) ≥ 0`, note, declared by, at, `version`; one per employee and date. Self declarations are allowed for an employee with time worked that date.
    - Changes check `version` and are refused while the date's tips are finalized.
    - The Tips report adds declared tips by employee. The pool never includes them.
    - Audit for manager declarations only (like punches).

### G. Loading, tests and tooling

21. **Loading (D20).** A shared `Skeleton` primitive, with `Suspense` boundaries around the data sections of the pages named in D20.
22. **Tests.**
    - The `migrations.test.ts` upgrade describe gets a 30 s timeout.
    - The E2E database is prepared before the web server starts (D21).
    - New browser tests: a stale-data conflict with the Reload button, and a tax-on check (own location, an included and an added rate, an exemption).
    - The flaky employees and restaurant specs are fixed by waiting on the data they need instead of on time.
23. **Housekeeping (D23).** Anchor root-only `.gitignore` rules. Nothing outside the repository changes without the owner's go-ahead.

### H. Permissions and boundaries

24. **Permissions.** One new code, 139 in all: `tax.exempt` (Owner, General Manager, Manager), seeded by an idempotent `security.service-polish-permissions` seed. Everything else reuses existing permissions.
25. **Rules 4, 6 and 7.** No Phase 20 path moves inventory. Splits, exemptions and tip refunds never change sent snapshots, consumption or tickets. Reports read snapshots and shares, never current configuration.
26. **Not payroll, not payments.** Daily overtime and declarations are business records. Nothing pays, withholds or processes money.

## Amendments decided at implementation

Recorded on 2026-11-11 while building. None changes a decision; each says how a policy was carried out.

1. **Existing notification writers stay where they are** (policy 13). The kitchen-ready and low-stock writers already write in their own transactions with their own unique keys, so they weren't moved. Every Phase 20 kind goes through the new `createNotifications`.
2. **Each kind's link is a CHECK constraint** (`notifications_link_matches_type`), not part of the guard trigger. The guard trigger freezes the new link and dedupe columns.
3. **Location settings audit uses a new `ORGANIZATION` audit category** (policy 6), added to the `audit_events` category CHECK in migration 0039.
4. **Whole-check void and shared items.** Voiding a whole check that holds a SPLIT item or any share is refused (`ORDER_HAS_SHARES`). Items and shares are voided one by one instead.
5. **Shared items in reports** (policy 17). A SPLIT item is counted once, on the check it was sent on, and its money is the sum of its ACTIVE shares, wherever they were settled.
6. **Daily overtime warning** (policy 19). The approaching line for the daily threshold is one hour (the weekly line stays four hours).
7. **The periodic check can be scoped** to a list of locations, and maintenance can skip it (`notify: false`). Tests use both; the runner always checks every active location.
8. **Loading boundaries** (policy 21) are on the report areas and the audit trail, the two pages that run long queries. The 86 board and the time clock refresh themselves on a timer, so a skeleton there would flash every refresh; they're left without one.

## 1. Objectives

Deliver policies 1–26, the migrations, the tests in sections 5–7, README, CLAUDE.md and User Guide updates, and `docs/Phase-20-Completion-Report.md`.

## 2. Scope Boundary

Out of scope (don't build):

- Reopening or changing a CLOSED check, or cancelling a completed settlement
- Payments, payroll and the README section 39 capabilities; SMS, email or push
- Recurring daypart menus or 86, auto-86 for modifiers, compound taxes, service charges, splitting a check evenly by amount
- Double time, meal-break compliance, tip payout
- Cloud deployment (on hold)

## 3. Review Existing Foundation Before Changes

Confirm from code before each step:

- `resolveSellableItem` and `getOperationalMenu` for the placement order and modifier filtering; `outage-service.ts` and the Phase 19 outage guards in `0038`.
- `sendOrderItems` (`src/workflows/submit-order/submit-order.ts`), `calculateOrderTax`, `order-repository.ts` totals, the `orders` CHECKs, the settlement guard and the `order_items_freeze` trigger.
- `moveOrderItems` and the transfer guard for the split design.
- `refund-service.ts`, `tip-service.ts` `readPoolTotals`, and the cash drawer expected-cash query.
- `allocateOvertime` and every caller (actual labor report, warnings).
- `seat-party.ts` hold handling and `session-service.ts` move and combine.
- `runMaintenance` and its advisory lock; the notifications guard trigger.
- The audit and outbox name CHECKs for the new action and event names.

If any conflicts with the policies, stop and explain before changing it.

## 4. Build Order

Migrations start at 0039. Each step generates its own migration (plus a custom one for triggers and constraints), reviewed before applying, and leaves lint, typecheck, unit and integration tests green.

1. **Tooling first:** migrations timeout, E2E database order, `.gitignore`, the location time formatter and `datetime-local` conversion, `Skeleton` and `Suspense`.
2. **Menu and stock:** category snapshot and reports, modifier 86, scheduled 86, running-low setting, the two audits, the chart.
3. **Floor:** the move and combine workflow.
4. **Notifications:** the new columns, the shared writer, schedule, swap and time-off writers, the maintenance pass.
5. **Tax:** tax included in price, then exemption, with the permission seed.
6. **Shared items.**
7. **Refunds and labor:** tip refunds, daily overtime, tip declarations, the break form.
8. **E2E, validation seed additions, documentation and the completion report.**

## 5. Unit Tests

- *Tax:* included tax extraction with rounding; mixed included and added groups; discounts on included items; exemption zeroes both kinds; `subtotal + tax_total = total_due` throughout.
- *Shares:* 2–10 shares by largest remainder; tax per share adds up to the original's.
- *Overtime:* daily only, weekly only, both without double counting, a business date across midnight, threshold null.
- *Sellability:* modifier 86, a required group emptied, scheduled start and end edges, an outage that has ended.
- *Notifications:* warning window edges, approaching-overtime line, missed clock-out by business date.
- *Formatting:* `formatInstant` across a daylight saving change; `datetime-local` to instant in the location zone.

## 6. Integration Tests

- **Menu:** the category snapshot at SEND and frozen after; reports by category, with older items as Uncategorized; a modifier 86 at one location only; scheduled 86 in effect only inside its window; overlapping outages refused; both new audits allow-listed.
- **Floor:** moving and combining onto a held table is refused, allowed with the override permission and reason, and the override is recorded.
- **Notifications:** one notification each for publish, swap and time off, rolled back with the change; a maintenance pass twice writes one notification per dedupe key; users at other locations and inactive users get nothing.
- **Tax:** an included rate at SEND; the settlement reconciles to `total_due`; an exemption is refused with an open settlement or without `tax.exempt`; a later rate change leaves sent items unchanged.
- **Shares:** splitting writes no ledger rows or tickets; totals across checks equal the original; retry with the same key changes nothing; a SPLIT item can't be voided or moved; reports count the item once.
- **Refunds:** a tip refund over the tips is refused; refused once tips are finalized; the pool and drawer subtract it.
- **Labor:** daily overtime in actual labor and warnings; declarations frozen when finalized; the break form's PATCH writes the Phase 18 audit.
- **Canonical scenario:** the Bacon Cheeseburger test passes unchanged.
- **Migrations:** reconstruction and the upgrade-from-Phase-19 checks; existing rows get the defaults above.

## 7. E2E Tests (Playwright)

- **New:** stale-data Reload; tax on (included, added, exemption) at its own location; modifier 86 and a scheduled 86 on the board and the order screen; split an item between two checks and settle both; a tip refund; a manager edits a break; the notification bell shows a published schedule.
- **Every existing spec** still passes, with the flaky ones fixed.

## 8. Documentation

- **README sections 11, 12, 14, 17, 19, 21 and 22:** the policies as built.
- **README section 33:** a "Phase 20 Service Polish and Deferred Features" note. **Section 36 and the CLAUDE.md phase list:** Phase 20, and the changed summaries (tax, overtime, notifications, menu).
- **Phase 17 and 18 plans:** amendments noting the superseded scope lines.
- **`docs/User-Guide.md`:** each new workflow.

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
- [ ] No inventory ledger row is written by any Phase 20 code path

## 10. Required Phase 20 Completion Report

Write `docs/Phase-20-Completion-Report.md`:

```text
PHASE 20 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Menu and stock (category snapshot, modifier and scheduled 86, threshold, audits, chart):
- Floor (held tables on move and combine):
- Time and time clock (location time, break form):
- Notifications (kinds, writers, maintenance pass):
- Checks (tax included, exemption, shared items, tip refunds):
- Labor and tips (daily overtime, declarations):
- Loading, tests and tooling:

Results
- Category snapshot frozen; reports by category: PASS / FAIL
- Modifier and scheduled 86 only where and when in effect: PASS / FAIL
- Held tables protected on move and combine: PASS / FAIL
- Notifications once per change or dedupe key: PASS / FAIL
- total_due = subtotal + tax_total with included tax and exemption: PASS / FAIL
- Shares add up; no ledger rows or tickets from a split: PASS / FAIL
- Tip refunds bounded and blocked once finalized: PASS / FAIL
- Overtime never counts an hour twice: PASS / FAIL
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
