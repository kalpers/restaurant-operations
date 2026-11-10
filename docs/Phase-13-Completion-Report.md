# Phase 13 Completion Report: Full Integration & End-to-End Validation

## Summary

Phase 13 ran README section 38 as one connected restaurant day, through the application's own services, workflows and screens. Every part of it reconciled:

- **Snapshots:** price, modifiers and recipe revision.
- **Inventory:** exact ledger movement, and every balance equal to the ledger.
- **Fulfillment:** kitchen and bar routing, and the ready notifications.
- **Settlement:** recorded only, closing each order exactly.
- **Floor:** the table turns over through a completed session, DIRTY, then CLEAN.
- **Reports:** every area reconciles with the day.
- **Audit:** one event per audited action, and none for the replayed SEND.

Changing price, recipe, a modifier effect and a wage after the day moved nothing in its history or its reports. BusinessDateService stayed the single authority:

- one second before, exactly at and one second after the 4:00 AM cutoff;
- across a daylight-saving night;
- in every domain, report and audit filter.

**One defect was found and fixed.** On a day with no tenders, the settlements report's all-tenders row showed a blank amount, while sales showed `0.00`. README requires those two figures to reconcile exactly. The query now coalesces tender amount, tips and change to `0.00`, which also matches the row's own declared type.

**Added:**
- 62 integration tests in `tests/integration/validation/`;
- one Playwright full-day spec;
- the opt-in validation seed, `npm run db:seed:validation` (your decision: opt-in, not in the default seeds).

There is no new domain, table, permission, migration or dependency.

**Validation:**
- lint, typecheck, unit (634), integration (1,120), build and `npm audit --omit=dev` all passed locally;
- the full local E2E run was 113 of 115. The 2 failures were load timing; both specs pass when run alone (21/21), and the new day spec passed in the full run;
- **CI passed.** Committed as `867d097`; GitHub Actions completed successfully.

**Please review:**
1. **The opt-in seed acts as the Owner.** The seed-data doc planned a separate `phase13-validation-actor` account. I left it out: to act through the services it would need Owner-level permissions, which would leave a dormant privileged account.
2. **The seed is not one transaction.** The doc says the fixture runs in one transaction. Services commit their own transactions, so instead each step checks whether it is already done and resumes; a finished run is marked in `seed_runs`.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 (Docker) |
| Drizzle ORM / Kit | 0.45.4 / 0.31.11 |
| Vitest / Playwright | 5.1.0 / as locked |
| New dependencies | None |

Windows 11, local Docker PostgreSQL. Baseline: `f3e3ffc` plus the existing uncommitted CI note in `docs/Audit-Domain-Completion-Report.md`, which I left as it was.

## Restaurant-Day Simulation Results

**Integration** (`tests/fixtures/restaurant-day.ts`, `tests/integration/validation/restaurant-day.test.ts`, 17 tests, all passing).

The day runs on a faked `Date` clock (only `Date` is faked; timers stay real), because Scheduling refuses past shifts. Every business timestamp the services write comes from `new Date()`, and PostgreSQL `now()` is only a column default. I checked both before relying on the fake clock.

| Time (America/Detroit) | Step, through the service or workflow named |
|---|---|
| Fri 09:00 | Hourly wages per Employee + Position (`changeCompensation`). The server's login is linked (`linkUser`) |
| Fri 10:00 | The manager drafts Saturday, adds and fills three shifts (one overnight, 16:00–02:00) and publishes (`publishPeriod`) |
| Fri 11:00 | A PENDING reservation for Garcia (4) is confirmed. A purchase order for 24 buns is submitted |
| Sat 14:00 | The buns are received (`receivePurchaseOrder`) |
| Sat 18:30–18:45 | A walk-in joins the waitlist and is seated with the scheduled server (`seatWaitlistParty`) |
| Sat 18:58–19:00 | Garcia checks in (no session is created) and is seated (`seatReservationParty`) |
| Sat 19:05–19:20 | Three sends: Margarita to the Bar, Fries, then the canonical Bacon Cheeseburger |
| Sat 19:21–19:40 | The bartender and the cook run Start, Ready and Bump (`transitionTicketItem`) |
| Sat 20:30 | The settlement is opened; 20.00 cash, then 12.99 on an external card with a 5.00 tip; completed, so the order is CLOSED |
| Sat 20:45–20:55 | The session is still ACTIVE after the order closed. It is completed (table DIRTY), then cleaned (CLEAN) |
| Sat 21:00–21:12 | Takeout fries, card, closed. No session |
| Sat 23:50 → Sun 00:30 | The walk-in orders a Medium-only burger. It settles at 00:30, before the cutoff |
| Sun 00:40–00:50 | The session is completed and the table cleaned |

**What the test confirms:**
- **Canonical burger.**
  - Base 15.99 + modifiers 1.50 = 17.49.
  - Modifier snapshots in order (Medium 0.00, No Onion 0.00, Extra Pickles 0.50, Swiss instead of American 1.00).
  - The recipe and revision IDs.
  - Kitchen instructions "Cook medium; No onion; Extra pickles; Swiss, not American".
  - Consumption of exactly beef 8 oz, bun 1, Swiss 1, pickles 5 and bacon 2. No American and no onion.
- **Ledger.** One CONSUME ledger row per consumption snapshot, on business date 2030-10-05, and every ingredient's balance equal to its last ledger row.
- **Routing.** Tickets to BAR, FRY and GRILL, in send order.
- **Outbox.** `order.items-submitted` three times and `order.closed` once, written in the same commits.
- **Replay.** Replaying the burger's SEND key returns the first result (`replayed: true`, same batch and tickets). It adds no batch, ticket, consumption snapshot, ledger row or outbox row.
- **Notifications.** The server is notified once per ready ticket: Garcia BAR_ORDER_READY + 2 × FOOD_READY, the late check FOOD_READY, and the takeout FOOD_READY.
- **Reservation.** The reservation ends COMPLETED.

**Playwright** (`tests/e2e/restaurant-day.spec.ts`, passing alone in 1.0 min and in the full run in 1.4 min). One browser per role: Owner, Manager, Host, Server, Cook, Bartender, all on seeded roles. On screen:
1. the manager publishes the week;
2. the host creates a Pending reservation, confirms it, checks it in and seats it;
3. the server opens the order from the floor and sends drinks, then fries, then the burger with all four modifiers. The draft shows $17.49 and consumes nothing; after SEND, pickles are 45, Swiss 49, and American and onion unchanged;
4. the bar and the kitchen run their cards, and the kitchen card shows "Swiss instead of American";
5. the server's bell shows 3;
6. the server settles: cash 20.00, then the card for 12.99 with a 5.00 tip, and the order is CLOSED;
7. the host completes the session (Dirty), then marks it clean (Available);
8. the owner's menu report shows $17.49, and the CSV export has the row;
9. the audit page shows 3 `orders.items-sent` and 1 `settlements.completed` by this server.

Setup (accounts, menu, table, draft week) uses services. Cleanup only disables the spec's accounts, which takes no table lock.

## Cross-Domain Validation

Each hand-off in the chain is asserted on one connected record set:

- **Scheduling → Restaurant.** The scheduled server seats parties without an override, because the published 2030 shift is running on the faked clock.
- **Reservations → Restaurant.**
  - Checking in creates no session.
  - Seating creates the Table Session.
  - Completing the session completes the reservation.
- **Restaurant → Orders.**
  - Orders reference the session, never the table.
  - The assigned server comes from the session.
- **Orders → Inventory and Kitchen.** SEND writes the snapshots, the ledger and balances, and the tickets atomically.
- **Kitchen → Notifications.** The ready notification goes to the session server's linked user.
- **Settlements → Orders.**
  - The completion closes the order.
  - The table session stays ACTIVE.
  - Settlement changes no inventory.
- **Inventory → Reporting** and **Settlements → Reporting.** Reconciled below.

`historical-integrity.test.ts` (3 tests) changes the configuration after the day, effective before it:
- the burger's price (now 21.00);
- a new recipe revision (double bacon);
- a new modifier effect;
- a raise effective Sunday.

It confirms the operational menu asked about the moment of the SEND now really says 21.00. Every order, item, modifier, consumption snapshot, ledger row, settlement and tender is unchanged, and all eight report areas for the day are identical.

## Concurrency Validation

**Already covered by the domain suites**, and not repeated:

| Race | Existing test |
|---|---|
| Two SENDs of one order | `orders/submission.test.ts`, "serializes two simultaneous sends" |
| One reservation seated twice; two parties on one table | `reservations/holds-and-seating.test.ts`, "concurrent seating" |
| Many simultaneous seatings of one table | `restaurant/seating.test.ts` |
| Two terminals taking the last balance; two completions | `settlements/settlements.test.ts` |
| Two cooks starting one item | `kitchen/lifecycle.test.ts` |

**Added** in `concurrency.test.ts` (4 tests):
- **Order edits.** Two simultaneous draft edits of one order at the same version: one wins, the other gets `CONCURRENCY_CONFLICT`, and the version moves once.
- **SEND against settlement-open** on the same order, 6 rounds. Whichever commits first, the settlement snapshot always equals the order's final subtotal. The loser is refused only with `SETTLEMENT_IN_PROGRESS`.
- **Scheduling.** Two managers filling one shift at one period version: one assignment, one conflict.
- **Edit against publish.** An assignment racing a publish. Either the period is PUBLISHED without the assignment, or it is DRAFT with it; never a published schedule that differs from what was checked.

## Security Validation

`security-matrix.test.ts` (22 tests) runs on the simulated day's real data:

- **Reports.** For each of the eight areas, the report is refused without its area code and refused without `reports.view`, and allowed with both.
- **Export.**
  - It is refused without `reports.export`, and a refused export writes no `reports.exported` event.
  - An allowed export writes one.
- **Labor without `hr.compensation.view`.** The hours are shown (25.0000). There is no cost column. No figure that would reveal a wage appears in the report, its CSV or the dashboard: the total 362.00, the per-shift costs, or the rates.
- **Costs without `inventory.cost.view`.** No cost column in the menu or inventory reports.
- **Tenders.** Each of the five tender types is refused without its own permission. Voiding a tender is refused without `settlements.void-tender`.
- **Card metadata.** The last four digits and the provider appear only with `settlements.view-card-metadata`.
- **Location isolation.** The organization's owner, resolved at location B:
  - finds location A's order, settlement and kitchen work absent (`NOT_FOUND`);
  - is refused A's reports, export and audit trail;
  - sees none of the day at B.
- **HR boundaries.**
  - The management tier is refused compensation and personal data.
  - A permitted compensation read returns the wage, and its own `hr.compensation-viewed` event holds no amount.

**Authentication** at the HTTP boundary (signed-out 401s, a forged location cookie, disabled users, cookie flags, no registration) is covered by `auth.spec.ts` and the per-domain "signed out" E2E tests, which all passed in the full run.

## Business-Date Validation

`business-date.test.ts` (8 tests) runs a complete takeout sale at each instant: order, SEND, settlement open, tender, completion, plus a waste posting.

| Instant | Expected business date |
|---|---|
| 2030-10-13 03:59:59 | 2030-10-12 |
| 2030-10-13 04:00:00 | 2030-10-13 |
| 2030-10-13 04:00:01 | 2030-10-13 |
| 2030-11-03 01:30 EDT (05:30Z) | 2030-11-02 |
| 2030-11-03 01:30 EST (06:30Z) | 2030-11-02 |

**Results:**
- **Stamps.** For each sale, the order, consumption ledger, settlement opened and completed, tender and waste dates all equal `businessDateOf`.
- **Reports** split exactly at the cutoff:
  - 2030-10-12 has 1 sale and 2030-10-13 has 2;
  - the 25-hour fall-back date holds both 1:30 AM sales;
  - the next date has none;
  - in each case, tenders equal net sales.
- **Audit.** The audit viewer's business-date filter places the completions and wastes the same way.
- **Unit tests** (`business-date-service.test.ts`, carried) still cover the DST gap and range bounds.

In the full day, the 00:30 Sunday check carries Saturday on the order, the settlement and the tender, and appears in Saturday's reports and audit range.

## Data Integrity Validation

- **Ledger.** After the day, each touched item's balance equals its last ledger row. The validation seed checks the same across every balance.
- **Snapshots** are immutable under configuration change (historical-integrity, above).
- **Idempotency.** A SEND replay adds nothing. A second `db:seed` applies 0 of 18 seeds. A second `db:seed:validation` adds no row to any of the 19 tables it touches.
- **Empty-database reconstruction.** `database/migrations.test.ts` rebuilt from an empty database within the integration run, and the validation-seed test built a second database from zero: migrate, seed, Owner bootstrap, fixture.
- **No direct writes in the simulation.** The only scaffolding is the fixture organization, locations, areas, positions and role-holding actors. Areas and positions are inserted directly because no service creates an organization. The opening stock of the kitchen scenario posts through the Inventory domain's ledger API.

## Reporting Reconciliation

For business date 2030-10-05, every figure equals the operations that produced it:

| Area | Report | From the operations |
|---|---|---|
| Sales | 3 closed orders, 6 covers, gross and net 53.48, 0 open, 0 voids | 32.99 + 4.50 + 15.99 |
| Settlements | 4 tenders = 53.48, tips 5.00, cash received 40.00, change 4.01 | Equals net sales exactly |
| Menu | Burger ×2 = 33.48, Fries ×2 = 9.00, Margarita ×1 = 11.00; Swiss modifier ×1 = 1.00 | From item and modifier snapshots |
| Inventory | Bun received 24, theoretical 2, closing 122; beef 16; pickles 8 | The SEND ledger rows and the receipt |
| Fulfillment | 5 items, 5 completed; Grill 2 | The ticket items |
| Labor | 3 shifts, 25.0000 h, 362.00 | 10 h × 12.00 + 7 h × 14.00 + 8 h × 18.00, from the published schedule |
| Seating | 2 sessions, 6 covers, 2 tables | The two Table Sessions |
| Audit | 1 publish, 3 wage changes, 1 receipt, 5 SEND batches, 3 opened, 4 tenders, 3 completed | The replay wrote nothing |

The next business date (Sunday) shows 0 closed orders. No audit event holds a wage amount, card number, provider or employee email.

## Validation Suite Results

| Check | Result |
|---|---|
| `npm ci` | Not re-run: no dependency changed; the installed tree is unchanged since Phase 12 |
| `npm run db:generate` | "No schema changes, nothing to migrate" |
| `npm run db:migrate` | Applied (PostgreSQL "already exists" NOTICEs only) |
| `npm run db:seed` ×2 | "0 applied, 18 already applied" both times |
| `npm run db:seed:validation` ×2 (dev DB) | First: 4 employees, schedule published, dine-in, takeout, upcoming reservation. Second: "already applied; nothing to do" |
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm run test:unit` | 37 files, 634 tests, pass |
| `npm run test:integration` | 63 files, 1,120 tests, pass (553 s) |
| `npm run test:e2e` | 113 passed, 2 failed (load timing, below). Both failed specs pass alone: 21/21 |
| `npm run build` | Pass |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (dev) | 11 moderate, the two DEV-002 advisories (`esbuild`, `minimatch`); was 12 findings, no new advisory |
| Reset safeguards | Refused for a remote host, a database not named `restaurant_ops`, and `NODE_ENV=production`, each before any action |
| Validation seed guard | Refused a non-loopback `DATABASE_URL` (script and test) |

**The two E2E failures.** In each, a click's request hadn't landed within the 5-second assertion wait:
- `orders.spec.ts`: the burger still showed "Not sent" after SEND;
- `restaurant.spec.ts` "combines and removes a table": the combined table still showed "Available".

This is the same local memory pressure noted in Phases 10–12; during this phase the Docker PostgreSQL also restarted once on its own. Neither path touches code changed here. CI is the authority for the full suite.

## Regression Status

- **Earlier tests.** No existing test was changed, and all 1,058 integration tests from before Phase 13 still pass.
- **The one behavior change** is the settlements report's all-tenders row: `0.00` instead of blank when there are no tenders. No test asserted the blank. The new business-date test locks in the fix.
- **`scripts/seed-demo.ts`** now uses the shared guard and Owner lookup, with the same checks and messages.

The lookup also fixes a small bug: with no MAIN location it threw a `TypeError` instead of the intended message.

## Files Changed

**New:**
- `tests/fixtures/restaurant-day.ts`: the simulated day, the fake clock helpers and the reporter permissions.
- `tests/integration/validation/`, 62 tests:
  - `restaurant-day.test.ts` (17)
  - `historical-integrity.test.ts` (3)
  - `business-date.test.ts` (8)
  - `concurrency.test.ts` (4)
  - `security-matrix.test.ts` (22)
  - `validation-seed.test.ts` (8)
- `tests/e2e/restaurant-day.spec.ts` and `tests/helpers/e2e-day.ts`.
- `scripts/seed-validation.ts`, `scripts/validation-fixture.ts`, `scripts/local-seed-guard.ts`, `src/db/demo/validation-fixture.ts`.
- `docs/Phase-13-Completion-Report.md`.

**Edited:**
- `src/modules/reporting/queries/settlement-report.ts`: the fix.
- `src/workflows/submit-order/submit-order.ts`: the comment still said audit events were "deferred", and now lists the actual step order.
- `scripts/seed-demo.ts`: uses the shared guard.
- `package.json`: `db:seed:validation`.
- `README.md`: a section 33 "Phase 13 Validation" note.
- `CLAUDE.md`: the opt-in seed commands.
- `docs/Phase-13-Validation-Seed-Data.md`: rewritten to describe what was built.

**Migrations:** none.

## Architecture Deviations

None from README.

Choices that differ from the Phase 13 docs:
1. **The validation seed is opt-in.** It is not in the default seed list. Your decision.
2. **There is no `phase13-validation-actor` account.** The fixture acts as the bootstrapped Owner, as `db:seed:demo` does.
3. **The fixture is resumable steps plus a `seed_runs` marker, not one transaction.** Services commit their own transactions; the alternative was to write rows directly.
4. **There is a single key, `phase13.validation-fixtures`,** with none of the doc's v1/v2 history, because no earlier version was ever applied here.
5. **Records are dated at run time,** because the services use the real clock. The schedule keeps its 2030 dates.

## Outstanding Issues

1. **CI and commit.** Resolved: committed as `867d097`, and GitHub Actions passed.
2. **Other E2E cleanups still lock tables.** The orders and kitchen E2E cleanups still use `ALTER TABLE … DISABLE TRIGGER` on order and settlement tables. That is the lock pattern `f3e3ffc` removed from the audit cleanup. It may contribute to local and CI flakiness. Switching them to `session_replication_role` is a small, separate test-only change; I haven't made it.
3. **Outbox log line at test start.** In every Playwright run, the dev server's outbox poller logs one "Outbox batch failed; it will be retried". That happens because global setup recreates the test database while the server is already polling. The runner then recovers by design.
4. **The known streaming log** "The destination stream errored while writing data" still appears when a test navigates away mid-stream (carried from Phase 12).
5. **Carried over:**
   - the Phase 6 held-table move gap;
   - the old `restaurant-ops-postgres-1` container and volume;
   - the stray `C:\Users\kneal\package-lock.json`;
   - the unanchored `out/` and `uploads/` rules in `.gitignore`;
   - the optional `postgres:17` image.
6. **Dev database.** It now holds the validation fixture (`phase13.validation-fixtures`). `npm run db:reset` removes it if you don't want it.

## Accepted Risks

No new accepted risk.
- **DEV-001** is unchanged; `braces` is still not reported.
- **DEV-002** has the same two advisories, now 11 findings instead of 12.
- **DEV-003** is unchanged.

No dependency changed.

## Next-Phase Readiness

**Phase 14 (AWS POC deployment) readiness: READY, CI is green on `867d097`; subject to review of this report.** The application works end to end as one system, and nothing in it is AWS-specific.

Phase 14 should:
- run `db:migrate` and `db:seed` only;
- never run `db:seed:demo` or `db:seed:validation`, both of which refuse a non-loopback database;
- check `btree_gist` on RDS (carried since Phase 6).

`tests/e2e/restaurant-day.spec.ts` is a ready-made candidate for the Phase 15 acceptance run against AWS.
