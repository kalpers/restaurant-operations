# Audit Domain Completion Report

The audit domain was built as its own step between Phase 12 and Phase 13. The project owner decided this on 2026-11-09, closing a question open since Phase 3. This report uses the same sections as the phase reports. Results are from this repository on 2026-11-09.

## Summary

The audit trail now exists:
- **Table:** `audit_events`, append-only. A trigger refuses UPDATE, DELETE and TRUNCATE.
- **Atomic writes:** every audited action writes its event inside its own transaction. An action that rolls back leaves no event, and an event can't exist without its action.
- **Allow-listed content:** a single registry lists each action and the only fields its event may keep. Wages are recorded as "changed", never as amounts. Personal HR changes record field names, never values. Card, provider and authorization details are never copied.
- **Viewer:** `/audit` and `GET /api/audit`, gated by the existing `audit.view` permission (Owner and General Manager).
- **Coverage:** sign-in and sign-out; security administration; HR changes and restricted HR reads; scheduling; SEND, voids and discounts; menu and recipe changes; inventory movements; settlements; CSV exports.

**Validation is complete locally:**
- lint, typecheck and build pass;
- unit tests: 634 of 634 pass (Phase 12: 625);
- integration tests: 1058 of 1058 pass, in 57 files (Phase 12: 1037);
- E2E: 114 of 114 in the final full run. An earlier full run failed one test, `restaurant.spec.ts` "assigns a server", the same test the Phase 11 report recorded as flaky under load. It passed 18 of 18 when its spec ran alone, and it touches no audited code;
- `npm audit --omit=dev`: 0 vulnerabilities;
- migrations rebuild an empty database, and `db:generate` reports no schema changes;
- seeds are idempotent;
- reset safeguards hold.

**CI.** The project owner reported both runs; I did not see them.
- **Run #23 on `82da236`: failed.** 3 E2E tests failed and 11 were flaky, across unrelated specs.
- **Run on `f3e3ffc`: passed.** That commit makes the test cleanup lock-free (see Regression Results).

**Please review these decisions.** The first three are yours, from 2026-11-09; the rest are defaults I chose while building.

1. **When** (your decision): its own step before Phase 13, with this report.
2. **Scope** (your decision): sensitive and money actions. The list is under Audit Coverage.
3. **Content** (your decision): allow-listed before and after fields only, and wage amounts never recorded.
4. **Sign-in failures are recorded only for known accounts,** with the reason `BAD_PASSWORD` or `DISABLED`. An unknown email writes nothing, and the typed email is never stored. The failure's event is written **after the response is sent** (Next.js `after`), so a wrong password on a real account answers in the same time as an unknown email (see Follow-up fixes).
5. **Sign-out is recorded best-effort.** The session ends whether or not the event is written, and a failure is logged.
6. **Restricted reads are fail-closed.** Viewing personal data, compensation, sensitive notes, reviews or disciplinary records, or downloading a document, writes its event in the same transaction as the read. If the event can't be written, no data is returned.
7. **A CSV export is recorded after the READ ONLY report** in a short write transaction. If that write fails, the export is refused.
8. **Organization-level events** (sign-in, roles, users) have no location. Anyone holding `audit.view` at any location of the organization can see them.
9. **Free text is not copied.** This covers HR status reasons, inventory notes and note or review content. Void, discount and settlement reasons are kept, because they explain money movements.
10. **Viewing the audit trail is not itself audited.**
11. **Request IDs** reach the audit writer through request context (`AsyncLocalStorage`) set by `apiRoute`, so no service signature changed. Pages, Auth.js callbacks and CLI scripts record no request ID.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 (Docker) |
| Drizzle ORM / Kit | 0.45.4 / 0.31.11 |
| New dependencies | None. `AsyncLocalStorage` is built into Node.js |

## Policies

- README §20: audit answers who, what, when, where and to which entity. It is append-only, permission-controlled, and never holds passwords, hashes, tokens, secrets, payment data or unnecessary HR data.
- CLAUDE.md rule 11: audit records are append-only. Rule 15: never log or audit secrets, payment data or unnecessary HR data.
- Domain histories stay the source of truth for values: the inventory ledger, status histories, price, recipe and compensation history. Audit records who initiated a change.

## Architectural decisions

- **Module `src/modules/auditing/`:**
  - `audit-actions.ts`: the registry;
  - `rules/sanitize.ts`: the allow-list filter and the sensitive-name check;
  - `services/audit-writer.ts`: `recordAudit` and `auditedRead`;
  - `queries/audit-queries.ts`: the viewer;
  - `validators/audit-filters.ts`.

  Other modules call only `recordAudit` and `auditedRead`, through `index.ts`.
- **`recordAudit` takes a `DatabaseTransaction`, never a database handle,** the same way `writeOutboxEvents` does, so the type system keeps it inside the caller's transaction. It resolves the acting user's linked employee in the same INSERT with a subquery, with no extra round trip.
- **`withExecutorTransaction`** was added to `src/db/transactions/`. Some HR services accept either a database or a caller's transaction; they now open a transaction (or a savepoint) so their update and its audit event commit together.
- **Services wrapped in a transaction for the first time:**
  - `createRole`;
  - menu `createItem` and `updateItem`;
  - `updateEmployeeGeneral`, `updatePersonalContact`, notes, reviews, disciplinary records and the document insert;
  - swap acceptance and denial;
  - the successful sign-in's `last_login_at` update.

  These changes affect only atomicity. The business rules are unchanged.
- **Document downloads** authorize and record inside a transaction, and read the file after commit, because file storage is never called inside a transaction.

## Audit Coverage

| Category | Actions |
|---|---|
| ACCESS | `auth.signed-in`, `auth.sign-in-failed`, `auth.signed-out` |
| SECURITY | `auth.owner-bootstrapped` (SYSTEM), `admin.role-created`, `admin.role-activated`, `admin.role-deactivated`, `admin.role-permissions-replaced` (added and removed codes), `admin.user-created`, `admin.user-enabled`, `admin.user-disabled` (also on termination), `admin.role-assigned`, `admin.role-removed` |
| HR | `hr.employee-created`, `hr.employee-updated`, `hr.status-changed`, `hr.employee-terminated`, `hr.personal-updated`, `hr.position-assigned`, `hr.position-ended`, `hr.position-primary-set`, `hr.location-assigned`, `hr.location-ended`, `hr.location-primary-set`, `hr.record-created` and `hr.record-updated` (notes, reviews, disciplinary, documents, certifications), `hr.compensation-changed` |
| HR reads | `hr.personal-viewed`, `hr.compensation-viewed`, `hr.records-viewed` (sensitive notes, performance, disciplinary), `hr.document-downloaded` |
| SCHEDULING | `scheduling.period-published`, `scheduling.period-archived`, `scheduling.swap-accepted`, `scheduling.swap-approved`, `scheduling.swap-denied` |
| ORDERS | `orders.items-sent` (one per SEND, none on replay), `orders.item-voided`, `orders.order-voided`, `orders.discount-applied` (with `isComp` and amount), `orders.discount-removed` |
| MENU | `menu.price-changed`, `menu.item-created`, `menu.item-updated`, `recipes.revision-created`, `recipes.revision-published`, `recipes.revision-retired` |
| INVENTORY | `inventory.adjusted`, `inventory.waste-recorded`, `inventory.transferred`, `inventory.count-approved`, `inventory.po-received` |
| SETTLEMENTS | `settlements.opened`, `settlements.tender-recorded`, `settlements.tender-voided`, `settlements.completed`, `settlements.cancelled` |
| REPORTING | `reports.exported` |

**Not recorded:**
- viewing the audit trail;
- ordinary reads, and the management-tier employment view (`hr.view`);
- draft order edits;
- kitchen status changes, which have their own history;
- table and reservation operations, which have their own history and were outside the approved scope;
- shift swap requests and cancellations by the requester;
- schedule drafting.

## Authorization Results

- **API and page:** `GET /api/audit` uses `requireApiPermission("audit.view", locationId)`. The query checks `audit.view` again, and refuses any location other than the actor's. `/audit` uses `requirePageActor("audit.view")`.
- **Integration tests:**
  - a user without `audit.view` is refused (`PERMISSION_DENIED`);
  - so is a user with it asking for another location;
  - an auditor at location B never sees location A's events.
- **E2E:** a Manager (no `audit.view`) has no Audit menu entry, is sent to `/access-denied`, and gets 403 from the API.
- **Grants:** none changed. Owner and General Manager hold `audit.view` from Phase 2.

## Data Integrity Validation

All integration-tested:
- **Append-only:** `UPDATE`, `DELETE` and `TRUNCATE` on `audit_events` fail with `check_violation`.
- **Atomic:** an action whose transaction rolls back leaves no event.
- **Idempotent SEND:** the canonical Bacon Cheeseburger SEND writes exactly one `orders.items-sent`, and a retry with the same key is replayed and writes none.
- **No wage amounts:** a compensation change to 23.75 records `rate: true`, and the string `23.75` appears nowhere in the employee's events.
- **No personal values:** a phone change records `changedFields: ["phone"]`, and the number appears nowhere.
- **No card details:** an external-card tender's last four, brand and authorization reference appear nowhere in the settlement's events.
- **Sign-in:** a successful sign-in and a wrong password are recorded, without the email or password. A disabled account records `DISABLED`; an unknown email writes nothing.
- **Request context:** the request ID and the acting user's linked employee are recorded. Unlisted fields and nested objects are dropped.
- **Reporting is still read-only:** the Phase 12 checksum test, run with exports, still passes.

## Migrations

| Migration | Contents |
|---|---|
| `0022_audit_events.sql` (generated) | `audit_events` table: CHECKs on action format, category, actor type, actor consistency and request ID length; RESTRICT foreign keys to organizations, locations, users and employees; four indexes (`organization_id, sequence`), (`location_id, sequence`), (`entity_type, entity_id`), (`actor_user_id, sequence`) |
| `0023_audit_constraints.sql` (custom) | `BEFORE UPDATE OR DELETE` row trigger and `BEFORE TRUNCATE` statement trigger, both reusing `refuse_history_change()` from `0012` |

- **Upgrade:** the migration test upgrades a Phase 12 database in place and finds an empty trail with both triggers.
- **Drift:** `db:generate` reports "No schema changes".
- **Dev database:** migrated to 24 migrations.

## Full Validation Suite Results

| Check | Result |
|---|---|
| lint | PASS |
| typecheck | PASS |
| Unit tests | 634 of 634 (37 files) |
| Integration tests | 1058 of 1058 (57 files) |
| E2E (final full run) | 114 of 114. An earlier full run had 113 passed, 1 failed (`restaurant.spec.ts` "assigns a server": the Phase 11 load flake; its spec then passed 18 of 18 alone) |
| E2E (audit spec) | 2 of 2 |
| Build | PASS (`/audit` and `/api/audit` built) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (with dev) | 11 moderate (Phase 12 recorded 12). No dependency changed; the advisory database changed. DEV-002 still covers them |
| `db:generate` | No schema changes |
| `db:seed` twice (dev) | 0 applied, 18 already applied, both times |
| `db:reset` safeguards (throwaway container on 127.0.0.1:15433) | Refused `NODE_ENV=production`, `NODE_ENV=test`, database `postgres`, and an RDS host. A real reset rebuilt 24 migrations with both audit triggers; seeds applied 18, then 0. Container removed |

## Tests executed

- **Unit** (`src/modules/auditing/rules/sanitize.test.ts`, 9 tests):
  - the allow-list drops unlisted fields and nested objects;
  - dates are stored as ISO text, and decimal strings are unchanged;
  - `changedOnly` stores `true`/`false`, never the value;
  - changed field names are listed without values;
  - **every registry field passes the sensitive-name check**;
  - every action name matches the table's format.
- **Unit:** the navigation test now includes "Audit".
- **Integration** (`tests/integration/auditing/audit-trail.test.ts`, 19 tests): everything under Data Integrity Validation and Authorization Results, plus:
  - role creation is organization-level;
  - void disposition and reason;
  - settlement open, tender and complete;
  - CSV export with range and row count;
  - fixture set-up through the menu, price and recipe services was audited;
  - newest-first ordering, cursor paging over 105 events, and the 92-day range limit.
- **Integration:** the migration test expects `audit_events` and its triggers.
- **E2E** (`tests/e2e/audit.spec.ts`, own `AUDIT_SCOPE` accounts):
  - an Owner finds a Manager's settlement completion, their own sign-in, and their own earlier wrong-password attempt (`BAD_PASSWORD`, written after the response) on `/audit`;
  - a Manager has no menu entry, page or API access.

## Regression Results

The full integration suite ran with every hook in place before the new test file was added. All 1038 tests passed: the 1037 from Phase 12 plus the new migration test. No existing test needed a behavioral change.

Test teardown had to change. Teardown that deletes users, employees or locations now first removes their audit events, using `tests/fixtures/audit-cleanup.ts`. Audit events reference those rows with RESTRICT, so the helper deletes the events inside a transaction that runs `SET LOCAL session_replication_role = replica`. That skips triggers for that transaction only and takes no table lock. Application code never deletes audit events.

The first version used `ALTER TABLE audit_events DISABLE TRIGGER`. That takes an ACCESS EXCLUSIVE lock on a table nearly every action writes to, sign-in included. It could therefore stall the other E2E worker while one spec cleaned up. CI run #23 on `82da236` failed widely, and CI passed once `f3e3ffc` removed the lock. Locally, though, I sampled lock waits through a full E2E run and caught none. So the lock is the likely cause of #23, not a proven one.

## Security Review

- **No secrets or payment data:** passwords, hashes, tokens, secrets, card numbers, CVV and PINs are never passed to the writer. A unit test refuses any registry field named like them.
- **No wage amounts or personal values:** neither appears in any event, and tests check this.
- **No enumeration from the sign-in message:** the failure message stays identical, and unknown emails write nothing. One side effect remains, under Risks.
- **Viewer exposure:** the viewer shows actors by employee name, or email when no employee is linked. Only holders of `audit.view` see it.
- **Stored JSON is constrained:** before/after JSON holds only primitive values and string lists. The page renders it as escaped text.

## Files Changed

**New**
- `src/modules/auditing/`:
  - `audit-actions.ts`, `index.ts`
  - `rules/sanitize.ts` (+ test)
  - `services/audit-writer.ts`
  - `queries/audit-queries.ts`
  - `validators/audit-filters.ts`
- `src/db/schema/auditing.ts`
- `src/shared/http/request-context.ts`
- `src/app/api/audit/route.ts`, `src/app/(app)/audit/page.tsx`
- `drizzle/migrations/0022_audit_events.sql`, `0023_audit_constraints.sql`, meta snapshots
- `tests/integration/auditing/audit-trail.test.ts`, `tests/e2e/audit.spec.ts`, `tests/fixtures/audit-cleanup.ts`
- `docs/Audit-Domain-Completion-Report.md`

**Modified**
- Infrastructure:
  - `src/shared/http/api-route.ts`: request context
  - `src/db/transactions/transaction-context.ts`: `withExecutorTransaction`
  - `src/db/schema/index.ts`
  - migrations journal
- Auth:
  - `auth-options.ts`: sign-out event; failed sign-in audit deferred with `after`
  - `credential-service.ts`, `owner-bootstrap.ts`, `role-service.ts`, `user-service.ts`
  - `user-repository.ts`: `findUserOrganizationIds`
- Employees:
  - services `employee`, `personal`, `compensation`, `status`, `assignment`, `note`, `review`, `document` and `certification`
  - `access.ts`: exports `scopeOf`
  - `assignment-repository.ts`: returns `positionId`
- Scheduling: `schedule-service.ts`, `swap-service.ts`
- Orders and settlements:
  - workflows `submit-order`, `void-order-item`, `complete-settlement`
  - `discount-service.ts`, `settlement-service.ts`
- Menu, recipes and inventory:
  - `pricing-service.ts`, `catalog-service.ts`, `recipe-service.ts`
  - `stock-operations.ts`, `count-service.ts`, `receiving-service.ts`
- Reporting: `report-service.ts` (export event; dashboard labor tiles gated), `labor-report.ts` (all labor cost gated); `tests/integration/reporting/labor-and-dates.test.ts`
- Navigation: `navigation.ts` (+ test): "Audit"
- Tests:
  - `employee-fixtures.ts`
  - E2E helpers `accounts`, `employees`, `inventory`, `menu`, `reservations`, `restaurant`, `scheduling`: audit cleanup before deletes
  - `e2e-orders.ts`: `AUDIT_SCOPE`
  - `migrations.test.ts`
- Docs:
  - `README.md`: §33 "Audit Domain" notes; §36 "Audit Domain (before Phase 13)" deliverables; the Phase 12 audit sentence now points to them
  - `docs/Phase-12-Completion-Report.md`: CI result recorded earlier today

## Follow-up fixes

Both were made on 2026-11-09 at the owner's request, after the first version of this report.

1. **Sign-in timing closed.**
   - **Before:** a failed sign-in to a known account wrote its audit row before answering, and an unknown email wrote nothing. The roughly 1 ms difference could in principle hint that an account exists.
   - **Now:** `verifyCredentials` takes `deferFailureAudit`, and the sign-in route passes one that runs the write with Next.js `after()`, after the response is sent. Both failure paths now do the same work before answering: a lookup plus an Argon2 check. Outside a request scope the write still never blocks the answer. Tests and scripts that pass nothing write inline, as before.
   - **Tests:**
     - **Integration:** the call returns with nothing written, and the deferred task then writes `BAD_PASSWORD`.
     - **E2E:** a real wrong-password attempt appears on `/audit`.
2. **Phase 12 wage inference closed.**
   - **Before:** labor cost by position and by date was visible with `reports.labor` alone. Any position or day with one person scheduled revealed their rate as cost ÷ hours.
   - **Now:** every labor cost figure needs `hr.compensation.view` as well: summary, by position, by date and position, per employee, and the dashboard's labor cost tile. Labor % of sales needs both `hr.compensation.view` and `reports.sales`. Without them, labor shows hours, salaried hours and no-rate hours only.
   - **Why not hide single-employee positions instead:** that would not cover a single person on a given day.
   - **Effect on seeded roles:** none. Only Owner and General Manager hold `reports.labor`, and both hold `hr.compensation.view`.
   - **Tests:** no section has a cost column without the permission. With `reports.sales` but not `hr.compensation.view`, there is no labor % and the dashboard shows only the hours tile.

## Architecture Deviations

| Deviation | Reason |
|---|---|
| A step outside the numbered phases | Your decision. Under CLAUDE.md's rule, Phase 13 stays the next phase |
| Sign-out audit is not atomic | Signing out changes no database state; the session ends regardless |
| CSV export audit is a separate transaction | The report must stay READ ONLY; the export is refused if the event can't be written |
| Tables, reservations and waitlist not audited | Outside the approved scope; they have their own histories |

## Risks

1. **Deferred failure events.** A failed sign-in's event is written just after the response. If the server stops in that moment, the event is lost and the failure is logged. Sign-ins themselves are unaffected.
2. **Trail growth.** Every SEND, tender and sign-in adds a row, with no retention or archiving. Four indexes keep the viewer fast. Retention is a later decision.
3. **Org-level visibility.** A General Manager at one location sees organization-wide sign-ins and role changes. With one location today this changes nothing.
4. **The E2E flake** in `restaurant.spec.ts` remains (carried from Phase 11).

## Outstanding Issues

1. **Commit and CI: resolved.** Committed in `82da236` and `f3e3ffc`; CI passed on `f3e3ffc`.
2. **Carried over:**
   - the Phase 6 held-table move gap;
   - the old `restaurant-ops-postgres-1` container and volume;
   - the stray `%USERPROFILE%\package-lock.json`;
   - the unanchored `out/` and `uploads/` rules in `.gitignore`.
3. **New image:** the reset check pulled `postgres:17` locally (about 150 MB); remove it with `docker image rm postgres:17` if not wanted.

## Accepted Risks

No new accepted risk. DEV-001, DEV-002 and DEV-003 are unchanged; no dependency changed.

## Next-Phase Readiness

**Phase 13 readiness: READY**, subject to review of this report. CI passed on `f3e3ffc`. Phase 13's "audit verified" step can now check that each step of the simulated day left its event. Examples: SEND once per batch, a settlement's open, tender and complete, and a schedule publish. It can also check that no event holds wage amounts, personal values or card details.
