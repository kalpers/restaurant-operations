# PHASE 32 COMPLETION REPORT

## Summary

Phase 32 adds a daily manager log and pre-shift notes for each location. The owner chose the feature and its scope on 2026-11-19 and approved the plan the same day (D1–D13 as recommended). Four amendments were approved with the execution plan.

What was built:
- **Manager log.** Entries are kept per location and business date. Each has a fixed category, a `LOG-000123` number and its author. It is append-only: a correction is a new entry that names the original. The one change ever made to an entry is a single redaction by an Owner or General Manager, with a reason; that redaction is audited.
- **Pre-shift notes.** A note is for one business date, from today to 14 days ahead. It is aimed at everyone or at chosen positions. Managers can edit or withdraw it until its date has passed.
- **Screens.** `/manager-log`, `/pre-shift` with `/pre-shift/manage`, and a "Pre-shift notes today" panel on the dashboard.
- **Demo data** for MAIN.

Size of the change:
- Five new permissions (160 in all).
- Two migrations: 0074 (generated) and 0075 (custom).
- No dependency changed.
- Nothing is committed.

Every check passes: lint, typecheck, unit, integration, E2E in CI mode, build and the production audit.

## Environment

- Node v26.13.0
- npm 12.2.0
- Next.js 16.4.5
- PostgreSQL 17.11 (Docker Compose)

## Policies (as built)

### Manager log

- **Business date.** `addLogEntry` reads the location's clock through `readLocationClock`, which uses `BusinessDateService`. It uses the current business date, or the previous one when `dateChoice` is `PREVIOUS`. Nothing earlier is possible.
- **Categories.** A fixed list, enforced by a check constraint: `SERVICE`, `INCIDENT`, `MAINTENANCE`, `STAFFING`, `GUEST`, `OTHER`.
- **Numbering.** Entry numbers come from `manager_log_number_counters`, one counter per organization, incremented under the counter row's lock (amendment 1).
- **Append-only.** The `manager_log_entries_guard` trigger (0075):
  - refuses DELETE;
  - refuses an INSERT that is already redacted;
  - refuses every UPDATE except a single redaction that changes nothing but the body and the three redaction columns;
  - refuses a correction that names an entry at another location, or a later entry.
- **Body check.** A check constraint requires either an unredacted body of 1 to 4000 characters, or an empty body with all three redaction fields set and a reason of 1 to 500.
- **Corrections.** A correction is a new entry with `corrects_entry_id`. The service looks for the original at the actor's location, and the trigger checks again. The page shows "Corrected by LOG-…" on the original and "Corrects LOG-…" on the correction.
- **Redaction.** It needs `manager-log.redact` (Owner and GM). The row is locked, the body is emptied, and who, when and why are recorded. A second redaction gives `ALREADY_REDACTED`. The entry keeps its number, date, category, author and correction link.
- **Card numbers.** Text with 13 or more digits in a row is refused (`CARD_DATA_REFUSED`, rule 15). This applies to entries, reasons and notes.

### Pre-shift notes

- **Dates.** A note is for today through 14 days ahead (`NOTE_DATE_PASSED`, `NOTE_DATE_TOO_FAR`). After its date has passed it is read only (`NOTE_READ_ONLY`).
- **Changes.** Edits and withdrawals use the note's `version` (`CONCURRENCY_CONFLICT`). A withdrawn note stays listed for managers (`NOTE_WITHDRAWN` if withdrawn again). Edits replace the note's position rows, and they aren't audited.
- **Positions.** A note may only name positions of the organization. A position named anew must be active (`POSITION_INACTIVE`); one already on the note stays even if it was deactivated since.
- **Who sees what.**
  - A reader sees today's active notes for everyone, plus those for a position their linked employee holds at this location: an active `employee_positions` row (amendment 2).
  - Holders of `pre-shift.manage` see every active note for today on `/pre-shift`, and every note in a range of up to 31 days on `/pre-shift/manage`.
  - Pinned notes come first, then oldest first.

### Pages and dashboard panel

- `/manager-log` is in the Service group and needs `manager-log.view`. It has:
  - a business date picker with a category filter;
  - a text search across up to 31 days, with wildcards taken literally and at most 300 results;
  - Add entry, with a choice of today or the previous business date and a reminder not to record contact details, health details or HR matters;
  - Correct on each entry, and Redact with a reason dialog for holders of `manager-log.redact`.
- `/pre-shift` is in the Service group and needs `pre-shift.view`. Managers get a "Manage notes" link to `/pre-shift/manage` (amendment 3), which has a date range, a write form, and Edit and Withdraw on each note.
- The dashboard shows "Pre-shift notes today" to `pre-shift.view` holders.
- Authors appear by employee name, or "No employee record", never by email (amendment 4). Times show in the location's time zone.

### Permissions, audit, idempotency and boundaries

- **Permissions.** `manager-log.view`, `manager-log.write`, `manager-log.redact`, `pre-shift.view` and `pre-shift.manage`, seeded by `security.manager-log-permissions`.
  - Owner and GM get all five.
  - Manager gets all but `manager-log.redact`.
  - Server, Bartender, Host, Cook, Wait Staff and Inventory Manager get `pre-shift.view`, through a `STAFF_BRIEFING` list in the role catalog.
- **Audit.** Only redaction is audited, as `restaurant.manager-log-redacted` (category `ORGANIZATION`, location scope). Its details hold the entry number, business date, category and `reasonLength`; never the body or the reason text.
- **Idempotency.** Adding an entry takes an idempotency key (scope `restaurant.manager-log-entry`). The stored response holds only the entry's ID, number and date.
- **Not included.** No outbox events, realtime updates or notifications.
- **Boundaries.**
  - The Restaurant module reads positions only through two new Employees queries in `briefing-positions.ts`, which read position identity only.
  - Every route uses `requireApiActor`, so the location header is checked as on every other route.
  - Nothing in orders, inventory, settlements, scheduling or reporting changed.

## Results

- Log entries can't be updated or deleted except by one audited redaction: **PASS**. The integration tests show direct SQL UPDATE and DELETE refused, a redaction that also changes the category refused, and a second redaction refused by both the service and the trigger.
- An idempotent retry adds no second entry: **PASS**. The retry returns the first entry, the idempotency record has no body text, and reusing the key for a different body gives `IDEMPOTENCY_KEY_REUSED`.
- Staff see only everyone-notes and their positions' notes: **PASS**. This was checked in integration tests (server, cook, manager, and a reader at another location) and end to end (a server sees a SERVER note on the dashboard and on `/pre-shift`, and a cook doesn't).
- Every route enforces its permission and the location header: **PASS**. Each service checks its permission (integration tests). The routes use `requireApiActor`, whose header check is covered by `location-header.test.ts`. A server opening `/manager-log` is sent to access denied (E2E).
- Canonical Bacon Cheeseburger and its idempotent retry are unchanged: **PASS**. These tests are in the integration suite.

## Architectural decisions

- Both features live in Restaurant (policy 2). They are ordinary services, with no workflow.
- The fixed category list is a deliberate exception to "prefer configurable tables" (policy 5). Moving to a table later needs no change to existing entries.
- The one-time redaction is a controlled exception to append-only (policy 6). The database allows only that exact change, once.
- Entry numbers use a per-organization counter row, like gift card numbers (amendment 1).
- A note's audience is decided per location from `employee_positions` (amendment 2).
- Position targeting decides relevance, not access, and the manage page says so (policy 9).
- The card-number check for free text is a small rule in `manager-log-rules.ts`, the same 13-digit rule Reservations uses. It wasn't imported across modules.

## Migrations

- **`0074_manager_log.sql`** (generated, reviewed).
  - Tables: `manager_log_number_counters`, `manager_log_entries`, `pre_shift_notes`, `pre_shift_note_positions`.
  - Foreign keys are org-scoped, with explicit names under 63 characters.
  - Checks: category, number, not-self, and body-or-redaction on entries; title and body length on notes.
  - Indexes: `(location_id, business_date, created_at)` and `corrects_entry_id` on entries, `(location_id, business_date)` on notes, `position_id` on note positions.
- **`0075_manager_log_guards.sql`** (custom). The `manager_log_entries_guard` trigger and its function. A copy of the SQL is kept in the session scratchpad.
- `npm run db:generate` then reports no schema changes.
- Both migrations are applied to the dev database.

## Validation results

| Check | Result |
|---|---|
| `npm run lint` | Clean |
| `npm run typecheck` | Clean |
| `npm run test:unit` | 74 files, 1010 tests passed |
| `npm run test:integration` | 110 files, 1542 tests passed |
| `CI=1 npm run test:e2e` (production build) | 183 passed, none flaky or failed (6.9 min) |
| E2E against the dev server | Not run (advisory only) |
| `npm run build` | Succeeds, no warnings; the 8 new routes are listed |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migration reconstruction and upgrade tests (`migrations.test.ts`) | Pass, with the four tables added to the expected list |
| `db:migrate` on the dev DB | Applied; only "already exists, skipping" notices |
| `db:seed` twice on the dev DB | 1 applied, 29 already applied; then 0 applied, 30 already applied. 160 permissions, `pre-shift.view` on all 9 system roles |
| `db:seed:demo` twice on the dev DB | 5 log entries and 3 notes, then 0 and 0 |
| `db:reset` safeguards (`database-safety.test.ts`) | Pass, unchanged |

## Tests executed

- **Unit: 12 new tests** in `src/modules/restaurant/rules/manager-log-rules.test.ts`:
  - business date choice, including month and year ends and daylight-saving dates;
  - number format;
  - search range, and wildcards taken literally;
  - redaction reason;
  - note date window and the editable check;
  - the reader filter (everyone or held positions, withdrawn, other dates, pinned first).
- **Unit, updated:** `auth.test.ts` (160 codes) and `navigation.test.ts` (55 links; Service group ends with Pre-shift and Manager log).
- **Integration: 11 new tests** in `tests/integration/restaurant/manager-log.test.ts`:
  - date, author and employee;
  - previous date and number order;
  - idempotent retry, with no body in the stored record;
  - corrections;
  - a correction at another location, refused by the service and the trigger;
  - direct SQL refusals;
  - redaction with its audit row;
  - permissions;
  - location isolation;
  - search;
  - card numbers refused.
- **Integration: 8 new tests** in `tests/integration/restaurant/pre-shift-notes.test.ts`:
  - reader visibility by position;
  - a position held at another location;
  - the date window;
  - versioned edits that replace positions;
  - withdrawal;
  - read only after the date;
  - foreign and inactive positions;
  - permissions.
- **Integration, updated:**
  - `foundation-seeds.test.ts`: every rewound total +5, and a new "upgrading a Phase 31 database" case that checks the grants;
  - `seed-framework.test.ts`: the seed key;
  - `migrations.test.ts`: the four tables.
- **E2E: 2 new tests** in `tests/e2e/manager-log.spec.ts`:
  - add, correct, and owner redaction;
  - a note for servers seen by a server and not a cook, and a server refused the log.

## Files changed

New:
- Schema and migrations: `src/db/schema/manager-log.ts`, `drizzle/migrations/0074_manager_log.sql`, `0075_manager_log_guards.sql`, and their snapshots.
- Seed: `src/db/seeds/manager-log-permissions.ts`.
- Restaurant module: `src/modules/restaurant/rules/manager-log-rules.ts` (with its test), `rules/pre-shift-rules.ts`, `repositories/manager-log-repository.ts`, `services/manager-log-service.ts`, `services/pre-shift-service.ts`, `validators/briefing-validators.ts`.
- Employees query: `src/modules/employees/queries/briefing-positions.ts`.
- Routes: `src/app/api/manager-log/route.ts`, `…/[entryId]/redact/route.ts`, `src/app/api/pre-shift-notes/route.ts`, `…/[noteId]/route.ts`, `…/[noteId]/withdraw/route.ts`.
- Pages: `src/app/(app)/manager-log/page.tsx`, `src/app/(app)/pre-shift/page.tsx`, `src/app/(app)/pre-shift/manage/page.tsx`.
- Components: `src/components/restaurant/manager-log-workspace.tsx`, `pre-shift-manager.tsx`, `pre-shift-note-list.tsx`, `pre-shift-today.tsx`.
- Demo: `scripts/demo-briefings.ts`.
- Tests: `tests/fixtures/briefing-cleanup.ts`, `tests/helpers/e2e-briefings.ts`, `tests/integration/restaurant/manager-log.test.ts`, `pre-shift-notes.test.ts`, `tests/e2e/manager-log.spec.ts`.
- Docs: `docs/Phase-32-Manager-Log-and-Pre-Shift-Notes.md`, this report.

Changed:
- `src/db/schema/index.ts`, `src/db/seeds/registry.ts`, `drizzle/migrations/meta/_journal.json`.
- `src/modules/auth/permission-catalog.ts`, `role-catalog.ts`, `auth.test.ts`.
- `src/modules/auditing/audit-actions.ts`.
- `src/components/app-shell/navigation.ts`, `nav-icons.tsx`, `navigation.test.ts`.
- `src/app/(app)/dashboard/page.tsx`.
- `scripts/seed-demo.ts`.
- `tests/fixtures/employee-fixtures.ts`: `clearRestaurantData` now clears log entries and notes first.
- `tests/integration/database/foundation-seeds.test.ts`, `migrations.test.ts`, `seed-framework.test.ts`.
- `README.md`: sections 12, 20, 33 and 36.
- `CLAUDE.md`: a policy line and the phase list.
- `docs/User-Guide.md`: Pre-shift notes and Manager log.

## Risks

- **Personal data in free text.** Guest erase (Phase 21) doesn't search log entries or notes. Removing such data depends on an Owner or GM noticing it and redacting. The add-entry form reminds writers not to record contact details, health details or HR matters, and card numbers are refused.
- **Redaction is permanent.** The original text of a redacted entry can't be recovered. Only Owner and GM can redact, once, with a reason, and it is audited.
- **Fixed categories.** They go against the "prefer configurable tables" convention. Changing them later needs a migration.
- **Targeting isn't security.** Position targeting is relevance only. A reader whose employee holds no position at the location sees only notes for everyone. A user with no employee record sees the same.
- **Test cleanup.** It lifts the log's guard inside a single test transaction, as the gift card cleanup does. That only ever happens on the test database.

## Fix after the report (flaky leak checks)

On a later full integration run the owner saw `nutrition.test.ts` fail. Phase 32 didn't cause it. The test checked that the JSON of whole audit rows had no "190", and a random audit row ID (`…58021906…`) happened to contain those digits. The same weakness was in five other checks: amounts can appear in a timestamp's seconds (`…:18.003Z`), and short digit runs can appear in UUIDs.
- `nutrition.test.ts` now checks only the audit payloads (before, after and details).
- `audit-trail`, `sections-and-servers`, `settlements/authorization`, `tip-refunds-declarations` and `security-matrix` use a new helper, `tests/helpers/leak-text.ts` (`textWithoutIds`). It leaves out UUIDs, instants and `sequence` before searching, so a figure stored as a field value is still caught.
- The two checks for a 10-digit phone number are effectively safe and were left as they were.
- The six files pass (109 tests), with lint and typecheck clean.

## Remaining issues

- The manual SMTP and Twilio check (left over from Phase 22) is still with the owner.
- The E2E suite wasn't run against the dev server; the CI-mode run is the authoritative one.
- Nothing is committed.

## Next-phase readiness

Phase 32 is complete and validated, apart from the items above. No later phase is scheduled. The remaining candidates from the 2026-11-18 list are:
- event and private-dining bookings;
- FIFO lot costing, which needs a rule changed in the contract.
