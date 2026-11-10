# Phase 12 Completion Report

This report follows the Phase 12 plan's "Required Phase 12 Completion Report" sections, plus the sections CLAUDE.md requires. Results are from this repository on 2026-11-09.

## Summary

Phase 12 is implemented. A new read-only Reporting module serves eight report areas: sales, menu performance, settlements, orders, inventory, fulfillment, labor and seating. Each area is filtered by Location and business-date range, and each is available as JSON, as a page, and as CSV. `/dashboard` is now an operational overview of one business date's headline figures for each area the user may see. Every report runs in a PostgreSQL `READ ONLY` transaction, so reporting cannot write. Figures come only from snapshots and history, and an integration test proves that changing current prices, costs or wages afterwards changes no report.

**Validation is complete locally:**
- lint, typecheck and build pass;
- unit tests: 625 of 625 pass;
- integration tests: 1037 of 1037 pass;
- E2E: 112 of 112 pass;
- `npm audit --omit=dev`: 0 vulnerabilities;
- migrations rebuild an empty database;
- seeds are idempotent;
- reset safeguards hold.

Committed in `5dfe02f`. GitHub Actions passed on that commit; the project owner reported the result, I did not see the run.

**Problem found by E2E and fixed.** The first full E2E runs failed 13, then 5 tests in other specs: sign-ins as managers landed on the login page. The cause was my bug. The inventory report's supplier-cost section called `toISOString()` on a timestamp that Drizzle's raw `execute` returns as text, not a `Date`. The section only has rows once a supplier cost is recorded that day. My integration fixtures never recorded one, but the E2E inventory spec does, so later dashboards crashed. A baseline run of `d6d3440` (my changes stashed) passed 109 of 109, which confirmed the regression was mine. The fix converts the value safely, and a new integration test covers that section.

**Please review these decisions.** The first four are your answers in planning; the rest are defaults I chose.

1. **Sales basis** (your decision): net sales are CLOSED orders by order business date. Open checks and voids are separate figures.
2. **Labor** (your decision): labor is *scheduled*: published schedules, ACTIVE assignments, non-cancelled shifts. Each assignment is costed at the HOURLY Employee + Position rate in effect on the shift date. Salaried and unrated hours are shown but not costed.
3. **Wage privacy** (your decision): per-employee labor cost also needs `hr.compensation.view`.
4. **Audit** (your decision): deferred again. No `audit_events`.
5. **Cost columns** (menu food cost, inventory costs, supplier costs) also need `inventory.cost.view`, matching Phase 8.
6. **Export** needs `reports.export` *and* the area's permission. Grants are unchanged, so Managers can view but not export, and can't see labor.
7. **ARCHIVED schedule periods count as published labor.** They were published before archiving; dropping them would erase past labor.
8. **Business date only.** There is no calendar-date filter (README §21 lists one), and ranges are capped at 92 days.
9. **Inventory closing quantity** comes from the ledger (`quantity_after` at period end), never from the current balance.
10. **Dashboard figures are streamed** behind a Suspense boundary, so the page and sign-in never wait on report queries.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 (Docker) |
| Drizzle ORM / Kit | 0.45.4 / 0.31.11 |
| New dependencies | None. CSV is written by our own RFC 4180 code; there is no BI, cache or warehouse |

## Policies

The Phase 12 plan has no "Approved Policies" section, so the policies above were decided in planning. README §33 now records them as built in the new "Phase 12 Reporting" section.

| Source | Implemented |
|---|---|
| README §21: read-only, never modify orders, settlements, tenders, inventory, fulfillment, reservations, sessions or schedules | Enforced by `READ ONLY` transactions and proven by a table fingerprint test |
| README §21: indexed aggregation first; no materialized views, Redis or warehouse | Plain SQL aggregation, plus two measured indexes |
| README §21: historical rules | Order price, modifier and discount snapshots; settlement and tender history; ledger costs; effective-dated compensation; fulfillment instants |
| README §21: CSV only | CSV only; no Excel, PDF, scheduling or email |
| README §21: location-aware, server-authorized | Every API resolves the actor at the requested Location; services re-check |
| CLAUDE.md rule 13: one BusinessDateService | New `businessDateStart` / `businessDateRangeBounds` in `src/shared/time/business-date-service.ts`; reporting computes no cutoffs |
| CLAUDE.md rule 14: decimal strings | Money is `SUM(numeric)::text`; labor cost uses the shared BigInt decimal helpers |

## Architectural decisions

- **Module.** `src/modules/reporting/` contains:
  - `types.ts`;
  - `validators/report-filters.ts` (request shape only);
  - `rules/`: pure `csv.ts`, `labor-cost.ts` and `period.ts`;
  - `queries/`: one builder per area plus `report-context.ts`;
  - `services/report-service.ts`: access, the read-only snapshot, export and dashboard.

  It imports no other module's services and owns no tables. Reading other domains' tables directly is reporting's role (README §21). Its SQL never writes, and the transaction mode makes PostgreSQL enforce that.
- **One consistent snapshot per report.** `withReadOnlySnapshot` in `src/db/transactions/` uses `REPEATABLE READ, READ ONLY`, so every section of a report sees the same data.
- **Business-date windows.** `businessDateRangeBounds(from, to, settings)` returns `[start, end)` instants. In a DST gap it searches back to the first instant `businessDateOf` places on the date, so the two functions always agree; unit tests cover 23- and 25-hour days and a cutoff inside a gap.
- **Uniform result shape.** Sections hold typed columns (money, cost, quantity, count, minutes, hours, percent) and rows. The same object drives the JSON API, the page tables and the CSV. Withheld columns are removed from both columns and rows, not blanked.
- **CSV safety.** RFC 4180 quoting, CRLF line breaks, and an apostrophe before text starting with `= + - @`, tab or CR (spreadsheet formula injection). Plain negative numbers stay numeric. File names are sanitized. Responses are `private, no-store` and `nosniff`.
- **Covers** count once per Table Session, on its first closed order, so split checks don't double count.
- **Theoretical food cost** sums the `total_cost` of each item's SEND CONSUME rows through `order_item_inventory_consumption`. Remake consumption is reported under fulfillment and inventory, not as the dish's cost.

### Plan vs repository

| Plan says | Built as | Why |
|---|---|---|
| Read `.github/copilot-instructions.md` | Not used | CLAUDE.md replaces it |
| Eight reporting domains; README §21 lists 16 areas | The extra areas folded into the eight: food cost → Menu; variance, waste, purchasing → Inventory; schedule effectiveness → Labor; server metrics → Orders; reservations, waitlist, turnover → Seating | Approved in planning |
| Permissions `reports.*` | Already in the catalog and granted since Phase 2; no change | Nothing to add |

## Reporting Domain Results

| Domain | Result | Evidence |
|---|---|---|
| Sales | PASS | Canonical scenario: 2 closed orders, gross 32.99, net 32.99, average check 16.50 (half-up), 2 open checks for 9.00, 1 voided item worth 11.00, 2 covers |
| Settlement | PASS | Tenders total 32.99, equal to net sales; tips 5.00; cash received 25.00; change 0.01; tender-type filter; no card metadata in output |
| Order | PASS | Lifecycle 4 / 2 open / 2 closed; void by disposition and reason; results by server |
| Menu performance | PASS | Bacon Cheeseburger (Medium, No Onion, Extra Pickles, Swiss): 17.49 gross, theoretical cost 1.7000 from its consumption snapshot, margin 15.79, food cost 9.72% |
| Inventory | PASS | Swiss 1.0000 used, closing 99.0000, cost 0.1000; beef 8 oz, closing 92; supplier cost change listed |
| Fulfillment | PASS | Grill 1 item completed; all stations 5 items, 1 cancelled by the void; ready-time statistics present |
| Labor | PASS | 4 shifts, 20 h; 135.00 = Monday 5 h × 12.00 + Tuesday 5 h × 15.00 (rate change honoured); 5 h salaried and 5 h unrated not costed; coverage Tuesday 1 unfilled; cancelled shift ignored; employee filter |
| Seating | PASS | 2 sessions, 4 covers, 2 tables, 1.00 turns; 1:15 AM seating counted on the previous business date |
| Dashboard | PASS | Manager sees sales and not labor or menu tiles; inventory cost tile withheld without `inventory.cost.view` |

## Export Results

| Check | Result |
|---|---|
| CSV format (header block, CRLF, quoting) | PASS (unit and integration) |
| Formula injection neutralized | PASS (unit) |
| Single section and whole report | PASS |
| Unknown section → 404 | PASS |
| E2E download as Owner, content verified | PASS |
| `reports.export` plus area permission required | PASS (integration and E2E 403) |

## Authorization Results

| Check | Result |
|---|---|
| `reports.view` required | PASS |
| Each of the eight areas refuses every other area's permission | PASS (exhaustive integration matrix) |
| Manager grants: labor and export refused | PASS (integration, plus E2E page redirect and API 403) |
| Location scope (another location's report refused; location B sees none of A) | PASS |
| Cost columns hidden without `inventory.cost.view` | PASS |
| Per-employee labor cost hidden without `hr.compensation.view` | PASS |
| Server: no Reports nav, page denied, API 403 | PASS (E2E) |
| Signed out: API and export 401 | PASS (E2E) |

## Data Integrity Validation

| Check | Result |
|---|---|
| Reports and exports write nothing | PASS: md5 fingerprints of 20 tables (orders through outbox and idempotency) identical before and after every report, export and the dashboard |
| PostgreSQL refuses writes in the report transaction | PASS: `UPDATE` fails with SQLSTATE 25006 |
| No recalculation from current menu price or stock cost | PASS: burger price set to 99.99 and every balance's average cost to 9.9999; sales, menu, inventory and settlement reports unchanged |
| No recalculation from current compensation | PASS: wage history changed afterwards; labor report unchanged |
| Net sales reconcile to settlement tenders | PASS (exact) |
| BusinessDateService authoritative | PASS (cutoff and DST unit tests; 1:15 AM integration test) |

## Performance Validation

I measured with a throwaway database (`restaurant_ops_perf`, copied from the migrated test database and then dropped). It held 5,000 orders over 92 business dates, 15,000 items, 15,000 ticket items, 15,012 ledger rows, 4,000 settlements and tenders, and 4,000 sessions. Median of three runs, through the real `runReport` code:

| Range | Sales | Menu | Settlements | Orders | Inventory | Fulfillment | Labor | Seating |
|---|---|---|---|---|---|---|---|---|
| 1 day | 12.5 ms | 16.7 | 15.6 | 22.4 | 31.0 | 13.5 | 23.3 | 21.7 |
| 7 days | 27.3 | 24.9 | 21.4 | 22.0 | 22.4 | 16.2 | 13.3 | 22.6 |
| 92 days | 28.6 | 93.8 | 23.8 | 61.1 | 37.8 | 37.2 | 14.3 | 52.9 |

Dashboard (all areas, one day): 81 ms. `EXPLAIN` showed existing indexes serve orders, the ledger, settlements and tenders. Two filters sequential-scanned and grow with history, so migration `0021` indexes them:

| Index | Before | After (7-day window) |
|---|---|---|
| `kitchen_ticket_items (location_id, submitted_at)` | Seq Scan (the queue index has `status` second) | Index Only Scan, 0.37 ms |
| `table_sessions (location_id, seated_at)` | Seq Scan | Index Only Scan, 0.16 ms |

No materialized view or summary table is justified at this volume.

## Migrations

| Migration | Contents |
|---|---|
| `0021_reporting_indexes.sql` | Generated; reviewed: the two `CREATE INDEX` statements above, nothing else |

| Check | Result |
|---|---|
| Generation | PASS |
| Unexplained drift | NONE: a further `db:generate` reports "No schema changes" |
| Development database upgraded | PASS: `db:migrate`, 22 migrations, both indexes present |
| Empty DB reconstruction | PASS: real `db:reset` on a throwaway PostgreSQL 17 container, 22 migrations applied, probe table gone |

**What changed in your development database:** two indexes. Permissions stay 121 and grants stay 438.

## Full Validation Suite Results

| Check | Result |
|---|---|
| PostgreSQL health | PASS |
| npm ci | Not re-run; no dependency changed |
| lint | PASS (0 errors, 0 warnings) |
| typecheck | PASS |
| unit tests | PASS: 625 of 625 (baseline 605) |
| integration tests | PASS: 1037 of 1037 in 56 files (baseline 1009) |
| E2E tests | PASS: 112 of 112 (baseline 109). Earlier runs failed because of the supplier-cost bug above. A baseline run of `d6d3440` passed 109 of 109 |
| production build | PASS (`/reports`, `/reports/[area]`, three report APIs) |
| npm audit --omit=dev | PASS: 0 vulnerabilities |
| npm audit (including dev) | 12 moderate, unchanged (DEV-002) |
| Seed idempotency | PASS: development DB `0 applied, 18 already applied` twice; throwaway DB `18 applied`, then `0 applied, 18 already applied` |
| db:reset safeguards | PASS: refused `NODE_ENV=production`, `NODE_ENV=test`, database `postgres`, database `restaurant_ops_test`, an RDS host, and `?host=`; the probe row survived, then a real reset rebuilt the database; the container was removed |

## Tests executed

| Suite | New | Result |
|---|---|---|
| Unit | `src/modules/reporting/rules/rules.test.ts` (15: CSV, formula guard, labor cost and rate change, percent, range, filters); 5 business-date range tests | 625 of 625 |
| Integration | `tests/integration/reporting/reports.test.ts` (22: every area, reconciliation, history, read-only, export, dashboard, authorization matrix, location scope, cost gating, range validation); `labor-and-dates.test.ts` (6: labor costing, coverage, wage gating, employee filter, effective dating, 1:15 AM cutoff) | 1037 of 1037 in 56 files (baseline 1009) |
| E2E | `tests/e2e/reports.spec.ts` (3: manager overview, menu row, labor and export refused; owner CSV download; server and anonymous refused), with its own account scope (Phase 11 isolation lesson) | 112 of 112 |

## Regression Results

| Area | Result |
|---|---|
| Phases 1–11 integration | PASS (full suite) |
| Phases 2–11 E2E | PASS (112 of 112, including every earlier spec) |
| Navigation unit test | Updated for the new "Reports" entry |
| Dashboard | Non-reporting users see the same Location and roles cards as before |

## Security Review

- **Authorization:** every API resolves the actor at the requested Location with `requireApiPermission`, and `runReport`, `exportReportCsv` and `buildDashboard` re-check `reports.view`, the area code and the Location. Pages check through the same services. Hidden navigation is not relied on.
- **Read-only:** `READ ONLY` transactions; no reporting code calls insert, update or delete.
- **Sensitive data:**
  - Settlement reports never select card metadata or references.
  - Labor reads compensation only to compute aggregates. Per-employee cost needs `hr.compensation.view`.
  - The employee filter list shows name and number only.
  - Cost needs `inventory.cost.view`.
- **Wage inference: resolved after this report** (owner request, 2026-11-09, recorded in `docs/Audit-Domain-Completion-Report.md`). Every labor cost figure and labor % now also need `hr.compensation.view`; `reports.labor` alone shows hours.
- **Injection:** all SQL values are bound parameters through Drizzle's `sql` template; CSV output neutralizes formula prefixes.
- **Errors:** structured `{ error: { code, message, requestId } }`; no SQL or stack traces exposed.

## Files Changed

New:
- `src/modules/reporting/`: `types.ts`, `validators/report-filters.ts`, `rules/{csv,labor-cost,period}.ts`, `rules/rules.test.ts`, `queries/{report-context,sales-report,menu-report,settlement-report,order-report,inventory-report,fulfillment-report,labor-report,seating-report}.ts`, `services/report-service.ts`
- `src/app/api/reports/[area]/route.ts`, `src/app/api/reports/[area]/export/route.ts`, `src/app/api/reports/dashboard/route.ts`
- `src/app/(app)/reports/page.tsx`, `src/app/(app)/reports/[area]/page.tsx`
- `src/components/reports/{format.ts,report-view.tsx,report-tabs.tsx,dashboard-overview.tsx}`
- `drizzle/migrations/0021_reporting_indexes.sql`, `drizzle/migrations/meta/0021_snapshot.json`
- `tests/integration/reporting/{reports,labor-and-dates}.test.ts`, `tests/e2e/reports.spec.ts`
- `docs/Phase-12-Completion-Report.md`

Modified:
- `src/shared/time/business-date-service.ts` (+ test): range bounds
- `src/db/transactions/transaction-context.ts`: `withReadOnlySnapshot`
- `src/db/schema/kitchen.ts`, `src/db/schema/restaurant.ts`: the two indexes; `drizzle/migrations/meta/_journal.json`
- `src/app/(app)/dashboard/page.tsx`: the operational overview
- `src/components/app-shell/navigation.ts` (+ test): "Reports"
- `tests/helpers/e2e-orders.ts`: `REPORTS_SCOPE`, `settleInCashFor`
- `README.md`: §33 "Phase 12 Reporting"

`docs/Phase-11-Completion-Report.md`: your CI-pass edit from before this phase, committed with `5dfe02f`. I didn't change it.

## Architecture Deviations

| Deviation | Reason |
|---|---|
| No calendar-date filter | Business date is the reporting basis (README §29); can be added later |
| No audit viewing (CLAUDE.md asks for it) | Your decision: still deferred |
| Dashboard figures streamed with Suspense | Keeps sign-in and the page independent of report queries |
| `.github/copilot-instructions.md` not used | CLAUDE.md replaces it |

## Risks

1. **Wage inference from position totals: resolved** after this report. All labor cost now needs `hr.compensation.view`.
2. **Scheduled, not actual, labor.** Labor % may differ from payroll; the report and dashboard say so.
3. **Dev-server streaming noise.** E2E runs log "The destination stream errored while writing data" when a test navigates away while the overview is still streaming. It's harmless, and I haven't compared it with the baseline log.

## Outstanding Issues

1. **Audit domain:** still your decision (carried since Phase 3). Phase 13's plan expects "audit verified", so it needs deciding before Phase 13.
2. **Commit and CI: resolved.** Committed in `5dfe02f`; GitHub Actions passed.
3. **Carried over:** the Phase 6 held-table move gap, the old `restaurant-ops-postgres-1` container and volume, the stray `%USERPROFILE%\package-lock.json` (Next.js warns about it on every dev start), and the unanchored `out/` and `uploads/` rules in `.gitignore`.

## Accepted Risks

No new accepted risk. DEV-001, DEV-002 and DEV-003 are unchanged; no dependency changed.

## Next-Phase Readiness

**Phase 13 readiness: READY**, subject to review of this report. CI passed on `5dfe02f`. Phase 13 can reconcile its simulated day against these reports: sales to tenders, consumption to the ledger, fulfillment to tickets, and labor to the published schedule. The audit decision must be made first, because Phase 13 validates audit.
