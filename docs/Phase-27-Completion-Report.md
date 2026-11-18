PHASE 27 COMPLETION REPORT

# Summary

Phase 27 (Polish and Leftovers) closes the two leftovers still open after Phase 26, as approved by the owner on 2026-11-18 (D1–D9 as recommended):

- **Live floor and waitlist boards.** Table sessions, table condition and waitlist entries now write outbox events in the transaction of each change. The floor and waitlist boards refresh on them through the shared `useRealtimeRefresh`, replacing their own 30-second timers, which stay as the fallback.
- **Navigation memory.** Open navigation groups are remembered across reloads in the `nav_groups` cookie, which the app layout reads on the server. One "Expand all / Collapse all" button sits at the top of the navigation.

A review before planning found the other candidate leftovers already done, so they are out of scope:

| Candidate | Where it was done |
|---|---|
| Reservations board realtime | Phase 24 |
| Allergen move/share test, and guest and allergen seed data | Phase 22 |
| Audit of failed sign-ins and account locks | Phase 16 ("deferred" there means written after the response with `after()`) |
| Edge Runtime `node:crypto` build warning | Gone since Phase 22 |

No migration, no new permission (149), no dependency change.

# Environment

- Node v26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker Compose), Windows 11.
- `npm audit --omit=dev`: 0 vulnerabilities.

# Policies (as built)

- **Leftover review:** see the table in the Summary and the plan's Purpose section.
- **Floor and table events** (`src/modules/restaurant/services/floor-events.ts`):
  - Session events carry `{ sessionId, tableIds }`, aggregate `table_session`:
    - `table.session-opened`, written by the `seat-party` workflow, so every seating path (floor, reservation, waitlist, walk-in) writes it;
    - `table.session-moved`, `table.session-tables-changed` (combine, remove), `table.session-server-assigned`, `table.session-completed` and `table.session-cancelled`, written by `session-service.ts`.
  - `table.condition-changed` carries `{ tableId }`, aggregate `restaurant_table`. It is written for each table a move, removal or completion turns DIRTY, and for each clean or manager condition change in `table-service.ts`. The reason stays in the condition history, never in the event.
  - Names: `outbox_events_event_type_format` allows no hyphen before the dot, so the plan's `table-session.*` became `table.session-*` (amendment 1).
- **Waitlist events** (`src/modules/reservations/services/waitlist-events.ts`):
  - Each carries `{ waitlistEntryId }`, aggregate `waitlist_entry`. Never a name, phone, email or note.
  - `waitlist.entry-added`, `.entry-updated`, `.entry-notified`, `.tables-assigned` and `.entry-removed`, written in `waitlist-service.ts`.
  - `.entry-seated`, written by `markPartySeated`. It covers a waiting reservation party seated from the reservations board too.
  - `.entry-removed`, written by `cancelOpenWaitlistEntry` when a waiting reservation is cancelled.
  - `.entry-updated`, written by `revertPartySeating` when a mistaken seating puts the party back on the list (amendment 2).
- **Common rule:** every event is written inside the transaction of the change, after its history row, so a refused change writes none; the processor delivers after commit. Table and section configuration aren't evented (D5).
- **Boards listening** (`realtime-provider.tsx` exports `FLOOR_EVENT_TYPES`, `WAITLIST_EVENT_TYPES` and `RESERVATION_EVENT_TYPES`, and the stream registers them):
  - Floor: floor events, reservation events (holds) and `order.closed`.
  - Waitlist: waitlist, floor and reservation events, plus `guest.allergies-changed` (amendment 3).
  - Both keep the 30-second fallback.
- **Navigation memory:**
  - Cookie `nav_groups`, for example `insights_1.people_0`: cookie-safe characters, group IDs and open/closed only, `Path=/`, `SameSite=Lax`, one year, `Secure` on HTTPS. Unknown IDs, bad values or more than 200 characters are ignored.
  - `src/app/(app)/layout.tsx` reads it and passes it to `AppShell`, so the server render already matches (no flash, no hydration mismatch).
  - Rule (`isNavGroupOpen`): on arrival the current page's group is open. A toggle of it applies on that page and is remembered for other pages. Every other group follows the cookie, closed if never toggled.
- **Expand all / Collapse all:**
  - Shown when the person sees more than one group; the label is "Expand all" while any group is closed.
  - Collapse all closes every group except the current page's.
  - The result is written to the cookie. `expandNavGroups` (E2E) clicks Expand all first, keeping the per-group fallback.
- **Permissions, audit and boundaries:**
  - No new permission (149).
  - Events are filtered by organization and location in the realtime hub as before; they mean "refetch", and the data still comes from the authorized page queries.
  - No audit change (these were not audited actions).
  - Hidden or collapsed links remain usability only.

# Results

- Each floor and waitlist change writes one IDs-only event, none on refusal: **PASS** (`floor-events.test.ts`, `waitlist-events.test.ts`)
- Floor and waitlist boards update on another device without a reload: **PASS** (`live-boards.spec.ts`; every assertion within 15 s, well inside the 30 s fallback, after the watcher shows "Live")
- Open groups survive a reload with no flash; the current group always opens: **PASS** (unit tests plus `ui-shell.spec.ts` "open groups are remembered across a reload…")
- Expand all / Collapse all: **PASS** (same tests)
- Canonical Bacon Cheeseburger and Phase 24 reservation events unchanged: **PASS** (full integration suite, `reservation-events.test.ts` unchanged)

# Architectural decisions

- Each domain owns its events: Restaurant writes session and table events, and Reservations writes waitlist events. The only workflow that writes one is `seat-party`, because it inserts the session. No new cross-domain imports.
- Event-name helpers are small modules beside the services (`floor-events.ts`, `waitlist-events.ts`) rather than in `party-state.ts` or `waitlist-service.ts`, so `party-state.ts` needs no import from `waitlist-service.ts`.
- The navigation preference is a cookie, not `localStorage`, so the server renders the remembered state (it replaces Phase 26 D2 by owner decision).

# Amendments decided at implementation

1. Session events are named `table.session-*` to fit `outbox_events_event_type_format` without a migration.
2. `waitlist.entry-seated` and `waitlist.entry-removed` are written in `party-state.ts`, which covers every seating and cancellation path; undoing a seating writes `waitlist.entry-updated`. Tables turned DIRTY also write `table.condition-changed`.
3. The waitlist board also listens to `guest.allergies-changed`.

# Migrations

None. `npm run db:generate`: "No schema changes, nothing to migrate".

# Validation results

| Check | Result |
|---|---|
| `npm run lint` | Clean |
| `npm run typecheck` | Clean |
| `npm run test:unit` | 933 passed (65 files) |
| `npm run test:integration` | 1453 passed (101 files). The first full run failed 2 outbox-processor tests in `kitchen/lifecycle.test.ts`: their `sendOrder` fixture seats a dine-in party, which now adds `table.session-opened`. The expected counts were updated (2 to 3 events), and the file then passed 15/15. |
| `npm run test:e2e`, CI mode (production build) | 174 passed, 0 flaky, 5.1 min; `live-boards.spec.ts` alone 2/2 |
| `npm run test:e2e` against `npm run dev` | Not run (advisory under policy; dev mode retries since be2f921) |
| `npm run build` | Succeeds; no warnings |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migration reconstruction and upgrade | Pass (`database/migrations.test.ts` in the integration run) |
| `npm run db:seed` twice | "0 applied, 27 already applied" both times; 149 permissions, 539 grants |
| `db:seed:validation`, `db:seed:demo` | Not re-run on the owner's dev database: their code didn't change, and `validation/validation-seed.test.ts` passed |
| `npm run db:reset` safeguards | Refused a wrongly named database ("must be named restaurant_ops") and a non-loopback host ("must use a loopback host") |

# Tests executed

- Unit: 933 (4 new in `navigation.test.ts`: cookie parse and serialize, arrival rule, current-group toggle, expand and collapse all).
- Integration: 1453, of which 8 are new:
  - `restaurant/floor-events.test.ts` (4): session lifecycle events and payloads, condition events, cancelled seating, nothing on refusal.
  - `reservations/waitlist-events.test.ts` (4): the entry lifecycle, removal and undo, a cancelled waiting reservation, nothing on refusal.
  - 2 updated in `kitchen/lifecycle.test.ts`.
- E2E: 174 (3 new: 2 in `live-boards.spec.ts`, 1 in `ui-shell.spec.ts`).

# Files changed

- New:
  - `src/modules/restaurant/services/floor-events.ts`
  - `src/modules/reservations/services/waitlist-events.ts`
  - `tests/integration/restaurant/floor-events.test.ts`
  - `tests/integration/reservations/waitlist-events.test.ts`
  - `tests/e2e/live-boards.spec.ts`
  - `docs/Phase-27-Polish-and-Leftovers.md`
  - `docs/Phase-27-Completion-Report.md`
- Changed:
  - Restaurant: `src/modules/restaurant/services/session-service.ts`, `table-service.ts`
  - Reservations: `src/modules/reservations/services/waitlist-service.ts`, `party-state.ts`
  - Workflow: `src/workflows/seat-party/seat-party.ts`
  - Realtime and boards: `src/components/realtime/realtime-provider.tsx`, `src/components/restaurant/floor-board.tsx`, `src/components/reservations/waitlist-board.tsx`
  - Navigation: `src/components/app-shell/navigation.ts`, `navigation.test.ts`, `app-shell.tsx`, `src/app/(app)/layout.tsx`
  - Tests: `tests/helpers/e2e-ui.ts`, `tests/e2e/ui-shell.spec.ts`, `tests/integration/kitchen/lifecycle.test.ts`
  - Docs: `README.md`, `CLAUDE.md`

# Risks

- **More outbox rows.** A busy floor writes several small events per seating and per turn (session, DIRTY per table, clean). They are IDs only and published within a second; the Phase 16 retention job already prunes published rows.
- **Refresh bursts.** A combined change (for example completing a three-table session) sends several events; `useRealtimeRefresh` debounces them into one refresh (250 ms).
- **Cookie scope.** The preference is per browser, not per user: two people sharing one browser share it. It holds no personal data.
- **Single instance.** Delivery still assumes one app instance, as noted since Phase 10.

# Remaining issues

- Dev-server E2E was not run this phase (advisory; CI mode is the gate).
- Table and section configuration changes still reach open boards only on the 30-second fallback (D5).
- A real SMTP and Twilio send stays a manual check for the owner (Phase 22 leftover).

# Next-phase readiness

No phase is scheduled after 27. Cloud deployment remains on hold by owner decision (2026-11-10).
