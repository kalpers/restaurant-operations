# Phase 23: Multiple Locations and Ingredient Lots Design and Implementation Plan

## Purpose

Phase 23 builds the third README section 39 group, chosen by the owner on 2026-11-12:

- **Multiple active locations.** Open a second (and later) location from inside the app, copying setup from an existing one; deactivate and reactivate a location; a location switcher that can't act at the wrong location; reports across locations; and transfers between locations as a proper record that ships from one location and is received at the other.
- **Ingredient lots and expiry.** Opt-in lot tracking per inventory item: each receipt creates a lot with an optional supplier lot code and expiry date, outgoing stock is taken first-expiring-first, lots travel with transfers, expiring lots raise an in-app warning, and a trace shows which orders used a lot.
- **Phase 22 leftovers.** The reservations board refreshes on the online booking and guest cancel events instead of every 30 seconds, and the dev-server E2E run stops failing on first-request compiles. A real SMTP or Twilio send stays a manual check for the owner, since it needs their accounts.

Left out on purpose:

- FIFO or lot-based costing (cost stays weighted average, D10)
- a central kitchen or commissary, production recipes and inter-location ordering or invoicing
- per-location menus beyond what already exists (prices, prep routing, 86 and tax rates are already per location)
- several currencies or several organizations per installation
- employees shared across locations beyond what exists (employee locations and per-location role grants already exist)
- delivery, loyalty, forecasting (group 4), accounting and payroll integrations
- cloud deployment (on hold)

What exists today (checked against the code on 2026-11-12):

- **Locations.** `locations` (code unique per organization, own time zone), `location_settings` (one row each), `restaurant_areas`. `organization-service.ts` can list, update and change settings of locations, but **nothing creates one**: the first location (`MAIN`) comes from the organization seed and `bootstrap:owner`. Tests create extra locations with fixtures.
- **Per-location configuration already in the model:** menu prices (`menu_item_prices.location_id`), prep stations and `menu_item_prep_routing`, the 86 list, tax rates, stocked items (`inventory_item_locations` with par and reorder levels), `scheduling_rules`, tip pool rules, cash drawers, online booking settings and hours, tables and server sections. Menu items, recipes, inventory items, suppliers, roles and guest profiles are organization-wide.
- **Access.** `user_roles` grants a role **at a location**. The auth context lists only active locations. `resolveCurrentLocation` reads the `restaurant_ops_location` cookie and falls back to the first authorized location. `assignRole` grants at the actor's current location, but the Users page lists only users already at that location, so there is no way in the UI to give an existing person access to a second location.
- **Switcher.** `LocationSwitcher` (shown only with two or more locations) sets the cookie through `PUT /api/session/location` and refreshes the page. The cookie is per browser, so a second tab still showing location A would act at location B. The realtime stream subscribes with the location it had when it opened and keeps it until it reconnects (up to 5 minutes).
- **Realtime.** The hub filters events by location. Good.
- **Reports.** Every report and the dashboard run for one location and require `actor.locationId === filters.locationId`. Business dates come from each location's own clock.
- **Transfers.** `transferStock` moves one item in one transaction (`TRANSFER_OUT` + `TRANSFER_IN`, a random shared reference, average cost carried), and the actor needs `inventory.transfer` at both locations. There is no transfer record, number, multi-line transfer or in-transit state.
- **Inventory.** One posting service writes the ledger and balance. Waste already has the reason `EXPIRED`. Nothing knows about lots or expiry dates.
- **Phase 22 leftovers.** `reservations-board.tsx` calls `router.refresh()` every 30 s; the realtime provider already lists `reservation.online-booked` and `reservation.guest-cancelled`, but the board doesn't listen. Under `next dev`, about 12 of 159 E2E tests fail on a first run because a route compiles slower than the 5 s assertion wait.

It changes these written contract points, which the owner approves with this plan:

- **README section 8:** "The initial system has one location" becomes "locations are created in the app". Creating and deactivating a location become documented operations.
- **README section 16:** transfers become a `inventory_transfers` record that is sent, then received; a pair may now be separated in time (stock is in transit between the two legs). A new adjustment reason, `TRANSFER_SHORTAGE`. Lots and their movements join the Inventory tables as a sub-ledger of the authoritative ledger.
- **README section 21:** reports gain an "All my locations" view.
- **README section 22 and CLAUDE.md "Notifications":** a new in-app kind, `LOT_EXPIRING`.
- **README section 39:** "Multiple active restaurant locations" and "Ingredient lots/FIFO/expiration-by-lot" are built (FIFO for quantity, not for cost).
- **CLAUDE.md:** the Phase 23 line, and short location and lot policies in "Key domain policies".

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially sections 8, 9, 16, 21, 22, 24, 25 and the Phase 2, 8, 9, 12 and 19 notes in section 33.
2. Read the Phase 2, 8, 12 and 19 plans and completion reports. Phase 8 is the model for the posting service, transfers and counts; Phase 19 for in-app notifications from the maintenance run.
3. Read `docs/accepted-risks.md`. No new dependency is planned.

## Decisions for the owner

Approved by the owner on 2026-11-12 as recommended. The policies below follow them.

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | How is a new location created? | **A "New location" form on Admin → Locations**, under a new permission `locations.lifecycle` (Owner and General Manager). It takes name, code, time zone, address and phone, and in one transaction creates the location, its `location_settings` (defaults), the three standard areas, its `scheduling_rules` row, and online booking settings (off). The creator is given **the same roles they hold at the location they're working at**, at the new location, so someone can work there at once; nobody else gets access until granted. | The app has no way to open a second location today. Copying the creator's own roles gives nobody more than they already have, and is audited. |
| D2 | What can be copied from an existing location? | **"Copy setup from" an existing location, with groups to tick:** location settings (cutoff, reservation defaults, negative-stock rule, running-low threshold, drawer rule); prep stations and menu prep routing; menu prices (the prices in effect today, starting today); tax rates; stocked items with par, reorder level and preferred supplier (no stock); scheduling rules; tip pool rules; online booking hours (booking stays off). **Never copied:** tables, sections, staff and grants, employee locations, stock, drawers, schedules, reservations, orders, 86 entries. All in the same transaction as D1. | Setting a location up by hand means re-entering every price and route. Copying operational history or staff would be wrong; copying configuration is safe and saves hours. |
| D3 | How is a location closed? | **Deactivate, never delete**, under `locations.lifecycle`. Refused while the location has an open order, an active table session, an open settlement, an open drawer session, a sent transfer not yet received (either direction), or a submitted purchase order not fully received, and refused for the last active location. Deactivating turns off its online booking. A deactivated location disappears from everyone's switcher and grants (the auth context already ignores inactive locations); its history stays in reports for people who had report access there and still have it at an active location (policy 7; D6 marks it inactive). **Reactivate** restores it as it was. | Rule "configurable records are deactivated". The refusals stop money, stock or guests being stranded at a closed location. |
| D4 | How does the switcher stay safe with several tabs? | **Every page knows its location, and every write says which one it means.** The app shell puts the page's location ID in the client; `sendApiRequest` and `sendFormData` (and the dozen direct `fetch` calls, moved onto them) send it as the `X-Location-Id` header. The guards compare it with the cookie's location: a mismatch is refused with 409 `LOCATION_CHANGED` ("You switched location in another tab. Reload to continue.") before anything runs. The header never grants anything; access is still checked from the database. Switching also reconnects the realtime stream. The switcher shows the current location's name in the header even with one location. | Without this, a server in tab A could send an order to location B's kitchen after a manager switched in tab B. A header check is small and keeps the cookie design. |
| D5 | How does someone get access to a second location? | **"Add an existing person" on Admin → Users**: pick any active user of the organization and a role to grant at this location. Uses the existing `assignRole` and its checks (`admin.users.manage`, no granting a role above your own). Employees' work locations stay on the employee page (`employees.locations.manage`), separate from software access (rule 3). | The grant already works server-side; only the UI can't find the person. |
| D6 | What do cross-location reports show? | **"All my locations" in each report area's location picker**, listed only for users who hold that area's permission at two or more active locations. It shows one row per location where they hold it (others are left out and named in a note) plus a total, for each area's **summary figures**: sales (net sales, tax, discounts, comps, checks, covers), settlements and tenders, orders, labor (hours; cost only with `hr.compensation.view` at every included location, else cost is hidden for all), inventory (valuation needs `inventory.cost.view`, waste, variance), seating and fulfillment. Each location's figures use **its own business dates** for the chosen range. Averages and percentages in the total are worked out from the summed figures, never averaged. CSV export as today. Detail sections (item mix, by hour, by server) stay per location. The Overview dashboard gets the same comparison strip for today. | Owners of two restaurants want them side by side. Running the existing per-location summary queries once per location reuses tested code and keeps business-date rules exact, at a cost that's fine for a few locations. |
| D7 | How do transfers work? | **A transfer record, `DRAFT → SENT → RECEIVED`, numbered per sending location (`TR-000001`).** The sender adds lines (item, quantity in any convertible unit) and sends: `TRANSFER_OUT` posts for every line at the sender, with each line's average cost frozen on the line. The stock is then **in transit**, shown on both locations' inventory pages. The receiver receives the whole transfer: `TRANSFER_IN` posts the full sent quantity at the frozen cost, and if less arrived, the shortfall posts at once as `ADJUST_DECREASE` with the new reason `TRANSFER_SHORTAGE`. A draft can be cancelled; a sent transfer can't (send a transfer back instead). Sending needs `inventory.transfer` at the sender, receiving at the receiver. **"Send and receive now"** keeps today's one-step move for someone with the permission at both. | A van between two restaurants is the normal case, and the receiver should confirm what arrived. Posting the full pair and then the shortage keeps the README rule that a pair nets to zero and makes every loss visible in the ledger. |
| D8 | Which items are lot tracked? | **Opt-in per inventory item** (`inventory_items.lot_tracked`), switched on under `inventory.configure`. Turning it on creates an **opening lot** at every location with stock on hand (no code, no expiry, received "before tracking"). Turning it off is refused while any lot of the item has stock left. Items not lot tracked work exactly as today. | Lots matter for dairy, meat and fish, not for napkins. Opt-in keeps receiving quick for everything else. |
| D9 | In what order does stock leave lots? | **First to expire, first out (FEFO):** earliest expiry first, lots without expiry after dated ones, then oldest received, then lot number. This applies to `CONSUME` at SEND and remakes, `WASTE`, `ADJUST_DECREASE`, `COUNT_DECREASE` and `TRANSFER_OUT`. **Waste, adjustments and transfers may name a lot instead** (for example "throw out lot L-0042"). Expired lots aren't skipped: the system records what the kitchen most likely used, and expiry is handled by warnings and waste (D13). | FEFO is what food safety rules ask kitchens to do, and plain FIFO is the tie-break. Refusing a SEND because a lot expired would block service over bookkeeping. |
| D10 | Does cost change to FIFO? | **No. Cost stays weighted average** (README section 16, rule 4). A lot records its receipt's base-unit cost for information and for the trace, but valuation, consumption cost and every report keep using the ledger's average. | Changing the costing method would change every historical cost report and the Phase 8 rules. Lot cost can be shown without that. |
| D11 | How do lots fit the ledger? | **Lots are a sub-ledger of the ledger, written by the same posting service in the same transaction.** `inventory_lots` (per item and location: lot number `L-000001` per location, supplier lot code, expiry date, received date, origin `RECEIPT`, `TRANSFER`, `OPENING`, `FOUND`, quantity remaining) and `inventory_lot_movements` (append-only: ledger row, lot, signed base quantity). For a lot-tracked item, every ledger row's movements sum to its quantity, and the lots' remaining stock sums to the balance whenever the balance is zero or above. Increases: `RECEIVE` creates a lot from the receipt line; `TRANSFER_IN` recreates the sent lots (same code and expiry, linked to the source lot); `SALE_REVERSAL` returns to exactly the lots its `CONSUME` took from; `ADJUST_INCREASE` and `COUNT_INCREASE` create a `FOUND` lot (expiry may be entered). `reconcileBalances` also checks lots. | Keeps "the ledger is authoritative" true: lots never move without a ledger row, and no second path writes stock. |
| D12 | What about negative stock? | Where a location allows it, a `CONSUME` can take more than the lots hold. The part with no lot is recorded as an **unallocated movement** (no lot). The next increase first covers that shortfall (an allocation to the new lot, linked to the shortfall), so the lot sums match the balance again once it's back at zero or above. | Phase 8 allows `CONSUME` to go negative; lots can't. This keeps both rules without refusing SEND. |
| D13 | How are expiring lots surfaced? | **In-app notification `LOT_EXPIRING`** from the hourly maintenance run, once per lot (dedupe key), when a lot with stock left is within the location's `lot_expiry_warning_days` (new setting, default 2, 0 turns it off) or has expired, to holders of `inventory.adjust` at the location. The inventory page gets an "Expiring and expired" list with a **Waste lot** action (reason `EXPIRED`, the whole remaining quantity, that lot). | Staff need to know before the walk-in is full of expired stock. It reuses the Phase 19 notification path. |
| D14 | Can a lot be traced? | **Yes, a lot trace in the Inventory report area** (`reports.inventory`): a lot's receipt (supplier, PO number), every movement, the transfers it travelled through, and the orders that consumed it (order number, business date, item name), with CSV export. No guest names or contact details. | The point of lots is answering "which plates got the recalled cheese". The data is already in the movements and the order item snapshots. |
| D15 | Are counts done per lot? | **No, counts stay per item.** A count decrease is taken FEFO (D9); an increase becomes a `FOUND` lot. A lot's code or expiry can be **corrected** under `inventory.adjust` with a reason, audited with before and after; its quantity can only change through postings. | Counting every lot doubles the count work. Corrections cover a mistyped expiry without editing history. |
| D16 | Where do the Phase 22 leftovers go, and what fixes the dev E2E flakes? | **As the first build step.** The reservations board subscribes to `reservation.online-booked`, `reservation.guest-cancelled` and the existing reservation events and refreshes on them; the 30 s timer stays only as a fallback while the stream is disconnected (as the floor board does). **Dev E2E:** after `next dev` is ready, the E2E web server helper requests every page and API route under `src/app` once (a warm-up list built from the file tree), so each compiles before the first test; the run is then checked twice against the dev server. The real SMTP or Twilio send stays on the owner's list. | Small and already approved as leftovers. Warming routes removes the cause instead of raising every timeout. |
| D17 | Seed data? | **The base seed stays one location.** The opt-in demo seed (`db:seed:demo`) adds a second location, `UPTOWN`, copied from `MAIN` with D2, a few staff granted there, two lot-tracked items with lots, and one received transfer. The validation seed gains a lot-tracked item and a received transfer. Both idempotent. | Developers can see the multi-location screens without slowing down every test database. |

## Approved Phase 23 Policies

Binding since the owner approved D1–D17 on 2026-11-12. Numbers are for reference in the build and the report.

### A. Locations

1. **Create (D1).**
   - `createLocation` in `src/modules/organization/services/location-lifecycle-service.ts`, under `locations.lifecycle` at the actor's location. Input validated by Zod (code `^[A-Z0-9]{2,12}$`, unique per organization, refused with `LOCATION_CODE_TAKEN`; time zone must be a valid IANA zone).
   - One transaction: the location, `location_settings`, the areas Dining Room, Bar and Takeout, `scheduling_rules`, `online_booking_settings` (`enabled = false`), the creator's role copies, audit `locations.created`, outbox `location.created`.
   - Each module creates its own rows through a function it exports (`createDefaultSchedulingRules`, `createDefaultOnlineBookingSettings`, …); Organization calls them through `src/workflows/open-location/`. Organization doesn't write other modules' tables.
2. **Copy setup (D2).**
   - Optional `copyFrom: { locationId, groups[] }`, with the source in the same organization and the actor holding `locations.view` there.
   - Groups: `SETTINGS`, `STATIONS_AND_ROUTING`, `PRICES`, `TAX_RATES`, `STOCKED_ITEMS`, `SCHEDULING_RULES`, `TIP_POOL_RULES`, `BOOKING_HOURS`. Routing needs the stations, so they are one group; prices don't depend on it.
   - Prices: the source's price rows in effect at the moment of creation, as new rows starting then with no end. Tax rates: the rates in effect, starting then. Each copy is done by the owning module's function, inside the workflow's transaction.
   - The audit row lists the groups copied and the source location, not the rows.
3. **Deactivate and reactivate (D3).**
   - `deactivateLocation` and `reactivateLocation`, under `locations.lifecycle`, with the location's `version` (409 on mismatch).
   - Refusals (`LOCATION_HAS_OPEN_WORK`, naming what is open; `LAST_ACTIVE_LOCATION`), checked in the transaction with the location row locked. Each module answers its own "anything open here?" question through an exported query.
   - Deactivating sets `active = false`, turns off online booking, and is audited. Reactivating sets `active = true` and leaves online booking off.
   - A user whose only locations are inactive can still sign in and sees "You don't have access to any active location" (the existing access-denied page).
4. **Switcher and location header (D4).**
   - The `(app)` layout passes the current location ID to a small client context. `sendApiRequest`, `sendFormData` and a new `fetchJson` add `X-Location-Id`. The twelve direct `fetch` calls in components move onto these helpers (the public booking and manage pages keep plain `fetch`: no header, no session).
   - `requireCurrentUser` callers resolve the location through one function, `resolveRequestLocation`, which compares the header with the cookie's location and throws `ConflictError("LOCATION_CHANGED")` on a mismatch. A request with no header (server components, scripts, tests) uses the cookie as today.
   - The client shows a "Location changed in another tab" banner with Reload on `LOCATION_CHANGED`.
   - `RealtimeProvider` takes the location ID as a key, so switching closes the old stream and opens a new one.
   - The switcher shows the location name always, and the select only with two or more.
5. **Access at a second location (D5).** Admin → Users gets "Add an existing person": a search over the organization's active users not yet at this location (name and email; `admin.users.manage`), then the role picker. It calls the existing assign API.
6. **Permissions.** One new code, `locations.lifecycle` ("Create, deactivate and reactivate locations"), granted to Owner and General Manager by a `security.locations-lots-permissions` seed. **149 in all.** `locations.manage` keeps editing a location's details and areas.

### B. Reports across locations

7. **Scope (D6).**
   - Report filters accept `locationId` or `scope=ALL`. For `ALL`, the service lists the actor's active locations where they hold the area's permission (re-resolved from the database, like every request); fewer than two is refused with `NOT_ENOUGH_LOCATIONS`.
   - Each area exports one `summarize<Area>(tx, filters)` function built from the summary queries it already runs. The cross-location runner calls it per location inside one read-only transaction and adds a total row (sums; ratios recomputed from sums).
   - Cost columns follow the existing rules per location; if any included location lacks the cost permission, cost is hidden for every row and the total, with a note.
   - **Closed locations stay reportable.** The auth context ignores grants at inactive locations, so reports add one narrow rule: an inactive location is included (marked inactive) when the actor's role assignment there is still active and that role grants the area's permission, and the actor holds the same permission at an active location of the organization. Those grants count for reading reports only, nowhere else.
8. **Dashboard.** The Overview page shows a "Today at all my locations" strip (net sales, checks, covers, open checks, seated parties) when the user holds `reports.view` at two or more locations. Each location's "today" is its own current business date.
9. **Export.** CSV for the cross-location view: one row per location plus the total, with the location code and the business date range used for each.

### C. Transfers

10. **Records (D7).**
    - `inventory_transfers` (Inventory): organization, `from_location_id`, `to_location_id` (different, same organization), `transfer_number` (per sending location, `TR-000001`), `status` (`DRAFT`, `SENT`, `RECEIVED`, `CANCELLED`), notes, `created_by_user_id`, `sent_at`/`sent_by_user_id`, `received_at`/`received_by_user_id`, `cancelled_at`/`cancelled_by_user_id`, `version`. CHECKs tie each status to its timestamps.
    - `inventory_transfer_lines`: transfer, item, entered quantity and unit, `base_quantity`, `unit_cost_sent` (frozen at send), `base_quantity_received` (at receipt, between 0 and sent), lot detail through the lot movements.
    - Lines change only while `DRAFT`. A guard trigger refuses changing a sent line's quantities and moving status backwards.
11. **Send.** One transaction: lock the transfer (version), check `inventory.transfer` at the sender and that both locations stock every item and are active, post `TRANSFER_OUT` per line (reference `INVENTORY_TRANSFER`, the transfer ID) through the posting service, freeze each line's cost, set `SENT`, audit, outbox `inventory.transfer-sent` to the receiving location, in-app notification is **not** sent (the inventory page shows incoming transfers).
12. **Receive.** One transaction at the receiving location: check `inventory.transfer` there, lock, post `TRANSFER_IN` for the full sent quantity at the frozen cost, then `ADJUST_DECREASE` reason `TRANSFER_SHORTAGE` for each line's shortfall (notes name the transfer number), set `RECEIVED`, audit, outbox. Received quantities can't exceed sent; receiving is all lines at once.
13. **One-step.** "Send and receive now" runs send and receive in one transaction for an actor with `inventory.transfer` at both, with no shortfall. The existing `POST /api/inventory/transfers` keeps working through it, so the Phase 8 tests pass unchanged except for the new transfer record they now create.
14. **In transit.** Both locations' inventory pages list sent, unreceived transfers. The inventory valuation report shows in-transit value as its own line at the sending location (sent cost), so value isn't lost between the legs. The Phase 8 transfer form becomes the transfer list and editor.
15. **Idempotency.** Send and receive take a client idempotency key (rule 9); a retry returns the first outcome with no second posting.

### D. Lots

16. **Tables (D8, D11).**
    - `inventory_items.lot_tracked` (boolean, default false).
    - `inventory_lots`: organization, location, item, `lot_number` (per location, `L-000001`), `supplier_lot_code` (optional, 64 characters), `expires_on` (DATE, optional), `received_on` (DATE, the business date it arrived), `origin` (`RECEIPT`, `TRANSFER`, `OPENING`, `FOUND`), `source_lot_id` (for `TRANSFER`), `receipt_line_id` (for `RECEIPT`), `unit_cost` (the base-unit cost it arrived at, information only), `quantity_received`, `quantity_remaining` (≥ 0), `version`, `created_at`. Index on location, item and the FEFO order.
    - `inventory_lot_movements`: append-only (trigger), `inventory_transaction_id`, `lot_id` (null for an unallocated shortfall, D12), `base_quantity_delta` (signed like the ledger, non-zero), `settles_movement_id` (an increase covering an earlier shortfall), `created_at`.
    - A deferred constraint trigger checks, at commit, that for each new lot-tracked ledger row the movements sum to its `base_quantity_delta`.
17. **Posting (D9, D11, D12).**
    - `postInventoryTransaction` gains an optional `lot` input (`{ lotId }` to name a lot for decreases; `{ supplierLotCode, expiresOn }` for increases that create one). For a lot-tracked item, it locks the item's lots at the location (`FOR UPDATE`, in FEFO order) after the balance lock, allocates, and writes the movements and lot quantities, all before returning. For other items it does nothing new.
    - Allocation is a pure rule, `allocateFromLots`, in `src/modules/inventory/rules/lot-allocation.ts`: FEFO order, a named lot first (refused with `LOT_INSUFFICIENT` if it holds too little for a waste, adjustment or transfer), and an unallocated remainder only for `CONSUME` where negative stock is allowed.
    - Increases first settle open shortfalls (oldest first), then the rest goes to the new lot.
    - `SALE_REVERSAL` reverses the compensated `CONSUME`'s movements lot by lot (its shortfall part settles nothing; it removes the shortfall).
    - The test that scans for ledger writers is extended to lot tables: only the posting service writes them, plus the lot correction service for code and expiry.
18. **Receiving.** For a lot-tracked item, each receipt line takes an optional supplier lot code and expiry date (the receiving form shows the fields only for those items). The receipt line's ID is stored on the lot.
19. **Transfers and lots.** `TRANSFER_OUT` allocates FEFO (or a named lot per line); receiving recreates one lot per source lot at the destination (same code, expiry, received date and cost, `origin = TRANSFER`, `source_lot_id`). A shortage is then taken FEFO from those new lots. An item lot tracked at the sender is lot tracked everywhere (the flag is organization-wide).
20. **Turning tracking on and off (D8).** On: under `inventory.configure`, one transaction locks the item's balances, creates an `OPENING` lot for each location with stock above zero, holding the balance as it stands, and audits. No ledger row and no movement row are written, because the quantity on hand doesn't change; the lot's `quantity_received` and its origin record where it came from, and reconcile (policy 24) counts it like any other lot. Off: refused with `LOTS_HAVE_STOCK` while any lot has stock left.
21. **Corrections (D15).** `correctLot` changes `supplier_lot_code` or `expires_on` with a reason, under `inventory.adjust`, with version check and audit before and after. Quantities never.
22. **Expiry warnings (D13).**
    - `location_settings.lot_expiry_warning_days` (0–30, default 2).
    - The hourly maintenance run writes `LOT_EXPIRING` notifications (dedupe key `lot:{id}:expiring` and `lot:{id}:expired`) for lots with stock left whose `expires_on` is within the window or past, using the location's business date. Recipients: `inventory.adjust` holders at the location.
    - Inventory → Lots lists lots by item with remaining stock, expiry and status (OK, expiring, expired), with Waste lot and Correct.
23. **Trace (D14).** `lot-trace` section in the Inventory report area: the lot, its receipt or source lot (followed back to the receipt), every movement with type, date and quantity, transfers, and consuming orders (order number, business date, item name from the order item snapshot). Read-only, CSV export, `reports.inventory` at the lot's location; costs only with `inventory.cost.view`.
24. **Reconcile.** `reconcileBalances` reports, per lot-tracked item and location, any difference between the lot sum and the balance (when the balance is at or above zero) and any ledger row whose movements don't sum to it. The admin system page shows the count.

### E. Phase 22 leftovers (D16)

25. **Reservations board.** Subscribes through the realtime provider to `reservation.online-booked`, `reservation.guest-cancelled` and the reservation events the floor already uses, refreshing on each (debounced 500 ms). The 30 s refresh runs only while the connection status isn't `connected`.
26. **Dev-server E2E.** `tests/helpers/e2e-web-server.ts` in `dev` mode lists the routes under `src/app` (page routes with sample IDs where dynamic segments are needed are skipped; API routes get a `HEAD` or `GET` that compiles them, whatever status comes back), requests each once after the server is ready, and only then lets Playwright start. A unit test checks the route list builder. Then the full suite runs twice against `npm run dev`; both runs must pass with no re-run.

### F. Boundaries

27. **Audit.** New actions: `locations.created`, `locations.deactivated`, `locations.reactivated`, `inventory.transfer-sent`, `inventory.transfer-received`, `inventory.transfer-cancelled`, `inventory.lot-tracking-enabled`, `inventory.lot-tracking-disabled`, `inventory.lot-corrected`, with allow-listed fields. Category `INVENTORY` or `ORGANIZATION`.
28. **Outbox.** `location.created`, `location.deactivated`, `inventory.transfer-sent`, `inventory.transfer-received`; identifiers only.
29. **Nothing else moves.** No new server, queue, cache or database; no new dependency. Settlements, orders and kitchen are unchanged except that SEND and remakes pass through lot allocation inside the posting service they already call.

## Amendments decided at implementation

1. **Reservations board (policy 25).** It uses the existing `useRealtimeRefresh` hook like the other boards, so the 30-second fallback runs whether or not the stream is connected. It listens for `reservation.online-booked`, `reservation.guest-cancelled` and `guest.allergies-changed`; staff reservation changes emit no realtime events today, and adding them is out of scope.
2. **Copy group `MENUS` (policy 2).** `menu_locations` decides which menus a location offers, so without it a new location sells nothing. The group copies the menus offered and their time windows (a window already under way starts at creation).
3. **In transit (policy 14).** There was no inventory valuation section to add a line to, so the Inventory report gets its own "In transit" section: transfers sent from the location and not received by the end of the range, at the cost frozen at send. The cross-location view sums it.
4. **Cross-location totals (policy 7).** The average check is worked out from the summed net sales and checks. Average minutes (to close, to ready, seated) are shown per location and left out of the total, because the counts behind each average aren't in the summary. Labor % is not in the comparison.
5. **Lots and receipts (policy 16).** `inventory_lots.receipt_line_id` was dropped: the receipt line is written after its ledger row, and the lot reaches it through its RECEIVE movement (`purchase_order_receipt_lines.inventory_transaction_id`). Migrations 0058 and 0059 were regenerated before they were applied anywhere but throwaway test databases.
6. **Location changed (policy 4).** The refusal shows as the form's normal error with the existing Reload button (`isStaleConflict` treats `LOCATION_CHANGED` like a version conflict), not as a separate banner.
7. **Seeds (D17).** The validation fixture has one location, so it gains lot-tracked bacon with a dated lot but no transfer; the demo data has the transfer. Demo "staff at Uptown" are work-location assignments (`employee_locations`) for DEMO-001 and DEMO-002, since demo employees have no sign-ins.
8. **Adding an existing person (policy 5).** `assignRole` now also refuses a user who has no role assignment, current or removed, at any location of the organization (users belong to an organization only through their assignments). Before, any user ID was accepted.
9. **Dev E2E warm-up (policy 26).** Done in a Playwright `globalSetup` (`tests/helpers/e2e-warm-up.ts`), which Playwright runs after the web server is ready; it skips CI mode. Dynamic segments are requested with a placeholder ID instead of being skipped, so those routes compile too.
10. **Named lots in the UI (D9).** Waste of a specific lot is the "Waste lot" button on the Lots page. Transfers can name a lot per line through the API; the transfer screen always sends first to expire.
11. **Routes (policy 13).** `POST /api/inventory/transfers` stays the one-step move with its Phase 8 body. Records use `/api/inventory/transfers/drafts`, `/now`, `/{id}`, `/{id}/send`, `/{id}/receive` and `/{id}/cancel`.
12. **Setting (policy 22).** `lotExpiryWarningDays` is optional in the location settings update, so existing callers keep working; the Admin form always sends it.

## 1. Objectives

Deliver policies 1–29, the migrations, the tests in sections 5–7, README, CLAUDE.md and User Guide updates, and `docs/Phase-23-Completion-Report.md`.

## 2. Scope Boundary

Out of scope (don't build):

- FIFO or lot costing; per-lot counts; lot-level pricing
- Commissary, production and inter-location ordering or invoicing; transfer requests from the receiver
- Several currencies or organizations; location groups or regions
- Cross-location detail reports (item mix, by hour, by server stay per location)
- Delivery, loyalty, forecasting, accounting, payroll, cloud deployment (on hold)

## 3. Review Existing Foundation Before Changes

Confirm from code before each step:

- `bootstrap:owner` and the organization seed, for everything a location needs to exist.
- Every module's per-location configuration rows and how they're created (lazily or by seed).
- `resolveCurrentLocation`, `requireApiPermission`, `requireApiActor` and every place that builds an `Actor`, for the header check.
- `RealtimeProvider` and the realtime hub subscription lifetime.
- `report-service.ts`, `report-context.ts` and each area's summary queries.
- `transferStock` and its tests; the PO numbering, for transfer and lot numbers.
- `postInventoryTransaction`, `postConsumption`, remakes, `SALE_REVERSAL`, counts and receiving, for lot allocation.
- The maintenance runner and `INVENTORY_LOW`, for `LOT_EXPIRING`.
- `reservations-board.tsx` and `e2e-web-server.ts`.

If any conflicts with the policies, stop and explain before changing it.

## 4. Build Order

Migrations start at 0056. Each step generates its own migration (plus a custom one for triggers and guards), reviewed before applying, and leaves lint, typecheck, unit and integration tests green.

1. **Phase 22 leftovers:** the reservations board subscription and the dev E2E warm-up (policies 25–26).
2. **Location header and switcher:** `X-Location-Id`, `LOCATION_CHANGED`, the realtime reconnect, the client helpers (policy 4).
3. **Create, copy, deactivate:** the permission seed, the open-location workflow and module copy functions, deactivate and reactivate, the Admin screens, "Add an existing person" (policies 1–3, 5–6).
4. **Transfers:** tables, send, receive, one-step, in transit, idempotency, screens (policies 10–15).
5. **Lots:** tables, allocation rule, posting changes, receiving, transfers, tracking on and off, corrections, expiry warnings, lot screens, reconcile (policies 16–22, 24).
6. **Reports:** cross-location summaries, dashboard strip, export, lot trace (policies 7–9, 23).
7. **Seeds, E2E, documentation and the completion report** (D17).

## 5. Unit Tests

- *Lot allocation:* FEFO order (dated before undated, then received date, then number); a named lot; insufficient named lot refused; unallocated remainder only for `CONSUME` with negative stock allowed; increases settle shortfalls oldest first.
- *Transfer rules:* status transitions; received quantity between 0 and sent; shortfall computation.
- *Cross-location totals:* sums, ratios recomputed from sums, cost hidden when any location lacks the permission.
- *Location code and time zone validation.*
- *Expiry status:* OK, expiring and expired against a business date and warning window.
- *E2E route list:* the builder finds page and API routes and skips dynamic pages.

## 6. Integration Tests

- **Create location:** creates settings, areas, rules and booking settings in one transaction; the creator's roles are copied and nobody else's; a duplicate code is refused; a failure part way leaves nothing.
- **Copy setup:** each group copies what it should and nothing else (no tables, staff, stock, 86 entries); prices and tax rates start at creation; the source is unchanged.
- **Deactivate:** refused for each kind of open work and for the last location; deactivated location gone from the auth context and the switcher; reactivate restores it; reports of an inactive location readable as in policy 7.
- **Location header:** a write with a mismatched `X-Location-Id` is refused with 409 and changes nothing; no header uses the cookie; the header can't reach a location the user has no grant at.
- **Transfers:** send posts `TRANSFER_OUT` per line and freezes cost; receive posts `TRANSFER_IN` and the shortage; each side needs its own permission; a retried send or receive posts nothing new; one-step matches the Phase 8 behaviour; in-transit value appears in valuation; concurrent sends of opposite transfers don't deadlock.
- **Lots:** receipt creates a lot with code and expiry; SEND of the canonical Bacon Cheeseburger with a lot-tracked cheese takes FEFO and the consumption snapshot and inventory movement are otherwise unchanged; a remake allocates; void as never prepared returns to the same lots; waste of a named lot; count decrease FEFO and increase `FOUND`; transfers recreate lots at the destination with the source link; negative stock leaves a shortfall that the next receipt settles; lot sums match balances after every case; the movement sum trigger refuses a mismatched write; tracking on creates opening lots and off is refused with stock.
- **Expiry warnings:** one notification per lot per state, to `inventory.adjust` holders only, none when the setting is 0.
- **Trace:** a lot received, transferred and consumed traces back to its PO and forward to its orders; no guest data in the output.
- **Reports across locations:** totals equal the sum of per-location reports run separately, each with its own business dates (one location with a different time zone and cutoff); locations without the permission are left out; fewer than two refused.
- **Permissions:** every new API refuses without its permission at the right location.
- **Audit and outbox:** the new actions with allow-listed fields; identifiers only in outbox payloads.
- **Canonical scenario:** the Bacon Cheeseburger test passes unchanged, and again with American cheese lot tracked (same snapshot, one movement set, retry adds no lot movement).
- **Migrations:** reconstruction and upgrade-from-Phase-22; existing items are not lot tracked; existing transfers keep their ledger rows (no backfilled transfer records).

## 7. E2E Tests (Playwright)

- **New `locations.spec.ts`:** the owner creates `UPTOWN` copying settings, stations, prices and stocked items from `MAIN`; switches to it and sees the copied prices; adds an existing manager there; opens a second tab, switches back in one and gets the "changed in another tab" banner on a save in the other; reports show "All my locations" with both rows and a total.
- **New `transfers-and-lots.spec.ts`:** a manager turns on lot tracking for cheese, receives it with an expiry date, sends part to `UPTOWN`, which receives it short by one; the lot appears at `UPTOWN` with the same expiry; a SEND at `MAIN` takes from the first-expiring lot; the lot trace shows the order; an expiring lot raises the bell and is wasted from the lots page.
- **Reservations board:** an online booking appears on the open board without a reload.
- **Every existing spec** still passes, in CI mode and twice against the dev server with no re-run.

## 8. Documentation

- **README sections 8, 16, 21, 22 and 39:** the policies as built.
- **README section 33:** a "Phase 23 Multiple Locations and Ingredient Lots" note; **section 36** and the CLAUDE.md phase list: Phase 23, with short location and lot policies in CLAUDE.md.
- **Phase 8 plan:** an amendment noting transfers became records with an in-transit state.
- **`docs/User-Guide.md`:** opening a location, the switcher, adding a person to a location, transfers, lot tracking, expiring lots, the lot trace, cross-location reports.

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
- [ ] The canonical Bacon Cheeseburger test passes unchanged
- [ ] Only the posting service writes ledger, balance and lot quantities; lot sums reconcile with balances
- [ ] No write runs at a location other than the one its page showed
- [ ] Every transfer pair nets to zero; shortages appear as `TRANSFER_SHORTAGE`

## 10. Required Phase 23 Completion Report

Write `docs/Phase-23-Completion-Report.md`:

```text
PHASE 23 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Locations (create, copy setup, deactivate, switcher and location header, access):
- Reports across locations:
- Transfers:
- Lots (tables, allocation, receiving, transfers, tracking on/off, corrections, expiry, trace, reconcile):
- Phase 22 leftovers:
- Permissions, audit, outbox and boundaries:

Results
- Location creation and copy are atomic and copy no staff, stock or history: PASS / FAIL
- A write from a stale tab is refused before it runs: PASS / FAIL
- Cross-location totals equal the per-location reports: PASS / FAIL
- Transfer pairs net to zero; shortages visible in the ledger: PASS / FAIL
- Lots move only with ledger rows; lot sums reconcile with balances: PASS / FAIL
- FEFO allocation, including at SEND, with idempotent retry: PASS / FAIL
- Cost stays weighted average: PASS / FAIL
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
