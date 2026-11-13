# Phase 23 Completion Report

```text
PHASE 23 COMPLETION REPORT
```

## Summary

Phase 23 builds the third README section 39 group: multiple active locations and ingredient lots, with the Phase 22 leftovers folded in. The owner approved `docs/Phase-23-Multiple-Locations-and-Ingredient-Lots.md` with D1–D17 as recommended on 2026-11-12. The plan records 12 amendments made during implementation.

Delivered:

- Locations are opened in the app, can copy setup from another location, and can be closed and reopened.
- Every browser write sends the location its page shows. A write from a tab left at another location is refused with 409 `LOCATION_CHANGED`.
- Admin → Users can give a role to someone already in the organization.
- Reports can show "All my locations", and the Overview shows today at each location.
- Transfers are records: sent, in transit, then received, with shortages posted to the ledger.
- Ingredient lots are opt-in per item, used first to expire first out (including at SEND), with expiry warnings, a Lots page and a lot trace.
- Phase 22 leftovers: the reservations board refreshes on online bookings, and routes are warmed before dev-server E2E runs.

Everything passes in CI mode. The dev-server E2E target was not met: three dev runs each had a few timing failures, a different set each time (see Results and Remaining issues).

## Environment

- Node 26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker Compose), Windows 11
- No new dependencies

## Policies (as built)

**Locations (policies 1–6).**
- **Open.** `src/workflows/open-location/` creates, in one transaction:
  - the location, its settings and the three standard areas;
  - its scheduling rules and online booking settings (booking off);
  - the creator's own roles at the new location, and nobody else's.
  - Each module writes its own rows: `location-setup.ts` in Scheduling, Reservations, Menu, Inventory and Settlements.
- **Copy groups.** `SETTINGS`, `STATIONS_AND_ROUTING`, `MENUS` (amendment 2), `PRICES`, `TAX_RATES`, `STOCKED_ITEMS`, `SCHEDULING_RULES`, `TIP_POOL_RULES`, `BOOKING_HOURS`.
  - Prices and tax rates are copied as the rows in effect at that moment, starting then.
  - Tables, staff, stock and history are never copied.
- **Close and reopen.** `src/workflows/deactivate-location/` refuses while the location has any of these, naming each kind:
  - open checks or seated parties;
  - open settlements or open drawer sessions;
  - purchase orders still to be received, or transfers in transit either way.
  - It also refuses the last open location. Closing turns online booking off. Reopening is in the Organization service.
- **Location header.**
  - `sendApiRequest`, `sendFormData` and the new `apiFetch` send `x-location-id`. The nine direct `fetch` calls in staff components were moved onto `apiFetch`.
  - `resolveCurrentLocation` refuses a mismatch with 409 before anything runs. Requests without the header behave as before.
  - The realtime stream reconnects when the location changes, and the header always names the current location.
- **People at a second location.** Admin → Users → "Add an existing person" (`GET /api/admin/users/candidates`). `assignRole` now refuses a user from outside the organization (amendment 8).
- **Permission.** `locations.lifecycle` (Owner, General Manager); 149 codes in all.

**Reports across locations (policies 7–9).**
- `cross-location-service.ts` runs each area's existing sections once per location, all in one read-only snapshot.
- Each area's summary figures are shown per location, with a total row:
  - sums for additive figures;
  - the average check recomputed from the sums;
  - average minutes per location only (amendment 4).
- Cost and wage columns are hidden unless the user can see them at every included location.
- A closed location stays included while the user's assignment there is active and the same permission is held at an open location.
- Also: CSV export (audited), and the "Today at all my locations" strip on the Overview, each location on its own business date.

**Transfers (policies 10–15).**
- `inventory_transfers` and `inventory_transfer_lines`, numbered `TR-000001` per sending location. Guard triggers enforce draft-only edits, forward-only status and frozen sent lines.
- **Send:** posts TRANSFER_OUT per line and freezes each line's cost.
- **Receive:** posts TRANSFER_IN for the full sent quantity at that cost, then `ADJUST_DECREASE` `TRANSFER_SHORTAGE` for anything that didn't arrive.
- Send and receive take an idempotency key; each side needs `inventory.transfer` at its own location.
- "Send and receive now" (`transferNow`) keeps the Phase 8 one-step move, and the Phase 8 `transferStock` API delegates to it.
- Inventory → Transfers shows stock in transit at both ends. The Inventory report has an "In transit" section (amendment 3).

**Lots (policies 16–24).**
- **Tables.** `inventory_items.lot_tracked`; `inventory_lots` (per location, `L-000001`); `inventory_lot_movements`, append-only, with a deferred trigger checking each ledger row's movements sum to it at commit.
- **Allocation.** `rules/lot-allocation.ts`, a pure rule: first to expire, then undated, then oldest received, then lot number. A named lot is used alone. A shortfall is allowed only for CONSUME.
- **Posting.** `services/lot-posting.ts`, called only by `postInventoryTransaction` under the balance lock.
  - Receipts and increases create lots.
  - TRANSFER_IN recreates the sent lots with the same code and dates.
  - SALE_REVERSAL returns stock to the lots its CONSUME took from.
  - New lots settle open shortfalls first.
- **Tracking on and off** (opening lots), **corrections** (code or date, with a reason, audited) and **Waste lot** are in `lot-service.ts`.
- **Expiry warnings.** `LOT_EXPIRING` from the hourly run, once while expiring and once when expired, to `inventory.adjust` holders. The location setting `lot_expiry_warning_days` (default 2) controls the window; 0 turns warnings off.
- **Screens.** Inventory → Lots; lot fields at receiving; the lot-tracking switch on the item page; a use-by field on stock increases.
- **Lot trace.** `/reports/lot-trace/{id}`: where the lot came from, where it went and which orders used it. It shows no guest data and exports to CSV.
- **Reconcile.** `reconcileLots`.
- **Cost.** Stays weighted average throughout (D10).

**Phase 22 leftovers (policies 25–26).**
- The reservations board uses `useRealtimeRefresh` with the online-booked, guest-cancelled and allergies-changed events (amendment 1).
- `tests/helpers/e2e-warm-up.ts` (a Playwright `globalSetup`, skipped in CI mode) requests all 386 page and API routes once after `next dev` is ready.
- The online booking spec now books tomorrow, so it no longer depends on the time of day. It also refills the date until hydration keeps it.
- The real SMTP/Twilio send stays a manual check for the owner.

**Permissions, audit, outbox and boundaries.**
- New audit actions:
  - `locations.created`, `locations.deactivated`, `locations.reactivated`;
  - `inventory.transfer-sent`, `inventory.transfer-received`, `inventory.transfer-cancelled`;
  - `inventory.lot-tracking-enabled`, `inventory.lot-tracking-disabled`, `inventory.lot-corrected`;
  - `lotExpiryWarningDays` added to the location-settings action.
- New outbox events, identifiers only: `location.created`, `location.deactivated`, `inventory.transfer-sent`, `inventory.transfer-received`.
- No new server, queue, cache, database or dependency.

## Results

| Check | Result |
|---|---|
| Location creation and copy are atomic and copy no staff, stock or history | PASS (`organization/location-lifecycle.test.ts`) |
| A write from a stale tab is refused before it runs | PASS (`auth/location-header.test.ts`, `locations.spec.ts`) |
| Cross-location totals equal the per-location reports | PASS (`reporting/cross-location.test.ts`, with two time zones and cutoffs) |
| Transfer pairs net to zero; shortages visible in the ledger | PASS (`inventory/transfers.test.ts`) |
| Lots move only with ledger rows; lot sums reconcile with balances | PASS (`inventory/lots.test.ts`, the commit-time trigger, boundary scan) |
| FEFO allocation, including at SEND, with idempotent retry | PASS (`orders/lots-at-send.test.ts`) |
| Cost stays weighted average | PASS (transfer and lot tests check the averages) |
| Dev-server E2E passes twice with no re-run | **FAIL**: 3 runs, 160/165, 155/165 and 155/165 passed; see Remaining issues |
| Canonical Bacon Cheeseburger unchanged | PASS (`orders/submission.test.ts` unchanged; also with Swiss lot tracked) |

## Architectural decisions

- **Cross-domain setup and the "anything open?" checks go through workflows**, so Organization never writes another module's tables.
- **Lots are a sub-ledger written inside the posting service**, not a second posting path. The scan test in `inventory/authorization.test.ts` enforces it.
- **A shortfall is settled with a +x/−x pair under the original CONSUME row.** Every ledger row's movements then still sum to it, and a reversal can still find the lots its CONSUME used.
- **Reports across locations reuse each area's builders per location** instead of new SQL, so business-date rules stay exact. This is fine for a handful of locations; measure before adding summary tables.
- **The location header is checked only where the location is implicit** (`resolveCurrentLocation`). Routes given an explicit location still authorize at that location.

## Migrations

| File | Contents |
|---|---|
| `0056_inventory_transfers.sql` | Transfers and transfer lines (generated) |
| `0057_inventory_transfers_guards.sql` | Transfer guard triggers (custom) |
| `0058_inventory_lots.sql` | Lots, lot movements, `lot_tracked`, `lot_expiry_warning_days`, a lot on transfer lines (generated) |
| `0059_inventory_lots_guards.sql` | Append-only movements, the commit-time sum check, frozen lot identity (custom) |
| `0060_lot_expiring_notifications.sql` | `LOT_EXPIRING`, `notifications.inventory_lot_id` (generated) |

- 0058 and 0059 were regenerated once before being applied anywhere but throwaway test databases (amendment 5).
- `npm run db:generate` reports no changes.
- On the development database, `npm run db:migrate` applied 0056–0060. Its only output was "already exists" notices.

## Validation results

| Command | Result |
|---|---|
| `npm run lint` | Clean |
| `npm run typecheck` | Clean |
| `npm run test:unit` | 897 / 897 |
| `npm run test:integration` | 1413 / 1413 (96 files, 808 s). The first full run had 6 failures, all from Phase 23 changes, all fixed: 4 expected lists (tables, seed list, internal functions), 1 test using a user from no organization (now refused, amendment 8), 1 row-order assumption (rows now sorted by location code). |
| `npm run test:e2e`, CI mode | 165 / 165, no retries (5.5 min). Earlier CI runs exposed: two auth tests that read "Main Restaurant" anywhere on the page (the header now shows it too, so they look in the page body), selectors in the two new specs, and the online booking test's time-of-day dependency. |
| `npm run test:e2e`, dev server | Run 1: 155 passed, 5 failed (timeouts in the axe scan, audit, kitchen, labor-tips; online booking). Run 2: 160 passed, 1 failed (online booking: a date filled before hydration was reset, now fixed and passing 7/7 under `next dev`). Run 3: 155 passed, 6 failed (guest profiles, hardening, two orders tests, recipes, online booking), all 5-second waits. Each run warmed 386 routes first (106–161 s). Every failing test passes in CI mode. |
| `npm run build` | Clean, no warnings |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run db:seed` twice (dev) | 1 applied, 26 already applied; then 0 applied, 27 already applied |
| `npm run db:seed:demo` twice (dev) | First run: Uptown opened, 2 employees added there, 2 items lot tracked, 2 dated lots, 1 transfer. Second run: nothing added. |
| `npm run db:seed:validation` twice (dev) | `phase23.validation-lots` applied once, then skipped |
| `npm run db:reset` safeguards | Unchanged code; the existing guard tests pass in the integration run |

## Tests executed

- **Unit: 897** (886 at the end of Phase 22, +11)
  - `shared/tooling/app-routes.test.ts`: route list for the warm-up
  - `inventory/rules/lot-allocation.test.ts`: FEFO order, named lot, shortfall, settlement, expiry status
- **Integration: 1413** (1380, +33). New files:
  - `auth/location-header.test.ts`
  - `organization/location-lifecycle.test.ts`
  - `inventory/transfers.test.ts`
  - `inventory/lots.test.ts`
  - `orders/lots-at-send.test.ts` (canonical burger with lot-tracked Swiss, lot trace)
  - `reporting/cross-location.test.ts`
  - Additions to the seed, validation, migration, menu and inventory boundary tests.
- **E2E: 165** (159, +6)
  - `locations.spec.ts`: open with copy, the switcher, stale-tab refusal, all-locations sales, close.
  - `transfers-and-lots.spec.ts`: lot tracking on, a dated found lot, send, receive one short, the lot keeps its use-by date, trace.

## Files changed

68 modified and 60 new files and folders.

**New source:**
- Workflows: `src/workflows/open-location/`, `src/workflows/deactivate-location/`.
- Per-module location setup and checks:
  - `location-setup.ts` in inventory, menu, reservations, scheduling and settlements;
  - `location-work.ts` in orders and restaurant;
  - `organization/services/location-lifecycle-service.ts`.
- Inventory: `transfer-service.ts`, `lot-posting.ts`, `lot-service.ts`, `rules/lot-allocation.ts`.
- Reporting: `cross-location-service.ts`, `lot-trace-service.ts`, `queries/transfer-report.ts`.
- Shared: `src/shared/http/location-header.ts`, `src/shared/tooling/app-routes.ts`.
- Components: `components/forms/page-location.tsx`, `admin/new-location-form.tsx`, `admin/add-existing-person.tsx`, `inventory/transfer-board.tsx`, `reports/locations-today.tsx`.
- Pages: Inventory → Transfers, Inventory → Lots, and the lot trace page.
- API routes: create, deactivate and reactivate a location; user candidates; transfers (drafts, now, update, send, receive, cancel); lots; lot tracking; lot trace export.
- Seeds and scripts: `src/db/seeds/locations-lots-permissions.ts`, `scripts/demo-locations-lots.ts`, `scripts/validation-lots.ts`.

**Changed source:**
- Guards, permission catalog, user and permission services and repositories.
- Posting, receiving, stock operations and purchase-order detail.
- Schemas (inventory, organization, notifications).
- Notification links and writer, the hourly signals workflow, audit registry.
- Report service, page and export.
- Admin locations and users pages, the app layout, the switcher, the realtime provider.
- Nine components moved onto `apiFetch`; the reservations board; the receive form; inventory tabs; the item and movements pages.

**Docs:**
- README sections 8, 16, 21, 22, 33, 36 and 39.
- `CLAUDE.md`: header line, location and lot policies, notifications line, phase list.
- `docs/User-Guide.md`.
- The Phase 8 plan amendment.
- The Phase 23 plan: approval and amendments.

## Risks

- **Cross-location reports** run every area builder once per location. With many locations or long ranges they get slower in proportion. Measure before adding summary tables (README section 21).
- **Lots and negative stock.** A shortfall is settled by the next increase, which attributes earlier consumption to a lot received later. That is the approved D12 behavior, and the lot trace shows it. Recalls should allow for it where negative stock is allowed.
- **Header checks** apply only to browser calls through the shared helpers. Scripts and API clients without the header still use the cookie, as before.
- **Demo data** opens a real second location on a developer's database. Closing it from Admin → Locations is the way back.

## Remaining issues

1. **Dev-server E2E timing (policy 26 not met).**
   - Warming routes removed the compile delays: no failure was a first-request compile.
   - On this machine, though, `next dev` runs the suite in about 15 minutes (against 5.5 for the production build), and a few 5-second waits run out on each run, a different set each time (5, 1, 6 failures).
   - Proposed fix, for the owner to decide: a longer assertion timeout only when not in CI mode, for example `expect: { timeout: isCi() ? 5_000 : 15_000 }` in `playwright.config.ts`. CI keeps testing the production build at 5 s.
2. **Not covered by E2E:**
   - the expiry notice in the bell (covered by integration);
   - "Add an existing person" (covered by integration);
   - the reservations board updating on an online booking (left to the shared refresh hook).
3. **Staff reservation changes** still emit no realtime events, so the board refreshes on those only on its 30-second fallback (amendment 1).
4. **Validation fixture** has one location, so it has no transfer (amendment 7).
5. **Real SMTP and Twilio sends** remain a manual check for the owner (Phase 22 leftover).

## Next-phase readiness

Phase 23 is complete apart from the dev-server E2E timing above, which needs an owner decision. Cloud deployment stays on hold. The last README section 39 group the owner named, demand forecasting (group 4), has more to work from once these locations have history. Any next phase needs a plan and the owner's approval first.
