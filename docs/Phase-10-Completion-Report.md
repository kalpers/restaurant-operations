# Phase 10 Completion Report

This report merges the plan §88 template with the sections required by CLAUDE.md. Results are from this repository on 2026-11-09.

## Summary

Phase 10 is implemented. Every SEND now creates station work in the same transaction: one ticket per send batch and prep station, and one item per routed Order Item, all from the immutable routing snapshot. Kitchen and Bar are station types in one model. Cooks and bartenders work their queues at `/kitchen` and `/bar` (Start, Ready, Bump), and `/expo` is a read-only overview. Voids now check fulfillment state. A Remake is an explicit, idempotent new attempt that consumes stock again from the original consumption snapshot. The transactional outbox is built, with a processor and a Server-Sent Events adapter, so screens update live. Servers get an in-app notification when food or drinks are ready. Orders stay OPEN and no settlement exists.

**Validation is not complete:** the full Playwright suite could not finish cleanly on this machine because it ran out of memory (see Validation). Everything else passed.

**Please review these decisions.** The first four were your answers in planning; the rest are defaults from the approved plan.

1. The outbox is built (decided 2026-11-09). This overrides plan item 9.
2. Realtime uses SSE with an in-process outbox processor, not 5-second polling (overrides plan §44).
3. Minimal in-app notifications (`FOOD_READY`, `BAR_ORDER_READY`) are built now (README §36).
4. Tables use the README `kitchen_*` names, not the plan's `fulfillment_*` names (mapping below).
5. Recall, courses and hold/fire follow the plan: none built, and Remake replaces recall. README §18 and §36 now say so.
6. EXPO-type stations in a routing snapshot get no work, because Expo is a view, not a preparation hop.
7. Permissions: Bartender moves from the never-enforced `kitchen.manage` to `bar.manage`. Server, Bartender and Wait Staff get `kitchen.view` and `bar.view` for Expo context. Cook and Bartender may request a Remake.
8. A database trigger guards station deactivation, so Menu doesn't depend on Kitchen (its boundary test forbids that).
9. Audit events are still not written (carried since Phase 3).

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 (Docker) |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |
| Queue update strategy | Transactional outbox → in-process processor (1 s) → Server-Sent Events; 30 s fallback refresh; no broker, Redis or WebSocket library |
| New dependencies | None |

## Policies

The plan's Approved Phase 10 Policies 1–11 are binding, except item 9 (outbox), overridden by your decision. Each policy is recorded as built in README §33 "Phase 10 Kitchen, Bar and Realtime".

| Approved policy | As implemented |
|---|---|
| 1. Exactly NEW / PREPARING / READY / COMPLETED / CANCELLED; no NEW → READY; terminal states | Check constraint, pure rules, and a transition trigger |
| 2. One ticket per submission + station; ticket status derived | Unique (batch, station); no status column; `deriveTicketStatus` uses the exact precedence |
| 3. One item per snapshotted station; empty route → none; no repeat consumption | `groupByStation`; multi-station items get work at each station; consumption stays one per Order Item |
| 4. FIFO by submitted_at, then stable ID | `compareQueue` (instant, ticket ID, item ID) and the SQL ordering |
| 5. EXPO read-only; courses and hold/fire deferred | `/expo` has no actions; EXPO stations get no work |
| 6. UNPREPARED only if every attempt is NEW; PREPARED_OR_DISCARDED cancels active work and keeps terminal history | `planVoidCancellation` runs inside the void transaction, before any reversal |
| 7. Remake: reasoned, idempotent, from the original consumption snapshot, rolls back on shortage | `remakeOrderItem` workflow and `postRemakeConsumption` |
| 8. No recall/reopen | Rejected by the rules and by the trigger |
| 9. Tickets in the submission transaction (outbox part overridden) | Tickets and outbox rows are written inside SEND |
| 10. No backfill | None; the migration test asserts an upgraded Phase 9 database has no tickets |
| 11. Phase 9 boundaries preserved | Order stays OPEN, session guard intact, no settlement, no Inventory rights for kitchen roles |

## Architectural decisions

- **Module layout.** `src/modules/kitchen` holds rules, the repository, queries, services (ticket generation, transitions, void sync, access) and validators. `src/modules/notifications` holds the notification service. `src/workflows/remake-order-item` orchestrates Orders, Kitchen and Inventory. Kitchen reads Menu stations through `menu/queries/station-facts.ts` and table numbers through `restaurant/queries/session-facts.ts`, and never reads routing or recipe tables (a scan test checks this).
- **Inventory stays authoritative.** Remake postings go through the trusted, consume-only `postRemakeConsumption` (reference `KITCHEN_REMAKE`, at most one per Remake and Inventory Item). `postSaleReversal` now also accepts a Remake CONSUME.
- **Lock order.** Void: order (FOR UPDATE), then Order Items, then ticket items, then balances. Remake: order (FOR SHARE), then the Order Item, then balances. A transition locks only its item. There are no cycles.
- **Concurrency.** Ticket items carry a `version`. A repeated action is an idempotent success with no history; a stale version for a real move is `CONCURRENCY_CONFLICT`.
- **Outbox.** `writeOutboxEvents` runs in the caller's transaction. `processOutboxBatch` uses `FOR UPDATE SKIP LOCKED`, publishes in sequence and records failures. Payloads carry identifiers only. Event types: `order.items-submitted`, `kitchen.ticket-created`, `kitchen.item-status-changed`, `kitchen.item-ready`, `kitchen.ticket-ready`, `kitchen.remake-requested`, `notification.created`.
- **Realtime adapter.** An in-memory hub on `globalThis` feeds `GET /api/realtime/stream`. It filters by organization and location, and recipient-only events go to their recipient alone. A stream closes after 5 minutes, so the browser reconnects and the user, location and permissions are resolved again. Messages only trigger a refetch of authorized queries. There is one `RealtimeProvider` per tab.
- **Circular foreign keys.** Tickets reference Remakes, Remakes reference their source ticket item, and items reference tickets. Each table's extra-config callback carries an explicit return type so TypeScript can infer the schema, and test cleanup removes the kitchen tables with one `TRUNCATE`.

### Plan name mapping

| Plan name | Built as |
|---|---|
| fulfillment_tickets | `kitchen_tickets` |
| fulfillment_ticket_items | `kitchen_ticket_items` |
| fulfillment_item_status_history | `kitchen_ticket_item_status_history` |
| fulfillment_remakes | `kitchen_remakes` |
| fulfillment_remake_tickets | `kitchen_tickets.remake_id` (no separate table) |
| fulfillment_remake_consumption | `kitchen_remake_consumption` |

Also new: `outbox_events` (README §23) and `notifications` (README §22).

### Architecture deviations

| Deviation | Reason |
|---|---|
| Outbox and SSE instead of plan §9/§44 polling | Your decision; this is the README §3/§23 contract |
| Notifications built (not in the plan) | Your decision; README §36 |
| No recall, courses or hold/fire (README §18/§36) | Your decision; plan policies 5 and 8 |
| EXPO stations get no work | Plan policy 5 wins over the literal reading of policy 3 |
| Trigger on Menu's `prep_stations` | Keeps the Menu module free of Kitchen imports; follows the Phase 9 `table_sessions` precedent |
| No audit events | Still undecided since Phase 3 |
| `.github/copilot-instructions.md` not used | CLAUDE.md replaces it |

## Migrations

| Migration | Contents |
|---|---|
| `0015_kitchen_fulfillment.sql` | Generated. Seven tables: `outbox_events`, `kitchen_tickets`, `kitchen_ticket_items`, `kitchen_ticket_item_status_history`, `kitchen_remakes`, `kitchen_remake_consumption`, `notifications`. Composite same-location FKs to `prep_stations` and `order_send_batches`. Lifecycle-field, attempt and type checks. FIFO and unpublished indexes. Remake-CONSUME partial unique index on `inventory_transactions` |
| `0016_kitchen_constraints.sql` | Custom. Append-only triggers (tickets, history, Remakes, Remake consumption); ticket-item snapshot freeze and transition guard; notification guard (only `read_at`, once); outbox guard (only publishing state) |
| `0017_kitchen_remake_fk_name.sql` | Generated. Renames one FK whose generated name was exactly 63 characters. The migration test treats that length as possibly truncated, and 0015 was already applied, so I added this migration rather than editing 0015 |
| `0018_prep_station_active_work.sql` | Custom. Refuses deactivating a station that has NEW, PREPARING or READY work |

| Check | Result |
|---|---|
| Generation | PASS |
| Application | PASS |
| Existing Phase 9 DB → Phase 10 | PASS: your development database upgraded with `db:migrate`. A new automated test upgrades a Phase 9 database and finds no tickets, outbox rows or notifications |
| Empty DB reconstruction | PASS: automated test, plus a real `db:reset` on a throwaway PostgreSQL 17 container (19 migrations applied) |
| Unexplained schema drift | NONE: a further `db:generate` reports "No schema changes" |

**What changed in your development database:** permissions 106 → 112, role grants 371 → 401, one user kept, no orders, tickets or notifications.

## Validation results

### Fulfillment schema

| Table | Result |
|---|---|
| kitchen_tickets (fulfillment_tickets) | PASS |
| kitchen_ticket_items (fulfillment_ticket_items) | PASS |
| kitchen_ticket_item_status_history | PASS |
| kitchen_remakes | PASS |
| kitchen_tickets.remake_id (fulfillment_remake_tickets) | PASS |
| kitchen_remake_consumption | PASS |
| outbox_events | PASS |
| notifications | PASS |
| Ticket history | N/A; ticket status is derived from its items |

### Routing

| Check | Result |
|---|---|
| Phase 9 send-batch integration | PASS; same PostgreSQL transaction |
| Immutable routing snapshot used | PASS; a rename, modifier change and reroute after SEND leave tickets unchanged, and the next SEND follows the new configuration |
| GRILL/Kitchen routing | PASS |
| BAR routing | PASS; bar work never appears in the kitchen queue (integration and E2E) |
| Multi-station send and multi-station item | PASS |
| EXPO and empty routes create no work | PASS |
| Duplicate generation prevention | PASS; SEND replay adds nothing, and the database refuses a second (batch, station) ticket |
| Ticket generation durability | PASS; a shortage rolls back SEND with no tickets, items, history or outbox rows |

### Lifecycle

| Check | Result |
|---|---|
| NEW → PREPARING → READY → COMPLETED | PASS, with actor and time on each step |
| NEW → READY rejected | PASS |
| Backward and post-terminal transitions rejected | PASS (service and trigger) |
| Idempotent repeat | PASS; no duplicate history |
| Concurrent start by two users | PASS; one transition, one history row |
| Stale version | PASS; `CONCURRENCY_CONFLICT` |
| Ticket aggregation | PASS; 14-case unit table plus integration |
| No inventory movement on transitions | PASS |

### Queue

| Check | Result |
|---|---|
| FIFO by submitted_at, then stable ID; no priority | PASS |
| Age from immutable submission time; display bands | PASS |
| Station, status and order-type filters | PASS |
| DTOs carry no price, cost or discount | PASS |

### Voids

| Check | Result |
|---|---|
| All attempts NEW + UNPREPARED | PASS; cancelled, SALE_REVERSAL posted (integration and E2E) |
| Any started attempt refuses UNPREPARED | PASS; the refusal rolls back fully |
| PREPARED_OR_DISCARDED | PASS; active work cancelled, COMPLETED kept, consumption kept |
| No automatic WASTE | PASS |
| Remake CONSUME reversed on UNPREPARED | PASS; two reversals, balances reconcile |
| Full order void synchronizes all items | PASS |

### Remakes

| Check | Result |
|---|---|
| Explicit new linked attempt at every routed station | PASS |
| Original history and snapshots preserved | PASS |
| Additional CONSUME from the original snapshot, unaffected by a later recipe change | PASS; beef 8 OZ again, not the new revision's 32 |
| Negative-stock policy reused | PASS |
| Shortage rollback | PASS |
| Idempotent retry; same key with another reason refused | PASS |
| Actor, reason, time and ledger provenance | PASS |
| No charge, total, version or Order Item change | PASS |

### Expo, Takeout, Notifications, Realtime

| Check | Result |
|---|---|
| Expo read-only, with overall readiness across stations | PASS |
| Takeout routes to stations with no Table Session; order stays OPEN | PASS (integration and E2E) |
| Ready ticket → one notification to the right recipient | PASS; the server's linked user, else the sender; recipient-only listing and marking |
| Outbox written in-transaction, published once in sequence, failure retried | PASS |
| Location and recipient filtering of events | PASS |
| Live update in the browser | PASS (E2E: a ticket appears on an open kitchen screen without a reload) |

### Authorization

| Check | Result |
|---|---|
| kitchen.view/manage and bar.view/manage scope | PASS; a bartender can't view or work kitchen stations, and a cook can't work bar stations |
| fulfillment.start / ready / complete / remake | PASS; each one is needed on its own |
| Location scope | PASS; another location's work looks absent |
| Direct unauthorized API | PASS; E2E 403 for view-only, 401 signed out |
| No Inventory rights for kitchen roles | PASS |

### Phase 9 boundaries

| Check | Result |
|---|---|
| Submitted Order snapshots unchanged | PASS |
| Existing CONSUME not duplicated | PASS |
| Order remains OPEN | PASS |
| Table Session OPEN-order guard preserved | PASS |
| No Settlement or payment records | PASS |

### Regression

| Check | Result |
|---|---|
| Phases 1–9 (integration) | PASS; all 51 files |
| `db:reset` safeguards | PASS. On a throwaway container, real `db:reset` refused `NODE_ENV=production`, `NODE_ENV=test`, database `postgres`, database `restaurant_ops_test`, a fake RDS host, and `?host=`; the probe row survived. Then a real reset and two seeds gave `17 applied`, then `0 applied, 17 already applied`, with 112 permissions, 401 grants and no tickets, notifications, outbox rows or orders. The container was removed |
| `/api/health` | Not separately re-run; every E2E sign-in exercised the app against the database |

### Validation

| Check | Result |
|---|---|
| PostgreSQL health | PASS |
| `npm ci` | Not re-run; no dependency changed |
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 576 of 576 (baseline 546) |
| Integration tests | PASS: 961 of 961 (baseline 913), on a clean run |
| E2E: kitchen spec alone | PASS: 4 of 4 |
| E2E: full suite | **NOT VERIFIED.** The run finished in 4.3 min with 72 passed, 5 failed and 28 not run, then Claude Code stopped it because the system was critically low on memory. The failures (reservations 2, restaurant 2, scheduling 1) came after the dev server's worker processes crashed (`Jest worker encountered 2 child process exceptions`, `Target crashed`, worker exit `0xC0000142`). Four failed in 0–77 ms. The fifth, a reservations test, ran 8.3 s and failed a URL check, so it needs a clean rerun to rule out a real failure. In that run, auth (including the updated 112-permission check), orders 3/3 and kitchen 4/4 passed |
| Production build | PASS |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 12 moderate, unchanged (DEV-002) |
| Seed idempotency | PASS (development database and throwaway container) |

### Problems found during validation

- **A foreign key name of exactly 63 characters.** Caught by the migration test; fixed with migration 0017.
- **Menu reached Kitchen.** My first station guard imported a Kitchen query from the Menu service, which the Menu boundary test forbids. I replaced it with a database trigger (0018).
- **Five generated FK names over 63 characters**, found before the first apply; named explicitly and regenerated.
- **Circular table types** (tickets, Remakes, items) broke TypeScript inference; fixed with explicit config return types.
- **My own test slips**, all fixed: a ticket-status expectation that contradicted the approved precedence (READY + NEW is NEW), a ledger check that read the whole table, the wrong authorization error code, and a fixture field collision.
- **I ran two test processes against the test database at once** during development, which corrupted that run's results. The clean rerun is the one reported above.
- **Expected regressions**, updated deliberately: permission counts (106 → 112), seed list and counts, the migration table list, two Phase 7 boundary tests that forbade ticket tables, the role matrix (Bartender `kitchen.manage` is now false), the inventory capability allowlist, navigation, and the E2E Roles count.

## Tests executed

- **Unit (new, 30, `src/modules/kitchen/rules/fulfillment-rules.test.ts`):** transitions, idempotent repeats, terminal states, the 14-case aggregation table, void compatibility, FIFO, station grouping with EXPO and unknown stations, age bands.
- **Integration (new, 45, `tests/integration/kitchen/`):**
  - `ticket-generation` (10): canonical burger + fries + cocktail, outbox in-transaction, replay, DB uniqueness, shortage rollback, multi-station / EXPO / empty routes, rounds, takeout, snapshot immutability, freeze trigger.
  - `lifecycle` (16): the lifecycle, invalid moves, idempotency, stale version, concurrent start, aggregation with notification, recipient rule, bar notification and queue separation, order OPEN and session guard, takeout, FIFO and filters, Expo, processor publish and filtering, publisher failure, recipient-only events.
  - `voids-and-remakes` (11): UNPREPARED, started refusal, PREPARED_OR_DISCARDED with COMPLETED kept, Remake snapshot and exact quantities, recipe-change immunity, idempotency, shortage, negative policy, UNPREPARED after Remake, refusals, full order void.
  - `authorization` (9): view-only, per-action permissions, station-type scope, no view, location scope, Remake scope, role catalog, station deactivation, module write scan.
- **Integration (updated):** migrations (table list, Phase 9 upgrade test), foundation seeds (counts, list, Phase 9 → 10 upgrade test, "no tickets seeded" test), seed framework, role matrix, inventory allowlist, two Phase 7 boundary tests.
- **E2E (new, `tests/e2e/kitchen.spec.ts`, 4):** kitchen and bar Start/Ready/Bump with live arrival and the server's two notifications; void before preparation from the order screen; takeout; view-only user with API 403/401.

**Partly covered:** the Remake form, Expo screen and station filters have integration coverage but no E2E. Phone-width layout of the KDS was not tested.

## Files changed

**Created**

- Schema and migrations: `src/db/schema/kitchen.ts`, `src/db/schema/notifications.ts`, `drizzle/migrations/0015`–`0018` and snapshots
- Kitchen: `src/modules/kitchen/` (`types.ts`, `rules/`, `repositories/`, `services/` with ticket generation, fulfillment, void sync and access, `queries/`, `validators/`)
- Notifications: `src/modules/notifications/notification-service.ts`
- Workflow: `src/workflows/remake-order-item/`
- Infrastructure: `src/infrastructure/outbox/` (outbox and runner), `src/infrastructure/realtime/realtime-hub.ts`, `src/instrumentation.ts`, `src/config/runtime.ts`
- Menu: `src/modules/menu/queries/station-facts.ts`
- Seed: `src/db/seeds/kitchen-foundation.ts`
- API: `src/app/api/kitchen/` (queue, expo, item actions), `src/app/api/notifications/` (list, read), `src/app/api/realtime/stream`, `src/app/api/orders/[orderId]/items/[itemId]/remake`
- UI: `src/app/(app)/kitchen`, `/bar`, `/expo`; `src/components/kitchen/`, `src/components/notifications/`, `src/components/realtime/`
- Tests: `tests/integration/kitchen/` (4 files), the unit test above, `tests/fixtures/kitchen-fixtures.ts`, `tests/helpers/e2e-kitchen.ts`, `tests/e2e/kitchen.spec.ts`
- Docs: this report

**Modified**

- Schema: `infrastructure.ts` (outbox), `inventory.ts` (Remake CONSUME index), `index.ts`, migration journal
- Workflows: `submit-order.ts` (tickets and outbox), `void-order-item.ts` (fulfillment sync, Remake reversal)
- Inventory: `order-consumption.ts` (`postRemakeConsumption`, reversal accepts `KITCHEN_REMAKE`)
- Menu: `prep-station-service.ts` (maps the deactivation trigger)
- Auth: `permission-catalog.ts` (112 codes), `role-catalog.ts`
- Config: `env.ts` (`OUTBOX_POLL_INTERVAL_MS`), `.env.example`
- UI: app layout (realtime provider, Alerts bell), navigation, order page and workspace (fulfillment status, Remake)
- Seeds: `registry.ts`
- Tests: `order-cleanup.ts`, `auth.test.ts`, `navigation.test.ts`, `tests/e2e/auth.spec.ts`, and the integration tests listed above
- Docs: `README.md` §18, §22, §23, §33 (Phase 5 note, Phase 9 "Deferred", new Phase 10 policies), §36; `docs/Phase-10-Kitchen-Bar-Fulfillment.md` (override notes under item 9 and §44)

## Risks

- **Single-process realtime.** The hub is in memory. Several app instances would each need their own feed (for example LISTEN/NOTIFY). This is fine for the single-EC2 POC.
- **Outbox growth.** Published rows are kept; there is no retention job yet. The unpublished partial index keeps the processor fast.
- **SSE authorization is checked when a stream opens.** Streams close after 5 minutes, and events carry identifiers only, but a disabled user's open stream can receive refetch signals for up to 5 minutes.
- **Circular kitchen FKs:** test cleanup needs one `TRUNCATE`, and the E2E cleanup assumes no Remakes.
- **Test cleanup lifts triggers** in the test database only (carried).
- **Displays use UTC/locale formatting**, and the floor still refreshes on a 30 s timer (no floor events are published yet).
- **`btree_gist` on RDS** remains untested (carried).

## Remaining issues

1. **Full E2E suite needs a clean run** on a machine with enough free memory. Stop `npm run dev` and close other heavy processes first. Run it with `npm run test:e2e`, or only the specs that failed: `npx playwright test tests/e2e/reservations.spec.ts tests/e2e/restaurant.spec.ts tests/e2e/scheduling.spec.ts`.
2. **Audit domain: still your decision** (carried since Phase 3). Fulfillment transitions and Remakes now add to the actions with no audit events.
3. **Uncommitted Phase 9 report edits** (the GitHub Actions row and Remaining issue 1) are still in the working tree, along with all Phase 10 changes. Nothing has been committed.
4. **Carried over:** the Phase 6 held-table move gap, the old `restaurant-ops-postgres-1` container and volume, the stray `C:\Users\kneal\package-lock.json` (Next.js warns about it on every start), and the unanchored `out/` and `uploads/` rules in `.gitignore`.

## Accepted risks

DEV-001, DEV-002 and DEV-003: unchanged. No dependencies were added.

## Business domains created beyond Phase 10

NONE. No settlement, tender, tax or payment table exists, and a test asserts there are no settlement or tender tables.

## Next-phase readiness

**Phase 11 readiness: READY after a clean full E2E run**, subject to review of this report. Phase 11 settlement closes the Order; nothing in Phase 10 closes it or bypasses the Table Session guard. A settlement can publish its own events through `writeOutboxEvents`.
