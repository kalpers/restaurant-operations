# Phase 36: Events, Checklists, Food Safety, Supplier Invoices and Prix-Fixe Design and Implementation Plan

## Purpose

Owner request, 2026-11-23: build five of the six candidates from the Phase 34 and 35 reports in one phase. FIFO lot costing moves to Phase 37.

Owner decisions taken before this plan (2026-11-23):

- **One phase, five parts, built in this order:**
  1. opening, closing and side-work checklists;
  2. food-safety temperature logs;
  3. event and private-dining bookings;
  4. matching supplier invoices against receipts;
  5. prix-fixe and combo items.
- Each part is finished and checked (lint, typecheck, its unit and integration tests) before the next starts. The two simplest parts come first; the two that touch protected rules (receiving costs, SEND snapshots) come last.
- **FIFO lot costing is Phase 37.** Nothing in this phase changes how inventory is costed.

What already exists (reviewed 2026-11-23):

| Area | What is there | Where |
|---|---|---|
| Closest pattern for checklists and logs | Manager log: per organization `LOG-000123` counter row, append-only trigger with one redaction, idempotent add. Pre-shift notes: position targeting (relevance, not access), `version`, dashboard panel | `src/modules/restaurant/services/manager-log-service.ts`, `pre-shift-service.ts`, migrations 0074–0077 |
| Positions at a location | `employee_positions` per location; `findHeldPositionIds`, `findTargetPositions` | `src/modules/employees/queries/briefing-positions.ts` |
| Notifications | Kinds limited by `NOTIFICATION_TYPES` and the `notifications_type_valid` and `notifications_link_matches_type` checks; a new kind needs a link column | `src/db/schema/notifications.ts`, `src/modules/notifications/notification-writer.ts` |
| Reservations | Holds (`hold-intervals.ts`), planning conflicts (`findPlanningConflicts`), walk-in holds (`findActiveHolds`, "the one place a hold is decided"), at most 3 planned tables (`MAX_COMBINED_TABLES`), online pacing under a location advisory lock. No events, deposits, area booking or minimum spend | `src/modules/reservations/` |
| Areas and seating | `restaurant_areas` (DINING, BAR, TAKEOUT), no capacity or bookable flag; a session's tables share one area (`assertOneArea`) with no table-count limit at seating | `src/db/schema/organization.ts`, `src/modules/restaurant/services/seating-checks.ts` |
| Receiving | `purchase_order_receipts` and `_lines` (append-only), the actual unit cost entered at receipt (default: the PO price), weighted average updated at receipt, `supplier_item_cost_history` (`MANUAL` or `RECEIPT`), `supplier_reference` free text labelled "invoice or delivery number". There is no invoice table, and no ledger type changes cost without changing quantity | `src/modules/inventory/services/receiving-service.ts`, `rules/costing.ts`, `src/db/schema/inventory.ts` |
| Menu and SEND | One order item = one menu item = one recipe = one routing list. Modifiers can't be menu items. SEND snapshots price, modifiers, recipe, consumption, tax, category, allergens and price period; the freeze trigger lists every frozen column (latest in 0079). README section 14: "the architecture may later support multiple fulfillment components for a single composite menu item" | `src/workflows/submit-order/submit-order.ts`, `src/db/schema/orders.ts`, `src/modules/menu/queries/operational-menu.ts` |
| Kitchen | One ticket item per order item, station and attempt; courses held on the ticket | `src/modules/kitchen/services/ticket-generation.ts` |
| File storage | `FileStorageService`; the only user is employee documents (stored before the transaction and removed on failure, with a content and type policy) | `src/infrastructure/storage/`, `src/modules/employees/services/document-service.ts` |
| Erase search | Phase 34 searches "every free-text field staff type", with word-level `[redacted]` and `free_text_redactions` rows | `src/workflows/erase-guest/`, `src/modules/restaurant/queries/briefing-text-search.ts` |
| Audit | `AUDIT_CATEGORIES` mirrored in a database check; field names refused on forbidden words (including `rate`, `card`, `phone`, `email`, `address`) | `src/db/schema/auditing.ts`, `src/modules/auditing/rules/sanitize.ts` |

Latest migration: `0080`. This phase expects `0081` to `0090` (a generated migration and a custom `_guards` migration per part).

## Conflicts with the contract (for the owner's decision)

These are places where building what's asked needs the contract wording changed. Each has a matching decision below.

| # | Contract text | What this phase would need | Decision |
|---|---|---|---|
| C1 | CLAUDE.md "Table combos: max 3 tables, one area"; README section 13 | An event may hold a whole area or more than three tables in one area. Seating already has no table-count limit; only planning does. | D19 |
| C2 | Phase 34: the erase search covers "every free-text field staff type" | New free text: checklist notes, temperature corrective actions, event names and notes, invoice notes. Either they join the search or the promise is narrowed. | D4 |
| C3 | Phase 22: "deposits stay out" | Events usually take a deposit. | D22 |
| C4 | README section 16: inventory transaction types "are added deliberately in the phase that needs them" | Only if invoices were to correct inventory cost (D28 option B). The recommendation adds no type. | D28 |
| C5 | CLAUDE.md notification kinds list | One new kind, `TEMPERATURE_OUT_OF_RANGE`. | D14 |
| C6 | CLAUDE.md "Submitted order items store immutable price, modifier, recipe-ID and consumption snapshots" | Bundle components are ordinary order items with their own snapshots and a zero price; the parent carries the money. Nothing is loosened, but the freeze trigger gains columns. | D33 |

## Decisions for the owner

### All parts

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D1 | Scope? | **The five parts as below.** Out: FIFO costing (Phase 37), anything sensor-driven, accounts payable and supplier payments, event contracts and e-signatures, guest messages about events, nested bundles. | Keeps each part to what a restaurant does by hand today. |
| D2 | Owning modules? | **Checklists and temperature logs: Restaurant** (beside the manager log). **Events: Reservations** (an event is a planned Guest Party). **Invoices: Inventory** (beside receipts). **Bundles: Menu** (definitions) and **Orders** (sale). New workflows only where several domains meet: `seat-party` and the reservation planning checks read event blocks through a Reservations query; `submit-order` and `void-order-item` handle bundle components. | Follows existing ownership; no new module. |
| D3 | New permissions (10)? | `checklists.view`, `checklists.complete`, `checklists.manage`; `food-safety.view`, `food-safety.record`, `food-safety.manage`; `events.view`, `events.manage`; `purchasing.invoices.record`, `purchasing.invoices.approve`. Bundles use the existing `menu.edit` and `menu.pricing.edit`. Owner and GM get all of them through the role catalog. **Manager:** all except `purchasing.invoices.approve`. **Server, Bartender, Host, Wait staff:** checklists view and complete, `events.view`. **Cook:** checklists view and complete, food-safety view and record. **Bartender** also gets food-safety record. **Inventory manager:** `purchasing.invoices.record`, `food-safety.view`. Seeded as `security.phase-36-permissions`. | Approving an invoice confirms money owed, so by default it stays with Owner and GM, who can grant it to others. |
| D4 | New free text and the guest erase (C2)? | **Keep the Phase 34 promise: every new staff-typed field joins the erase search**, each where the eraser holds that kind's view permission (`checklists.view`, `food-safety.view`, `events.view`, `purchasing.view`). The guest's own event has its notes cleared outright and its name replaced with "Event EV-000123". Other fields get word-level `[redacted]` with a `free_text_redactions` row. The append-only temperature reading trigger accepts only that substitution, the Phase 34 way. Every new free-text field refuses 13 or more digits in a row (`CARD_DATA_REFUSED`), except the supplier's invoice number (D27). | The promise is simple and already made; narrowing it later would be harder to explain. The search framework already exists, so each field is a small addition. |
| D5 | Copying setup to a new location (Phase 23)? | **Checklist templates and temperature points are added to the optional copied setup**, since they are configuration. Never runs, readings, events or invoices. | Opening tasks and coolers are usually alike between locations. |
| D6 | Navigation? | **Service:** Checklists, Events. **Back of house:** Temperature log, Supplier invoices (under Purchasing). Bundles are edited on the existing menu item page. Dashboard panels: "Today's checklists" and "Temperature checks due". | Fits the five existing groups; no new group. |

### Part 1: Checklists

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D7 | Templates? | **Per location:** `checklist_templates` (name 1–80, kind `OPENING`, `CLOSING`, `SIDE_WORK` or `OTHER`, optional positions for relevance like pre-shift notes, `requires_sign_off`, active, `version`) and `checklist_template_items` (text 1–200, required, order, active). Deactivated, never deleted (trigger). `checklists.manage`. | Tasks differ by location. A constrained string, not an enum. |
| D8 | Runs? | **A run is started for the current business date** and copies the template's active items (`checklist_runs`, `checklist_run_items`). Later template edits never change a started run (rule 4). **Opening, closing and other kinds: one run per template, location and date. Side work: one run per template, employee and date** (each person's own). Previous dates are read-only. | A closing at 1 AM still belongs to the business date before a 4 AM cutoff, so the current date covers it. |
| D9 | Ticking items? | Each run item is done (who, when), skipped (who, when, reason 1–200) or open, with an optional note (1–500). Each run item has its own `version` (two people ticking at once don't conflict). Unticking is allowed while the run is OPEN by the person who ticked it or a `checklists.manage` holder. Ticks aren't audited. | Per-item versions match how a team works through a list together. |
| D10 | Finishing? | **Complete** (`checklists.complete`; a side-work run by its owner or a manager) is refused while a required item is open (`CHECKLIST_INCOMPLETE`). A template with `requires_sign_off` then waits for a manager's **sign-off** (`checklists.manage`, not the person who completed it). A completed run is frozen (trigger), and there is no reopen. Audit: `restaurant.checklist-completed`, `restaurant.checklist-signed-off`. | Sign-off covers the usual "manager checks side work before you clock out" without a new state machine. |
| D11 | Missed checklists? | **Worked out on read, never stored:** a run still OPEN after its date shows "Not completed", and a template with no run shows "Not started". History page: up to 31 days, filter by template and kind. No notifications. | No background job; history is read from what happened. |

### Part 2: Temperature logs

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D12 | What is checked? | **`temperature_points` per location:** name 1–80, kind `COLD_HOLDING`, `FROZEN`, `HOT_HOLDING`, `COOKING`, `COOLING`, `RECEIVING` or `OTHER`, a unit `F` or `C` fixed when created (default from a new location setting `temperature_unit`, `F`), an optional minimum and maximum, an optional check interval (30–1440 minutes), active, `version`. `food-safety.manage`. | A fixed unit per point means no conversion and no history changed by a setting change. |
| D13 | Readings? | **`temperature_readings` are append-only (trigger):** point, value `NUMERIC(5,1)`, unit, minimum and maximum copied from the point, `in_range` stored, `taken_at`, business date, recorder. An out-of-range reading needs a **corrective action** (1–500). A follow-up reading may name the reading it rechecks. A mistake is fixed by a new reading that names the one it corrects (the original stays, shown as corrected). Idempotent add (scope `restaurant.temperature-reading`). `food-safety.record`. | An inspection record must never be edited; this is the manager log's correction pattern. |
| D14 | Alerts (C5)? | **One new notification kind, `TEMPERATURE_OUT_OF_RANGE`**, written with the reading to `food-safety.manage` holders at the location (link column `temperature_reading_id`, dedupe key `temp:{readingId}`). **Overdue checks are shown, not notified:** "due" and "overdue" are worked out on read from the interval and the last reading, on the Temperature log page and a dashboard panel. | An out-of-range reading is a food-safety event someone must act on. Overdue reminders every hour would be noise. |
| D15 | Reports? | **Temperature log** page: one date or up to 31 days, filter by point and out-of-range only. **CSV export** (`food-safety.view` plus `reports.export`) for inspectors: every reading with point, value, unit, range, who, when, corrective action and correction links. | Inspectors ask for the log. |
| D16 | Not built | Sensors, Bluetooth thermometers, cooling-curve stages (135 to 70 to 41 °F) as linked steps, HACCP plans, pest logs. | Each is a design of its own. |

### Part 3: Events and private dining

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D17 | What is an event? | **`event_bookings` in Reservations:** an organization-wide number `EV-000123` (counter row), location, its own **Guest Party** (unique; the party holds the contact name, phone, email, guest count and allergies, so profiles, linking, consent and erase work unchanged), event name 1–120, `starts_at`, `ends_at`, setup and teardown minutes (0–480), notes 1–4000, menu notes 1–2000, an optional set-menu item (D24), `version`. | Guest Party is already the shared concept; a reservation and an event are two ways to plan one. |
| D18 | Statuses? | **`INQUIRY` → `TENTATIVE` → `CONFIRMED` → `COMPLETED`, or `CANCELLED`** (with reason) from any open state. `COMPLETED` is set when the event party's table session completes (the same way a reservation completes). INQUIRY blocks nothing; **TENTATIVE and CONFIRMED block the space.** | A tentative date is held while the guest decides; that's what tentative is for. |
| D19 | What is booked (C1)? | **A space:** `TABLES` (chosen tables in one area, any number, `event_booking_tables`), `AREA` (every active table in one area, worked out when checked) or `LOCATION` (a buyout). **Contract change:** "at most 3 tables" applies to reservation and waitlist planning; an event's space is its own kind of plan and isn't limited to 3. It stays within one area unless it is a buyout. | Private dining is usually a room or a section; one area keeps seating as one session (`assertOneArea`). |
| D20 | What does an event block? | **Block interval `[starts_at − setup, ends_at + teardown)`, half-open.** (a) Planning: a reservation or waitlist plan using a table in the space, or any reservation at all during a buyout, is refused `EVENT_CONFLICT`. (b) Moving an event to TENTATIVE or CONFIRMED, or changing its time or space, is refused `EVENT_CONFLICT` with the clashing reservations and events listed. No override: move them first. (c) **Seating:** seating another party on a space table during the block is refused `EVENT_HOLD_ACTIVE` unless the actor holds `reservations.override-hold` and gives a reason (recorded in `reservation_hold_overrides`, which gains a nullable `event_booking_id`). A buyout holds no tables, because its guests are seated normally. (d) **Online booking** offers no slot overlapping a buyout; table and area events don't change pacing (online bookings plan no tables). All checks run under the existing location lock. | The same half-open interval rule the contract uses for holds, added beside it, not mixed into it. |
| D21 | Seating the event? | **Ordinary `seat-party` with the event's party**, one table session on the space's tables (all must be free and CLEAN; one area). The event page links to the floor. | No new seating path. |
| D22 | Deposits (C3)? | **Record only, information only:** agreed deposit, amount received, date received and how (`CASH`, `EXTERNAL_CARD`, `OTHER`, plus a reference 1–80). No drawer, journal, tender or balance. When the event's check is settled, the deposit is entered as an ordinary `OTHER` tender "Event deposit EV-000123", so money is counted once, at settlement. **Contract change:** Phase 22's "deposits stay out" becomes "deposits are recorded as event information only". A deposit liability like gift cards would be a later phase. | Simple and honest: nothing claims to hold money it doesn't. |
| D23 | Minimum spend? | **An optional amount.** The event page shows the party's checks (subtotal before tax, OPEN and CLOSED) against it. No automatic fee: a shortfall is charged, if at all, as an ordinary item. No automatic service charge. | Service charges would be a new tax and tip question. |
| D24 | Set menu? | **An optional link to one active menu item** (typically a prix-fixe from part 5, any item until then) plus menu notes. Shown on the event sheet; servers still ring items normally. | Links the parts without making events depend on bundles being finished. |
| D25 | Screens and forecasts? | **Events page** (list by date range and status; create and edit with `events.manage`). A printable **event sheet** (times, space, guest count, contact for `guests.contact.view` holders only, allergies, menu, notes, deposit, minimum). Event blocks appear on the reservation book and the floor hold indicators. **The Phase 24 demand forecast counts TENTATIVE and CONFIRMED event guests as booked covers** in their start hour. Audit (category GUESTS): `reservations.event-created`, `-status-changed`, `-updated`, `-cancelled` (field names only). | Hosts must see events where they plan; staffing should see the covers. |
| D26 | Not built | Guest messages about events, contracts and signatures, multiple-room events, packages and pricing tiers, beverage counts, invoices to guests, catering off site. | Each is its own feature. |

### Part 4: Supplier invoices

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D27 | What is an invoice? | **`supplier_invoices` per location:** internal number `INV-000123` (per location, the PO numbering pattern), supplier, the supplier's invoice number (1–40, letters, digits, `-` and `/`, unique per supplier and location among non-voided invoices, **exempt from the card-digit check** because it's the supplier's document number), invoice date, optional due date, the supplier's stated total `NUMERIC(12,2)`, notes, status, `version`. | Matches how the paper arrives: one supplier, one document. |
| D28 | Does an invoice change inventory cost (C4)? | **Option A, recommended: no.** The cost entered at receiving stays the inventory cost. The invoice is a check against it, with variances shown and stored at approval. Nothing is written to the ledger, balances, average cost, supplier cost history or `last_unit_cost`. **Option B:** approval posts a new `COST_ADJUST` ledger type (quantity 0, value change) and re-averages stock on hand. That is a contract change (C4) and overlaps Phase 37's costing redesign. | Phase 37 is about to redesign costing; correcting cost now would be undone or reworked there. Receivers already enter the actual cost. |
| D29 | Lines and matching? | **Item lines each name one receipt line** (a receipt line is on at most one non-voided invoice line) with invoiced quantity (purchase units) and unit price. **Charge lines** have no receipt line: `FREIGHT`, `TAX`, `OTHER` and `CREDIT` (negative), each with a description. Lines must sum to the stated total before approval (`INVOICE_TOTAL_MISMATCH`). Per item line, worked out on read: quantity invoiced vs received, price invoiced vs receipt cost vs PO price. An invoice may cover receipts from several POs of the same supplier and location. | A three-way match a manager can read line by line. |
| D30 | Tolerance and approval? | **Statuses `DRAFT` → `APPROVED`, or `DISPUTED` (reason) → `APPROVED`; `VOIDED` (reason) from DRAFT or DISPUTED, and from APPROVED by an approver.** New location settings: `invoice_price_tolerance_percent` (default 2.00) and `invoice_price_tolerance_amount` (default 0.50 per unit); quantity has no tolerance. A line outside tolerance, or a quantity mismatch, can be approved only with a reason (`INVOICE_VARIANCE_REASON_REQUIRED`). **Approval stores each line's variance as it was** (append-only). Record and match: `purchasing.invoices.record`; approve, dispute, void: `purchasing.invoices.approve`. Prices need `inventory.cost.view` to see. Audit (INVENTORY): `inventory.invoice-approved`, `-disputed`, `-voided`. | Approving with a reason is how small differences are accepted without a correction. |
| D31 | Scanned copy? | **Optional, one file per invoice** through `FileStorageService` (PDF, PNG, JPEG, up to 10 MB, the employee document content checks), with a new storage factory and `SUPPLIER_INVOICE_STORAGE_PATH` read in `src/config/`. Stored before the transaction and removed if it fails, like employee documents. | Invoices are paper; a manager wants the image next to the match. |
| D32 | Reports and what's not built? | Inventory report sections **"Invoice variances"** (approved lines with quantity and price variance by supplier) and **"Received, not invoiced"** (receipt lines with no non-voided invoice, with age). Not built: payments, accounts payable, due-date reminders, journal lines, EDI, OCR, supplier credit tracking beyond `CREDIT` lines. | Information for the manager; accounting stays outside (README section 39). |

### Part 5: Prix-fixe and combo items

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D33 | How are they modelled (C6)? | **A bundle is a menu item with `item_kind = 'BUNDLE'`** (others are `STANDARD`). It has its own price (ordinary prices and happy hour), tax category and menu category, and **no recipe, routing or modifier groups**. It has **courses (slots)**: `menu_item_bundle_slots` (name, order, default course 1–5, minimum and maximum choices) and `menu_item_bundle_slot_options` (a STANDARD component item, upcharge `NUMERIC(12,2)` ≥ 0, default). **At sale, a bundle line is a parent order item plus one child order item per choice**: each child is an ordinary order item for the component with its own modifiers, recipe and consumption snapshot, allergen label, stations and course, **priced at zero**, with `bundle_parent_order_item_id`. The parent carries the money. Prix-fixe and combo are the same model; the label is just the item's name. | Every child keeps every existing snapshot, ticket and consumption rule, because it is an ordinary item. README section 14 already expects composite items. The alternative (components inside one order item) would break the one-ticket-item-per-order-item-per-station rule and the consumption snapshot shape. |
| D34 | Price? | **Parent unit price = bundle price + the chosen options' upcharges**, stored as `base_price_snapshot` plus `modifier_total_snapshot` (the existing check holds). The choices are snapshotted on `order_item_bundle_choices` (slot name, component name, upcharge, child id). **Component modifiers carry no price inside a bundle** (snapshotted at 0; a priced extra is offered as a slot option instead). Parent quantity is always 1 (four guests are four lines, each choosing). Children have zero prices and no tax (tax fields null), and `TAX_NOT_CONFIGURED` skips them. | One money line keeps checks, tax, shares, discounts, refunds and the journal as they are. |
| D35 | Sellability? | `getOperationalMenu` marks a bundle not sellable when a slot has fewer sellable options than its minimum, and hides 86'd or unsellable options. Components follow their own 86, auto-86, modifier 86 and availability. A component must be an active STANDARD item (no nested bundles), and it needn't be placed on a menu. | One sellability check, as the contract requires. |
| D36 | SEND, kitchen and courses? | A bundle draft is added and edited as a whole (parent plus child drafts), and the parent and its children are sent together, never apart (`BUNDLE_INCOMPLETE`). SEND runs the canonical steps for each child as for any item. The parent makes no ticket, writes no consumption and has no allergen label of its own. Child ticket items show the bundle's name (`bundle_name_snapshot`). Children take their slot's course (editable on the draft), so hold and fire work unchanged. The allergy check runs per child. | Nothing new in the kitchen. |
| D37 | Voids, comps, shares, moves, seats? | **Void the parent:** every sent child is voided with it (a disposition per child, each by its own kitchen state). **Void one child:** allowed (a guest skips dessert), with no money change. **Discounts and comps:** parent only (children refuse, `BUNDLE_COMPONENT`). **Shares:** the parent may be shared, and children stay with it (kitchen work and consumption already stay on the original). **Moves:** parent and children move together; a child alone is refused. **Seats:** a parent seat change moves its children; a child alone is refused. The freeze trigger adds the new columns, and an order item trigger refuses a child without its parent on the same order. | Keeps every money rule on one line and every kitchen rule on the components. |
| D38 | Reports? | **Item mix, menu engineering and menu performance show the bundle** with its revenue and its cost (the sum of its children's consumption). Children are left out of revenue rows and shown in a **"Bundle components"** breakdown (portions per component per bundle). **Forecasts and prep lists count children as portions** (they are real items), and parents add nothing (no recipe). Sales journal, tax, tips, server and void reports need no change (children are zero). | A zero-revenue component row would distort menu engineering; prep needs the components. |
| D39 | Canonical test? | **A new canonical bundle test** beside the Bacon Cheeseburger: "Burger Combo" (Bacon Cheeseburger with the canonical modifiers + Fries + Soda, upcharge for onion rings). It asserts parent price, child snapshots, the burger's consumption equal to the canonical one, one send batch, tickets per station, and that an idempotent retry adds nothing. **The existing canonical test stays unchanged.** | The canonical scenario is the contract's main check. |

## Approved Phase 36 Policies

Approved by the owner on 2026-11-23: D1–D40 as recommended, including the contract changes C1–C6. These are binding.

1. **Scope and ownership (D1, D2).** Five parts in the approved order; checklists and temperature logs in Restaurant, events in Reservations, invoices in Inventory, bundles in Menu and Orders. No FIFO costing, sensors, payables, event messages or nested bundles.
2. **Permissions (D3).** Ten new codes as listed in D3, seeded as `security.phase-36-permissions`; `purchasing.invoices.approve` only with Owner and GM by default.
3. **Erase (D4, C2).** Every new staff-typed free-text field joins the erase search under its kind's view permission, with word-level `[redacted]` and `free_text_redactions`; the guest's own event is cleared outright. New free text refuses 13+ digits in a row, except the supplier's invoice number.
4. **Setup copy and navigation (D5, D6).** Checklist templates and temperature points join the optional location setup copy; Checklists and Events in Service, Temperature log and Supplier invoices in Back of house; two dashboard panels.
5. **Checklists (D7–D11).** Per-location templates (deactivated, never deleted); runs for the current business date copy the active items; one run per template and date, or per template, employee and date for side work; per-item `version`; completion refused while a required item is open; optional sign-off by a different manager; completed runs frozen; missed status worked out on read; no notifications.
6. **Temperature logs (D12–D16).** Points per location with a fixed unit; append-only readings with copied range, stored `in_range`, required corrective action when out of range, follow-ups and corrections as new readings; idempotent add; `TEMPERATURE_OUT_OF_RANGE` to `food-safety.manage` holders written with the reading; overdue worked out on read only; log page and CSV export.
7. **Events (D17–D26, C1, C3).** `event_bookings` (`EV-000123`) with its own Guest Party; statuses INQUIRY, TENTATIVE, CONFIRMED, COMPLETED, CANCELLED; TENTATIVE and CONFIRMED block the space (tables in one area, a whole area, or a buyout) over `[start − setup, end + teardown)` for planning, waitlist, seating (override with `reservations.override-hold` and a reason) and, for a buyout, online booking; no override on event conflicts; seated through `seat-party`; deposits and minimum spend are information only; an optional set-menu item; event guests count as booked covers in the demand forecast.
8. **Supplier invoices (D27–D32, C4 not taken).** `INV-000123` per location; item lines name one receipt line each, plus charge lines; totals must match; variances worked out on read and stored at approval; tolerance location settings; approval outside tolerance needs a reason; **no ledger, balance, average cost or supplier cost history change**; optional scanned file through `FileStorageService`; two report sections.
9. **Bundles (D33–D39, C6).** `item_kind = 'BUNDLE'` with slots and options; a sale is a priced parent (quantity 1, price = bundle price + upcharges) and zero-price child order items with every ordinary snapshot; component modifiers priced at zero in a bundle; sellability in `getOperationalMenu`; parent and children sent, moved and seated together; a child may be voided alone; discounts on the parent only; reports show the bundle with its children's cost and a components breakdown; forecasts count children. The canonical Bacon Cheeseburger stays unchanged and a canonical Burger Combo test is added.
10. **Demo data (D40).** As listed in the build order.

## 1. Objectives

- Staff work through opening, closing and side-work checklists on a phone, and managers see what was done and what was missed.
- Kitchen staff record food-safety temperatures as an append-only log that an inspector can be shown, and out-of-range readings reach a manager.
- Hosts and managers plan private dining and buyouts as events that hold their space against reservations and walk-ins.
- Managers check supplier invoices line by line against what was received and ordered, and approve or dispute them.
- Servers sell prix-fixe menus and combos at one price, while each course reaches its own station and uses its own recipe.

## 2. Scope Boundary

In: everything in D1–D39 marked as built, the migrations, permissions, screens, tests and documentation.

Out: everything listed as not built in D16, D26 and D32, plus FIFO costing (Phase 37), cloud deployment (on hold), and any payment processing. No inventory cost changes (D28 option A).

## 3. Review Existing Foundation Before Changes

- Manager log and pre-shift notes (services, rules, triggers 0075 and 0077, the dashboard panel) as the pattern for parts 1 and 2.
- `notifications` schema and checks, `notification-writer.ts`, `notification-links.ts`.
- Reservations: `hold-intervals.ts`, `findPlanningConflicts`, `findActiveHolds`, `hold-service.ts`, `seat-party`, `move-table-session`, online slots and the location lock, `reservation_hold_overrides`, how a reservation becomes COMPLETED when its session ends, the Phase 24 booked-covers query.
- Erase-guest workflow, the Phase 34 search and redaction helpers, and `free_text_redactions`.
- Receiving service, receipts schema, purchasing rules, PO numbering, the inventory report sections.
- Employee document storage and policy.
- Menu schema, `getOperationalMenu`, `resolveMenuItemPrice`, draft item service, `submit-order`, `void-order-item`, `split-order-item`, `move-order-items`, seat changes, discounts, ticket generation, the `order_items` freeze trigger (0079), reports reading `order_items`, `forecast-items`.
- Location setup copy (Phase 23), the permission catalog and role catalog, the audit registry and its forbidden words.

## 4. Build Order

Each part ends with lint, typecheck and its own unit and integration tests passing before the next begins.

1. **Shared:** permissions and seed (D3), the `temperature_unit` and invoice tolerance location settings (migration with part 2 and part 4 respectively).
2. **Part 1 Checklists:** schema (0081), guards (0082: no delete, frozen completed runs), rules, services, API, Checklists page, history, dashboard panel, copy setup, erase search fields.
3. **Part 2 Temperature logs:** schema (0083) with the notification kind and link column, guards (0084: append-only readings with the redaction exception), services, API, Temperature log page, CSV export, dashboard panel, copy setup, erase search field.
4. **Part 3 Events:** schema (0085), guards (0086), event service and conflict checks wired into reservation and waitlist planning, holds, seat-party, online slots and the forecast's booked covers; Events page, event sheet, reservation book bands; erase.
5. **Part 4 Invoices:** schema (0087), guards (0088: approved variances append-only, one non-voided invoice line per receipt line), storage factory and config, services, API, invoice pages under Purchasing, report sections; erase search field.
6. **Part 5 Bundles:** schema (0089: `item_kind`, slots, options, order item bundle columns, `order_item_bundle_choices`), guards (0090: freeze trigger update, parent and child integrity), menu editor, operational menu, draft add and edit, SEND, voids, moves, seats, discounts, shares, kitchen display, reports, order screen picker, the canonical bundle test.
7. Demo data (D40 below), documentation, full validation, completion report.

**D40 (demo data):** `db:seed:demo` adds, while MAIN has none of each: an opening, a closing and a server side-work template with today's runs part done; four temperature points with two days of readings (one out of range with its corrective action and follow-up); one confirmed private-dining event next Saturday in a section and one inquiry; two invoices (one approved with a small price variance, one disputed); a "Pizza Night for Two" prix-fixe (starter, two pizzas, dessert) and a lunch combo. Recommended: yes.

## 5. Unit Tests

- Checklists: run copy of items, required items and completion, sign-off by someone else, missed status on read.
- Temperatures: in-range rule with only a minimum, only a maximum or both; unit fixed per point; overdue on read from the interval; card-digit refusal in corrective actions.
- Events: block interval maths (half-open, setup and teardown), space resolution (tables, area, buyout), status transitions, conflict listing.
- Invoices: line sums, tolerance by percent and by amount, quantity mismatch, variance snapshot values.
- Bundles: slot choice validation (minimum, maximum, options), parent price from upcharges, component modifier price zeroed, sellability from slots, report cost rollup.

## 6. Integration Tests

- **Checklists:** run per template and date, side work per employee and date, concurrent ticks on different items, untick rules, completion refused while required items are open, frozen after completion, sign-off, permission checks, copy setup, erase redaction of notes.
- **Temperatures:** readings append-only (update and delete refused), corrections and follow-ups, out-of-range needs a corrective action and notifies `food-safety.manage` holders once, idempotent retry adds nothing, CSV export permission, erase redaction through `free_text_redactions` only.
- **Events:** planning, waitlist and online-booking conflicts, walk-in holds with and without override, buyout blocking reservations and online slots, event status change refused on conflict, seating through `seat-party`, COMPLETED when the session ends, deposit recorded with no drawer or journal effect, minimum spend shown, demand forecast covers, erase of the event's own fields and of mentions elsewhere.
- **Invoices:** one invoice across two POs, a receipt line on two invoices refused, total mismatch refused, approval with and without variance reason, stored variances, dispute and void rules, **no ledger, balance, average cost or supplier cost history change**, file stored outside the transaction and removed on failure, permissions including `inventory.cost.view`, report sections.
- **Bundles:** the canonical Burger Combo (D39) including the idempotent retry; parent and children sent together only; per-child allergy acknowledgment; course hold and fire per child; void parent and void child alone; parent-only discounts; shared parent; move and seat cascade; freeze trigger refuses changes to every new column; operational menu with an 86'd option and an unfillable slot; reports and forecasts per D38.
- **Unchanged:** the canonical Bacon Cheeseburger and its idempotent retry; the existing reservation, receiving, order and report suites.
- Migration reconstruction and upgrade tests over a database with existing data.

## 7. E2E Tests (Playwright)

- `checklists.spec.ts`: a server ticks side work and completes it; a manager signs off; history shows it.
- `temperature-log.spec.ts`: a cook records an in-range and an out-of-range reading with a corrective action; the manager sees the notification and the log.
- `events.spec.ts`: a manager books a section for an event; a reservation on one of its tables at that time is refused; the host seats the event party.
- `supplier-invoices.spec.ts`: enter an invoice against a receipt, see a price variance, approve with a reason.
- `prix-fixe.spec.ts`: a server adds a prix-fixe, chooses each course, sends; the kitchen sees each course at its station; the check shows one price.
- Existing specs pass unchanged in CI mode.

## 8. Documentation

- README: new tables and policies in sections 12 (checklists, temperatures), 13 (events), 14 (bundles), 16 (invoices), 17 (bundle order items), 18 (bundle tickets), 21 (report sections), 22 (the new notification kind), 33 and 36 (Phase 36 entries); the C1 and C3 wording changes.
- CLAUDE.md: the table-combo line (C1), the notification kinds list (C5), the Phase 22 deposits line (C3), short Phase 36 policy lines, Phase 36 in the phase list.
- `.env.example` and `docs/Cloud-Deployment-Guide.md`: `SUPPLIER_INVOICE_STORAGE_PATH`.
- `docs/User-Guide.md` is a historical reference and is not changed.
- `docs/Phase-36-Completion-Report.md`.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first)
- [ ] `npm run build` with no new warnings
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] Migrations 0081–0090 reviewed; `npm run db:generate` then reports no changes; migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicates (permission count up by 10); `db:seed:demo` and `db:seed:validation` twice create no duplicates
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] Canonical Bacon Cheeseburger, including the idempotent retry, passes unchanged; canonical Burger Combo passes
- [ ] No new free-text field is missing from the erase search (a test lists them)
- [ ] Invoices change no ledger row, balance, average cost or supplier cost history

## 10. Risks

- **Size.** Five features in one phase. Building and checking part by part limits it, but the phase will take several sessions, and the build order can stop after any part if needed.
- **Bundles touch SEND, voids, moves, shares, seats and the freeze trigger.** Every one of those has existing tests that must stay green; the freeze trigger change needs its own tests.
- **Events add a second kind of hold.** A missed call site would let a reservation onto an event table. The checks go in the one hold query and the one planning-conflict query, with a test per entry point (plan, waitlist, seat, move, online).
- **Invoices don't correct cost** (D28 A). Average cost stays as entered at receipt until Phase 37 decides how costs are corrected.
- **Deposits are information only** (D22). A deposit taken but never entered as a tender at settlement is invisible to the money reports.
- **The erase search grows** with each new field; a field added later without joining it would break the Phase 34 promise. A test lists every free-text column.

## 11. Required Phase 36 Completion Report

Write `docs/Phase-36-Completion-Report.md`:

```text
PHASE 36 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Checklists:
- Temperature logs:
- Events and private dining:
- Supplier invoices:
- Prix-fixe and combo items:
- Erase search additions:

Results
- Completed checklists and temperature readings can't be changed (except erase redaction): PASS / FAIL
- Out-of-range readings need a corrective action and notify once: PASS / FAIL
- Events block planning, waitlist, seating and online booking in their space and interval: PASS / FAIL
- Invoices change no ledger, balance or cost: PASS / FAIL
- Bundles: one money line, components with their own snapshots, tickets and consumption: PASS / FAIL
- Canonical Bacon Cheeseburger and idempotent retry unchanged; canonical Burger Combo passes: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e CI, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
