# Phase 5 Completion Report

This report merges the plan §75 template with the sections required by README §37. Results are from this repository on 2026-11-05.

## Summary

Phase 5 is implemented and validated locally. An authorized host or manager can view the floor, seat a party at one or more clean tables, move or combine them, reassign the server, complete the session, and clean the tables so they're available again. Two hosts can't take the same table: exactly one succeeds, and PostgreSQL refuses a second open membership even if the application check is bypassed.

**Not yet confirmed:**

- **CI:** the work is uncommitted, so the workflow hasn't run on GitHub. It includes a change to the E2E worker count (see Validation).
- **`db:reset` on your real development database:** deliberately not run, because it would delete your Owner account. The same command was proven on a throwaway PostgreSQL container. See Migrations.

**Please review these choices you haven't explicitly decided:** the role grants for Server, Bartender and Wait Staff, and the consequence of the schedule policy for assigning servers before a shift. Both are under Policies.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |

No dependencies were added.

## Policies

Plan §24 and §25, the approved qualification and schedule policies, were treated as binding.

### Decided by the project owner during planning

| Conflict or gap | Decision |
|---|---|
| Phase 2 gave Host `restaurant.manage`; plan §38 and §39 add granular codes and keep structural configuration from Host | `restaurant.manage` retired: removed from the catalog, with its grants and row deleted by a versioned seed |
| CLAUDE.md says "max 3 tables, one area"; README §13 and the Phase 6 plan apply that to recommendations | All tables in a real session share one area, with no table cap. The cap stays with Phase 6 recommendations |
| Plan §13 allows override metadata on the session or in a history record | A new append-only `table_session_overrides`, because a session can be overridden repeatedly and columns would overwrite earlier reasons |

### Shown in the approved plan, for your review

| Topic | Applied |
|---|---|
| Permissions | 11 new codes, one retired: the catalog goes from 72 to 82. `restaurant.cancel-session` isn't in plan §38; §18 asks for stricter cancel authorization |
| Owner, General Manager, Manager | All `restaurant.*` |
| Host | `view`, `seat`, `move`, `complete-session`, `clean-table`, `server.assign`. No overrides, structure, `condition.manage` or cancel |
| Server, Bartender | Add `complete-session` and `clean-table`. **The plan doesn't ask for this;** it doesn't say who clears tables during service |
| Wait Staff | Adds `clean-table` |
| Vacated or removed tables | Always `DIRTY`. The optional "never used" exception in §15 isn't built; a mistaken seating uses cancel |
| Cancel | Requires a reason. Current tables stay as they are, with no history row |
| Area mapping | Uses `area_type`: `DINING` for the plan's DINING_ROOM, and `BAR`. Tables and sections can't be created in a `TAKEOUT` area |
| Section server | One open assignment per section per business date. The current one must be ended first, so nothing is silently replaced |
| Default server at seating | Only if every selected table resolves to the same section server and that person needs no override. Otherwise no server, and a warning |
| Refusal code | One code, `SERVER_NOT_QUALIFIED`, for status, location and position, because status is Management-tier |
| Server who later stops qualifying | Keeps the session and is flagged on the floor. Termination doesn't touch Restaurant, matching Phase 4 |
| Position effective date | The location-local calendar date, because HR dates are calendar dates |

**Consequence of the binding schedule policy:** §25 checks the current instant. Assigning a server to a section before their shift starts needs `restaurant.schedule.override` and a reason, or has to wait until the shift begins. A host can't pre-assign before service. Future-dated assignments aren't built. If this proves awkward in practice, it's a policy change for you to make.

### Overridable and not

| Can be overridden, with permission and reason | Can't be overridden |
|---|---|
| Party over capacity (`restaurant.capacity.override`) | Wrong location or organization |
| Server not on a matching published shift (`restaurant.schedule.override`) | Inactive table or area |
| | Table occupied by another session |
| | `DIRTY` or `OUT_OF_SERVICE` target |
| | Employee status, location eligibility, position, area mapping |
| | Tables in different areas |

Capacity is checked again on every move and removal, so a party that needed an override once needs a reason again if it's still over.

## Architectural decisions

- **Occupancy has no column.** It derives from open `table_session_tables` rows. Availability labels are computed in one pure function and stored nowhere.
- **Two layers of double-seating protection.** Operations lock the session, then tables sorted by ID, and read availability after the lock. A partial unique index on open memberships is the final check, and a violation maps to `TABLE_ALREADY_OCCUPIED`. Seating locks tables only, so lock order can't deadlock.
- **Composite foreign keys** tie tables, sections and memberships to their location, so a cross-location row fails in PostgreSQL as well as in the service.
- **Narrow doors to other domains.** Restaurant reads HR only through `findSchedulingFacts`, `findPositionCodes` and `findEmployeeDisplayNames`, and Scheduling only through `findPublishedShiftsAt`. A test checks that its source names no restricted HR table or security role table.
- **Pure decision rules.** `rules/` has no database access, and the eligibility functions have no input for security roles or pay.
- **`seat-party` is the workflow** (README §5) because it crosses Restaurant, HR and Scheduling. Move, combine, complete and cancel are Restaurant services.
- **`BusinessDateService` now exists** at `src/shared/time/business-date-service.ts`, as a pure function of instant, timezone and cutoff. Plan §44 authorizes it, because `server_section_assignments.business_date` needs it.
- **Extension points.** `completeSession` is where Phase 9 adds its open-order check, and `table_sessions` takes a Phase 6 Guest Party column. Neither exists yet, and a test checks that no such column does.

### Architecture deviations

| Deviation | Reason |
|---|---|
| `table_session_overrides`, an 8th table beyond README §12's 7 | Your decision. README §12 and §33 are updated |
| `restaurant.manage` removed from the catalog | Your decision. The plan §38 list includes it, but keeping it would be a synonym |
| `restaurant.cancel-session` added | Plan §18 needs cancel to be stricter than the listed codes allow |
| `restaurant_areas` gains a unique `(id, location_id)` | Additive change to a Phase 2 table, needed by the composite foreign keys |
| Two migrations rather than one | See Migrations |
| Extra `table_sessions` columns: `cancelled_at`, `cancelled_by_user_id`, `cancel_reason` | Plan §18 cancellation needs provenance |
| Extra `server_section_assignments` columns: `ended_by_user_id`, `schedule_override_reason` | Plan §26 asks for provenance |
| E2E capped at 2 workers | See Validation |
| `db:reset` proven on a throwaway container | It would have deleted your Owner account |
| `.github/copilot-instructions.md` not used | `CLAUDE.md` replaces it, per the `/phase` instruction |

## Migrations

| Migration | Contents |
|---|---|
| `0006_restaurant_area_location_unique.sql` | Generated. Adds the unique constraint on `restaurant_areas` |
| `0007_restaurant_seating.sql` | Generated. 8 tables, 22 foreign keys, all `RESTRICT` |

**Why two:** `drizzle-kit` writes a new constraint on an existing table after the foreign keys that depend on it, so a single generated file would have failed when applied. I found this reviewing the SQL before anything was applied, and regenerated rather than hand-edited. `docs/Database-Conventions.md` records it.

Two generated foreign key names also exceeded PostgreSQL's 63-character limit, so they're named explicitly, as the conventions require.

| Check | Result |
|---|---|
| Generation | PASS |
| Application | PASS |
| Existing Phase 4 database to Phase 5 | PASS: your real development database upgraded with `db:migrate` and `db:seed`, keeping its 1 user |
| Empty DB reconstruction | PASS: automated test, plus a new empty PostgreSQL 17 container |
| Unexplained schema drift | NONE: a further `db:generate` reports no changes |

**What changed in your development database:** it went from 72 permissions and 241 role-permission rows to 82 and 280. `restaurant.manage` and its 4 grants are gone, and 43 grants were added: 11 each for Owner, General Manager and Manager, 5 for Host, 2 each for Server and Bartender, 1 for Wait Staff. It now has 6 tables, 2 sections, 6 section memberships and 0 sessions.

## Validation results

### Restaurant schema

| Table | Result |
|---|---|
| restaurant_tables | PASS |
| table_sessions | PASS |
| table_session_tables | PASS |
| server_sections | PASS |
| server_section_tables | PASS |
| server_section_assignments | PASS |
| table_condition_history | PASS |
| table_session_overrides (addition) | PASS |

### Table model

| Check | Result |
|---|---|
| Condition/occupancy separation | PASS |
| Derived availability | PASS |
| Capacity constraints | PASS: service and direct SQL |
| Area/location consistency | PASS: service and direct SQL |
| Table configuration concurrency | PASS |

### Seating

| Check | Result |
|---|---|
| Single table seating | PASS |
| Combined table seating | PASS |
| Double-seating prevention | PASS: service and direct SQL |
| Concurrent seating race test | PASS: 2 and 8 simultaneous attempts, and overlapping combinations |
| Capacity validation | PASS |
| Capacity override | PASS |
| Override reason/provenance | PASS: repeated overrides keep every reason |
| DIRTY table rejected | PASS |
| OUT_OF_SERVICE rejected | PASS |
| Inactive table rejected | PASS: inactive table and inactive area |

### Table sessions

| Check | Result |
|---|---|
| ACTIVE lifecycle | PASS |
| Move session | PASS: one to one, many to one, one to many, partial overlap, across areas |
| Add combined table | PASS |
| Remove combined table | PASS |
| Membership history | PASS |
| Move failure atomicity | PASS |
| Completion | PASS: including racing a move, where one wins |
| Completion makes used tables DIRTY | PASS |
| Cancellation behavior | PASS |

### Table condition

| Check | Result |
|---|---|
| DIRTY -> CLEAN | PASS |
| Occupied clean attempt rejected | PASS |
| OUT_OF_SERVICE workflow | PASS |
| Condition history | PASS |
| Unauthorized change denied | PASS |

### Server sections

| Check | Result |
|---|---|
| Section configuration | PASS |
| Table membership | PASS |
| Cross-location membership rejected | PASS: service and direct SQL |
| Section assignment | PASS |
| Employee ACTIVE requirement | PASS |
| Employee Location requirement | PASS |
| Employee Position qualification | PASS |
| Security Role does not qualify Employee | PASS: a linked login with a role and no position is refused |
| Published-schedule validation | PASS: draft, archived, not started, ended, removed assignment, cancelled shift, other location, wrong position |
| Schedule override behavior | PASS |
| Table Session server assignment | PASS: including an employee with no login |
| Session server reassignment | PASS |
| Section change does not rewrite active session server | PASS |

### Authorization

| Check | Result |
|---|---|
| Floor view | PASS |
| Standard seating | PASS |
| Move permission | PASS |
| Clean permission | PASS |
| Capacity override permission | PASS |
| Schedule override permission | PASS |
| Structural table management permission | PASS |
| Structural section management permission | PASS |
| Direct unauthorized API denied | PASS: E2E, 401 signed out and 403 without the permission |
| Cross-location authorization | PASS: another location's records look absent |

### Seeds

| Check | Result |
|---|---|
| Restaurant tables | PASS: T01 to T04, B01, B02 |
| Server sections | PASS: `DINING_A`, `BAR` |
| Section memberships | PASS: 6 |
| Seed idempotency | PASS: `2 applied`, then `0 applied, 8 already applied`, with identical counts |
| No fake Takeout table | PASS |

### Regression

| Check | Result |
|---|---|
| Phase 1 foundation | PASS |
| Phase 2 auth/RBAC | PASS |
| Phase 3 Employees/HR | PASS |
| Phase 4 Scheduling | PASS |
| `db:reset` safeguards | PASS |
| `/api/health` | PASS: on a production build, through the E2E suite |

Real `npm run db:reset` refusals on the throwaway container, each exiting 1 with no password in the output and a probe row intact afterward: `NODE_ENV=production`, `NODE_ENV=test`, a fake RDS host, database `postgres`, database `restaurant_ops_test`, and `?host=` on a local URL. The successful reset then seed reproduced the same counts: 82 permissions, 280 role permissions, 6 tables, 2 sections, 6 memberships, 3 areas, 0 sessions, 0 users.

### Validation

| Check | Result |
|---|---|
| PostgreSQL health | PASS |
| `npm ci` | PASS: the same 3 deprecation warnings as DEV-003, none new |
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 351 of 351 (baseline 295) |
| Integration tests | PASS: 582 of 582 (baseline 448) |
| E2E tests | PASS: 69 of 69 (baseline 51), three consecutive full runs at 2 workers |
| Production build | PASS |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 12 moderate, unchanged, recorded as DEV-002 |
| `git status --ignored` | PASS: only `.env`, `.next/`, `next-env.d.ts`, `node_modules/`, `test-results/` and `tsconfig.tsbuildinfo` are ignored, so no new source is hidden |
| GitHub Actions | NOT RUN: work is uncommitted |

After those three full runs, I removed duplicate names from one Sections page dropdown. Lint, typecheck and the build were rerun, along with the restaurant spec rather than the full suite.

### E2E failures found and their cause

The first full runs with the new spec, at Playwright's default 4 workers, failed 2 to 7 tests per run, and 16 in a run with tracing on. They varied, and included Phase 2, 3 and 4 tests that had been stable. One further failure was consistent and simple: an auth test pinned the text "72 permissions".

| Run | Result |
|---|---|
| Earlier specs only, `next dev`, 4 workers | 51 of 51, once |
| All specs, `next dev`, 4 workers | Failures every time |
| All specs, `next dev`, 2 workers | 69 of 69 |
| All specs, **production build**, 4 workers | 69 of 69, twice, in 1.2 minutes |

Traces showed the clicks did send their requests, which ruled out my first guess, clicks landing before hydration. The requests themselves took 4 to 5 seconds or were still pending when the 5-second assertion wait ran out, and these looked like first hits on a route in that run. Health latency stayed at or below 1.4 seconds, which argues against a held lock or pool exhaustion. That `next dev` compiles each route on first request is the best-supported explanation: I inferred it from the pattern and the production-build result, and didn't measure compile times directly.

The fix is `workers: 2` in `playwright.config.ts`, with the reason in a comment. It's a limit on the test setup, and the production-build result shows the application itself passes at 4 workers. See Remaining issues, item 3.

### Accepted risks

DEV-001, DEV-002 and DEV-003: unchanged. No dependencies were added.

### Business domains created beyond Phase 5

NONE. A migration test asserts the exact table list. No reservation, guest party, menu, inventory, order, fulfillment or settlement code exists.

## Tests executed

- **Unit (new, 56):** business date, including daylight-saving and leap-day cases; table availability (§48); capacity (§49); server eligibility and the area policy (§50).
- **Integration (`tests/integration/restaurant/`, new):**
  - `tables-and-conditions`: plan §51 and §56.
  - `seating`: plan §52, §53 and §43, with direct-SQL constraint checks.
  - `sessions`: plan §54 and §55, cancellation, server assignment.
  - `sections-and-servers`: plan §57, every schedule exclusion, default servers, and exact response keys with a wage row present to prove nothing restricted appears.
  - `authorization`: plan §58, every operation refused without its permission, the role matrix, module boundaries.
- **Integration (updated):** migrations, foundation seeds including a Phase 4 upgrade, seed registry, the role matrix.
- **E2E (`tests/e2e/restaurant.spec.ts`, 18):** all plan §59 to §64 scenarios, plus combine and remove, reassign, the schedule override, cancel, table and section configuration through the UI, restricted data in the floor API, and phone-width layout with touch-size controls.

**Partly covered:**

- Failures partway through a multi-table write are proven by refusals that happen after the locks are taken, and by constraint checks. No test injects a database fault in the middle of the final writes.
- No test reaches the code that turns a unique violation into `TABLE_ALREADY_OCCUPIED` in seat, move and combine, because the locks stop the race first. Concurrent attempts are refused through the locked availability check, and a direct-SQL test proves the index itself refuses a second open membership.

## Files changed

**Created**

- Schema and migrations: `src/db/schema/restaurant.ts`, `drizzle/migrations/0006_restaurant_area_location_unique.sql`, `0007_restaurant_seating.sql` and their snapshots
- Seeds: `src/db/seeds/restaurant-foundation.ts`
- Restaurant module: `src/modules/restaurant/` (`rules`, `repositories`, `services`, `validators`, `types.ts`)
- Workflow: `src/workflows/seat-party/seat-party.ts`
- Cross-domain queries: `src/modules/employees/queries/{position-codes,employee-display-names}.ts`, `src/modules/scheduling/queries/published-shift-facts.ts`
- Time: `src/shared/time/business-date-service.ts`
- API: 18 Route Handlers under `src/app/api/restaurant/`
- UI: 3 pages under `src/app/(app)/restaurant/`, `src/components/restaurant/`
- Tests: `tests/integration/restaurant/`, `tests/e2e/restaurant.spec.ts`, `tests/fixtures/restaurant-fixtures.ts`, `tests/helpers/e2e-restaurant.ts`, unit tests beside the code
- Docs: this report

**Modified**

- Auth: `permission-catalog.ts` (82 codes), `role-catalog.ts`
- Schema and seeds: `src/db/schema/{index,organization}.ts`, `src/db/seeds/registry.ts`, `drizzle/migrations/meta/_journal.json`
- UI: `src/components/app-shell/navigation.ts`
- Config: `playwright.config.ts` (2 workers)
- Tests: `navigation.test.ts`, `auth.test.ts`, `tests/e2e/auth.spec.ts`, `tests/fixtures/employee-fixtures.ts`, `tests/integration/auth/permissions.test.ts`, and the tests pinning the table list and seeds
- Docs: `README.md` §12, §32 and §33, `docs/Database-Conventions.md`

## Risks

- **Plain server reassignments leave no history.** An override is recorded, but an ordinary change overwrites `assigned_server_employee_id`, so who served a party before, and who changed it, are lost. Phase 12 seating or labor reports may want this. See Remaining issues, item 1.
- **Override reasons have no screen.** They're stored, and nothing displays them yet.
- **Cancel relies on judgment.** It can't tell whether a table was really used, so a manager could cancel a used table and leave it `CLEAN`. It's limited to `restaurant.cancel-session` and needs a reason.
- **A server who stops qualifying stays on their sessions.** The floor flags them, and someone has to reassign. A flagged session could tell a host that something changed about that person, which is the same limited inference accepted in Phase 3.
- **Deactivating an area with seated parties isn't blocked.** The Organization domain doesn't know about sessions. Those tables show as Inactive and can still be completed. I found and fixed a version of this where they disappeared from the floor.
- **Hosts can see stale data for up to 30 seconds,** because the floor polls until Phase 10. A stale action is still refused by the server.
- **Open section assignments from earlier days aren't closed.** They stop applying when the business date changes, but their `effective_to` stays empty. Reports should use `business_date`.
- **The floor page runs its server candidate query once per area,** reading facts for everyone at the location. Fine for one restaurant; measure before anything larger.
- **`minimum_capacity` is stored and returned, but the floor doesn't display it.** Plan §12 makes it optional guidance.
- **`btree_gist` on RDS** remains untested, as noted in Phase 3. Check it in Phase 14.

## Remaining issues

None of these block Phase 6.

1. **Where does the audit domain get built? Still your decision,** carried from Phases 3 and 4. Phase 5 adds more actions that need it, such as server reassignment and table moves. Plan §45 keeps them out of this phase.
2. **Confirm the Server and Bartender grants,** and whether the pre-shift override consequence is acceptable. Both are under Policies. Changing the grants would take a new versioned seed.
3. **E2E on a production build, optional.** It passed at 4 workers in less than half the time. Moving to it would remove the on-demand compile delay, at the cost of needing a build first. I kept `next dev` to avoid changing the test setup beyond what this phase needed.
4. **Commit and confirm CI.** The workflow gets the new migrations and the 2-worker E2E limit. CI also retries twice, which could hide a flaky test.
5. **Carried over, all optional:** edit forms from the Phase 3 and 4 reports, the old `restaurant-ops-postgres-1` container and volume, the stray `C:\Users\kneal\package-lock.json`, and the unanchored `out/` and `uploads/` rules in `.gitignore`.

## Next-phase readiness

**Phase 6 readiness: READY,** subject to review of this report and a green CI run once committed. `seatParty` is the place to connect a Guest Party, `table_sessions` can take the relationship, and only a committed session creates occupancy, which is what Phase 6's planning states rely on.
