# Phase 6 Completion Report

This report merges the plan §74 template with the sections required by CLAUDE.md. Results are from this repository on 2026-11-08.

## Summary

Phase 6 is implemented and validated locally. A host can take a reservation, optionally plan tables for it, check the party in, and seat it at whichever tables are actually free. A host can add a walk-in to the waitlist, record a quote and a notification, take a suggested table and seat the party, or seat a walk-in at once. Reservations and the waitlist never make a table occupied: only a committed Phase 5 Table Session does, and a database index allows one active session per Guest Party.

**Not yet confirmed:**

- **`db:reset` on your real development database:** deliberately not run, because it would delete your Owner account. The same command was proven on a throwaway PostgreSQL container.

**Please review these decisions** (all but the first were in the plan I presented before coding; the first is a gap I found, not a choice):

1. **Moving a seated party onto a held table isn't checked.** See Remaining issues, item 1.
2. Planning has no capacity override; the Phase 5 override applies when seating.
3. Cancelling a mistaken seating puts the party back where it was (§3 of Policies below).

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |

No dependencies were added or changed.

## Policies

The "Approved Phase 6 Business Policies" in plan §2 were treated as binding.

### Decided by the project owner when approving the plan

| Conflict or gap | Decision |
|---|---|
| README §13 listed 5 tables; plan §72 needs 7 | All 7 built. README §13 and §33 updated |
| `PENDING` had no entry or exit | Staff-created reservations are `CONFIRMED` unless entered as `PENDING`. `PENDING -> CONFIRMED` is an explicit step. `PENDING` can be cancelled, but cannot check in, be seated or be a no-show, and it blocks planned-table conflicts and holds |
| Cancelling a Table Session that came from a Guest Party | The party returns to `CHECKED_IN` (or its waitlist entry to `WAITING`/`NOTIFIED`) in the same transaction, with history |
| Seating permissions | Seating a reservation or waitlist party needs `restaurant.seat` plus `reservations.manage` or `waitlist.seat` |
| Permission catalog | Five new codes, 82 to 87. Owner, General Manager and Manager hold all. Host holds all but `reservations.override-hold`. Servers hold none |
| Hold override scope | Applies to the unrelated-party hold only. Recorded in `reservation_hold_overrides`. Never bypasses Phase 5 hard checks |

### Applied beyond the plan text

| Topic | Applied |
|---|---|
| Seating a `CONFIRMED` reservation | Allowed without a separate check-in; it records `checked_in_at` |
| Reservation with an open waitlist entry | Both move to `SEATED` together, whichever record the host started from |
| Walk-in party leaving the waitlist | Party becomes `CANCELLED`. A reservation party goes back to `CHECKED_IN` instead |
| Past reservation times | Allowed on entry (a host may log one after the fact). A reservation whose window has ended is not a conflict |
| Planned tables | At most 3, one area, combined capacity must seat the party. No capacity override in planning |
| Recommendation ranking | One table before a combination, then fewer tables, then preferred area, then smallest surplus, then natural table number and ID. A single table outside the preferred area still ranks before a combination inside it |
| Hold indicators | Visible to anyone with `restaurant.view`; guest names only with `reservations.view` |
| `Takeout` tables | Excluded from planning and recommendations |
| `waitlist_entries.preferred_area_id`, `notified_by_user_id`, `removed_by_user_id`; `reservations.business_date`, `cancel_reason`, `no_show_by_user_id` | Added for the "area preference", "actor" and business-date requirements |

### Interval rules

| Calculation | Interval, half-open |
|---|---|
| Reservation planning conflict | `[reservation_at - pre_hold, reservation_at + expected_duration + post_grace)` |
| Walk-in hold protection | `[reservation_at - pre_hold, reservation_at + post_grace)` |

Both read `location_settings.reservation_pre_hold_minutes` and `reservation_post_grace_minutes` (15 and 15). They are computed in one file, `src/modules/reservations/rules/hold-intervals.ts`.

## Architectural decisions

- **Planning and occupancy stay separate.** Reservation and waitlist table assignments are their own tables. Occupancy still derives only from open `table_session_tables` rows, and the Phase 5 unique index is unchanged.
- **A database guard for one session per party.** A partial unique index on `table_sessions.guest_party_id WHERE status = 'ACTIVE'`. The seating code reads the violated constraint name to tell it from a table race (`PARTY_ALREADY_SEATED` or `TABLE_ALREADY_OCCUPIED`).
- **One lock order.** Every party operation locks the party, then its reservation, then its open waitlist entry, whichever record it started from. Tables are then locked in ID order, as in Phase 5. Planning also locks the tables before checking conflicts, so planners and seaters serialise.
- **Phase 5 services reused on the caller's transaction.** `seatPartyInTransaction`, `completeSessionInTransaction` and `cancelSessionInTransaction` were extracted; `seatParty`, `completeSession` and `cancelSession` keep their signatures and behavior.
- **Workflows orchestrate, domains own.** `src/workflows/seat-guest-party/` (reservation, waitlist, walk-in) and `src/workflows/end-table-session/` (complete, cancel) cross Restaurant and Reservations. Restaurant never imports Reservations.
- **A narrow door into Restaurant.** `src/modules/restaurant/queries/table-facts.ts` gives Reservations table facts and locked planning tables, and nothing about sessions beyond when one was seated. A test checks that the module names no restricted HR table or security-role table.
- **Pure decision rules.** Hold intervals, lifecycle transitions, no-show eligibility, recommendations and wait estimates have no database access.
- **Hold check after Phase 5 rules.** `checkHoldsForSeating` runs only once a table has passed the Phase 5 availability check, so an override can't mask a dirty, out-of-service or occupied table.

### Architecture deviations

| Deviation | Reason |
|---|---|
| `reservation_hold_overrides` and `waitlist_table_assignments`, beyond README §13's 5 tables | Your decision. README §13 and §33 updated |
| `restaurant.view` holders can read hold indicators (`/api/reservations/holds`) | The floor shows them. Guest names are withheld without `reservations.view` |
| Two foreign key names set explicitly | The generated names exceeded PostgreSQL's 63-character limit |
| `.github/copilot-instructions.md` not used | `CLAUDE.md` replaces it, per the `/phase` instruction |

## Migrations

| Migration | Contents |
|---|---|
| `0008_reservations_waitlist.sql` | Generated. 7 tables, 24 foreign keys (all `RESTRICT`), 2 columns on `location_settings`, `table_sessions.guest_party_id` with its composite foreign key and unique index |

I found two generated foreign key names over 63 characters while reviewing the SQL, named them explicitly in the schema, and regenerated rather than hand-editing. Constraint order was correct, so one migration was enough.

| Check | Result |
|---|---|
| Generation | PASS |
| Application | PASS |
| Existing Phase 5 database to Phase 6 | PASS: your real development database upgraded with `db:migrate` and `db:seed`, keeping its 1 user. An automated test also upgrades a populated Phase 5 database in place |
| Empty DB reconstruction | PASS: automated test, plus a new empty PostgreSQL 17 container |
| Unexplained schema drift | NONE: a further `db:generate` reports "No schema changes" |

**What changed in your development database:** 82 permissions became 87 and the role-permission rows 280 to 299; its 1 user, 6 tables and sections are untouched. It has 0 Guest Parties, and the hold settings read 15 and 15.

## Validation results

### Reservation schema

| Table | Result |
|---|---|
| guest_parties | PASS |
| reservations | PASS |
| reservation_table_assignments | PASS |
| reservation_hold_overrides | PASS |
| waitlist_entries | PASS |
| waitlist_table_assignments | PASS |
| party_status_history | PASS |
| Table Session Guest Party link | PASS |

### Guest Party

| Check | Result |
|---|---|
| Current status | PASS |
| Append status history | PASS |
| Contact-data protection | PASS: conflict summaries, recommendations and the floor carry no phone or email; the module reads no restricted HR table |
| Active Table Session uniqueness | PASS: service, and direct SQL against the index |

### Reservations

| Check | Result |
|---|---|
| Approved status set | PASS: a check constraint and the lifecycle table use exactly the seven |
| Creation | PASS |
| Edit / version concurrency | PASS |
| Cancellation | PASS |
| Check-in (`CONFIRMED -> CHECKED_IN`) | PASS |
| `PENDING` lifecycle state | PASS |
| Manual no-show after configured post-grace | PASS: refused before the boundary, allowed at it, follows the setting |
| No-show actor/timestamp and planned-hold release | PASS |
| Completion linkage | PASS |
| Planned tables | PASS |
| Combined planned tables | PASS |
| Capacity validation | PASS |
| Planning conflict detection | PASS: overlap, adjacency, each table of a combination, cancelled and ended windows |

### Reservation holds

| Check | Result |
|---|---|
| Pre-hold setting | PASS |
| Post-grace setting | PASS |
| Reservation planning conflict interval | PASS |
| Walk-in hold interval | PASS |
| Half-open interval boundaries | PASS: before start, at start, inside, just before end, at end, cross-midnight |
| `PENDING` reservations block conflicts and holds | PASS |
| Hold distinct from occupancy | PASS: a held table is `AVAILABLE`, has no session, and shows a separate indicator |
| Ordinary Host blocked | PASS |
| Manager override permission | PASS |
| Override reason/provenance | PASS: actor, reason, category, session, table and time stored |
| Override does not bypass hard seating rules | PASS: dirty, occupied and capacity still refuse |
| Hold release lifecycle | PASS: cancel, no-show, seating and replacement |

### Waitlist

| Check | Result |
|---|---|
| Approved status set | PASS |
| `TABLE_ASSIGNED` does not create occupancy | PASS |
| Add walk-in | PASS |
| Duplicate active entry prevention | PASS: service, and the unique index |
| Quoted wait | PASS |
| `WAITING -> NOTIFIED` | PASS |
| Seat | PASS |
| `CANCELLED` / `LEFT` | PASS |
| Notification is recorded-only | PASS: no outbound code exists, and no dependency was added |

### Recommendations

| Check | Result |
|---|---|
| Deterministic ranking | PASS: the same result for any input order |
| Smallest adequate capacity | PASS |
| Single table preference | PASS |
| Combined tables (maximum three, same Restaurant Area) | PASS |
| Reservation holds respected | PASS: the party's own hold doesn't count against it |
| Dirty/out-of-service/occupied excluded | PASS, with reasons |
| Stable tie-break | PASS |

### Seating integration

| Check | Result |
|---|---|
| Reservation -> Table Session | PASS |
| Waitlist -> Table Session | PASS |
| Immediate walk-in -> Table Session | PASS |
| Planned vs actual table history | PASS: planned T01-style table kept as ended history while T02 and T03 are used |
| Atomic status/session writes | PASS: a refused seating leaves reservation, party and sessions untouched |
| Concurrent duplicate seating prevented | PASS: one reservation or entry seated twice at once gives one session |
| Phase 5 physical table race protection preserved | PASS |

### Authorization

| Check | Result |
|---|---|
| reservations.view | PASS |
| reservations.manage | PASS |
| reservations.override-hold | PASS |
| waitlist.view / manage / notify / seat | PASS |
| Direct unauthorized API denied | PASS: E2E, 401 signed out and 403 without the permission |
| Cross-location authorization | PASS: another location's records look absent |

### Seeds

| Check | Result |
|---|---|
| Phase 5 to 6 permission upgrade | PASS: adds the five codes, restores no grant an administrator removed |
| Seed idempotency | PASS: `9 applied`, then `0 applied, 9 already applied`, with identical counts (87 permissions, 299 role permissions, 6 tables) |
| Hold settings | PASS: 15 and 15 by the column default |
| No seeded operational data | PASS: a test asserts zero parties, reservations and entries |

### Regression

| Check | Result |
|---|---|
| Phase 1 foundation | PASS |
| Phase 2 auth/RBAC | PASS |
| Phase 3 Employees/HR | PASS |
| Phase 4 Scheduling | PASS |
| Phase 5 Restaurant/Seating | PASS |
| `db:reset` safeguards | PASS |
| `/api/health` | PASS: through the E2E suite |

Real `npm run db:reset` refusals on the throwaway container, with a probe row intact afterward: `NODE_ENV=production`, `NODE_ENV=test`, a fake RDS host, database `postgres`, database `restaurant_ops_test`, and `?host=` on a local URL. The successful reset then seed reproduced the same counts: 87 permissions, 299 role permissions, 6 tables, 0 parties.

### Validation

| Check | Result |
|---|---|
| PostgreSQL health | PASS |
| `npm ci` | PASS: the same 3 deprecation warnings as DEV-003, none new |
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 417 of 417 (baseline 351) |
| Integration tests | PASS: 674 of 674 (baseline 582) |
| E2E tests | PASS: 79 of 79 (baseline 69), on two consecutive full runs |
| Production build | PASS |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 12 moderate, unchanged, recorded as DEV-002 |
| `git status --ignored` | PASS: only `.env`, `.next/`, `next-env.d.ts`, `node_modules/`, `test-results/` and `tsconfig.tsbuildinfo` are ignored |
| GitHub Actions | PASS: reported by the project owner after the work was pushed; I did not see the run |

### Problems found during validation

- **A character-encoding mistake of mine broke the Floor page.** A Python script I used to edit `floor-board.tsx` wrote one "·" as a single byte instead of UTF-8, so Next.js couldn't read the file and the dev server stopped answering. Every test after the first Floor visit failed, including unrelated login tests, which hid the cause. I found it in the Next.js log, repaired the three bytes, and checked every changed file for invalid UTF-8. No other file was affected.
- **A raw SQL fragment didn't accept `Date` parameters** in the conflict query. Fixed by passing ISO strings with an explicit `::timestamptz`, which the integration tests caught first.
- **Four of my own tests had wrong assumptions** (global session counts that included other tests' data, a bar table that fit a party as a single table, and an empty table list that the planning lock rejected). The empty-list one was a real service bug and is fixed.

## Tests executed

- **Unit (new, 66):** hold intervals including every boundary and cross-midnight; lifecycle transitions; no-show eligibility; recommendation ranking, exclusions and tie-breaks; wait estimate.
- **Integration (`tests/integration/reservations/`, new, 92 including the changed database tests):**
  - `reservations`: creation, planned and combined tables, conflicts, modification and version checks, lifecycle, no-show, listing.
  - `holds-and-seating`: hold is not occupancy, ordinary host blocked, override and provenance, hard rules not bypassed, planned T01-style table versus actual tables, atomic refusal, concurrent seating, direct-SQL index check, completion, mistaken-seating cancellation.
  - `waitlist`: lifecycle, duplicate prevention, quote, notification, table assignment history, outcomes, seating including the concurrent case, recommendations and quotes.
  - `authorization`: every operation refused without its permission, view versus manage, the two-permission seating rule, cross-location, the role matrix, module boundaries.
- **Integration (updated):** migrations (new tables, a Phase 5 upgrade in place), foundation seeds (a Phase 5 upgrade), seed registry, the Restaurant boundary test.
- **E2E (`tests/e2e/reservations.spec.ts`, 10):** reservation workflow with planned and actual tables differing, waitlist workflow, left outcome, hold block and manager override on a table that is not occupied, cancellation releasing a hold, no-show timing, Server denied, viewer read-only, signed-out, and phone width.

**Partly covered:**

- A fault injected partway through the final writes isn't tested. Atomicity is shown by refusals that happen after the locks are taken.
- The code that turns a unique violation into `TABLE_ALREADY_OCCUPIED` isn't reached by a race, because the locks stop it first. The party index is proven directly with SQL.
- The wait estimate is tested as a pure function and through one service call. Its numbers are conservative assumptions (a 5-minute cleaning allowance and a 5-minute minimum for an overdue party), not measurements.
- Hold windows are exercised through the services and one E2E, but never with a `now` argument; the integration tests use real clocks with margins of 5 or more minutes.

## Files changed

**Created**

- Schema and migration: `src/db/schema/guest-parties.ts`, `src/db/schema/reservations.ts`, `drizzle/migrations/0008_reservations_waitlist.sql` and its snapshot
- Seed: `src/db/seeds/reservations-foundation.ts`
- Reservations module: `src/modules/reservations/` (`rules`, `repositories`, `services`, `validators`, `types.ts`)
- Restaurant door: `src/modules/restaurant/queries/table-facts.ts`
- Workflows: `src/workflows/seat-guest-party/`, `src/workflows/end-table-session/`
- API: 19 Route Handlers under `src/app/api/reservations/` and `src/app/api/waitlist/`
- UI: `src/app/(app)/host/reservations/`, `src/app/(app)/host/waitlist/`, `src/components/reservations/`
- Tests: `tests/integration/reservations/`, `tests/e2e/reservations.spec.ts`, `tests/fixtures/reservation-fixtures.ts`, `tests/helpers/e2e-reservations.ts`, unit tests beside the rules
- Docs: this report

**Modified**

- Schema: `src/db/schema/{index,organization,restaurant}.ts`, `drizzle/migrations/meta/_journal.json`
- Auth: `permission-catalog.ts` (87 codes), `role-catalog.ts`
- Seeds: `src/db/seeds/registry.ts`
- Restaurant: `src/workflows/seat-party/seat-party.ts` and `src/modules/restaurant/services/session-service.ts` (transaction-joining variants), `restaurant-validators.ts` (hold override reason)
- Database helper: `src/db/helpers/database-errors.ts` (`readConstraintName`)
- UI: `floor-board.tsx` and the floor page (host tabs, hold indicators, override field), `navigation.ts`
- API: the session complete and cancel routes now call the workflows
- Tests: `navigation.test.ts`, `auth.test.ts`, `tests/e2e/auth.spec.ts`, `tests/fixtures/employee-fixtures.ts`, the database seed and migration tests, `tests/integration/restaurant/authorization.test.ts`
- Docs: `README.md` §13 and §33

## Risks

- **A seated party can be moved onto a held table.** See Remaining issues, item 1.
- **Hold windows use the server clock.** A host's screen can show a hold that has just ended for up to 30 seconds. A stale action is still decided by the server.
- **The waitlist page computes one suggestion per waiting party** on each load. Fine for one restaurant; measure before anything larger.
- **Guest contact data is stored in clear text** in `guest_parties` and shown to anyone with `reservations.view` or `waitlist.view`, including the Host. There is no retention or erasure rule yet.
- **No one is notified of anything.** `NOTIFIED` is a record; staff have to contact the party themselves, and no in-app notification exists until Phase 10.
- **Override reasons have no screen.** They are stored, and nothing displays them yet.
- **A past reservation can be entered**, so a typo in the date can create one that never conflicts or holds.
- **`btree_gist` on RDS** remains untested, as noted in Phases 3 and 5. Phase 6 adds no exclusion constraint.

## Remaining issues

None of these block Phase 7, but item 1 is a gap in a rule the plan asks for.

1. **Moving or combining a seated party onto a held table isn't checked.** Plan §16 describes seating, and that is covered. The Phase 5 `move` and `add table` operations don't consult holds, so a host can send an existing party to a held table. Closing it means adding the same check to those workflows, and Restaurant can't import Reservations, so it would go through a workflow like the seating one. Your decision.
2. **Where does the audit domain get built? Still your decision,** carried from Phases 3 to 5. Hold overrides and cancellations are now more actions that want it.
3. **Confirm that a single table outside the requested area ranks above a combination inside it.** I followed the plan's ordering of principles. Changing it is a small edit in `table-recommendation.ts`.
4. **CI retries twice,** which could hide a flaky test. The run passed, but check it didn't need a retry.
5. **Carried over, all optional:** edit forms from the Phase 3 and 4 reports, the old `restaurant-ops-postgres-1` container and volume, the stray `C:\Users\kneal\package-lock.json`, and the unanchored `out/` and `uploads/` rules in `.gitignore`.

## Accepted risks

DEV-001, DEV-002 and DEV-003: unchanged. No dependencies were added, and `npm audit` shows the same 12 moderate development findings.

## Business domains created beyond Phase 6

NONE. A migration test asserts the exact table list. No menu, recipe, inventory, order, fulfillment, settlement, reporting or audit code exists, and the only SMS/email/notification behavior is a recorded status.

## Next-phase readiness

**Phase 7 readiness: READY,** subject to review of this report and your decision on Remaining issue 1. Phase 9 Orders will still reference `table_sessions`, which now carry the Guest Party link, and `completeTableSession` is where Phase 9 adds its open-order precondition.
