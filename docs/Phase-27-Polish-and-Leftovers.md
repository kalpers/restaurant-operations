# Phase 27: Polish and Leftovers Design and Implementation Plan

## Purpose

Owner request, 2026-11-18: a polish phase for the leftovers that remain after Phase 26.

A review of the repository on 2026-11-18 found that most candidate leftovers are already closed:

| Candidate | Status | Where |
|---|---|---|
| Reservations board live on staff changes and online bookings | Done in Phase 24 (policy 18) | `reservation-service.ts` `writeReservationEvent`; `reservations-board.tsx` `BOARD_EVENTS` |
| Move/share test for an acknowledged allergen item | Done in Phase 22 | `tests/integration/orders/allergens.test.ts` "moves and shares an acknowledged item…" |
| Guest profiles and allergen tags in the validation and demo seeds | Done in Phase 22 (policy 24) | `scripts/validation-guests-allergens.ts`, `scripts/demo-guests-allergens.ts` |
| Audit `auth.sign-in-failed` and `auth.account-locked` | Done in Phase 16 ("deferred" there means written after the response with `after()`) | `credential-service.ts`; `tests/integration/auth/lockout.test.ts` |
| Edge Runtime `node:crypto` build warning | Gone since Phase 22 | Phase 22 report, "Edge Runtime warning gone: PASS" |

What is still open, and is the scope of this phase:

1. **Live floor and waitlist boards.** `floor-board.tsx` ("The floor has no realtime yet") and `waitlist-board.tsx` refresh only on a 30-second `setInterval`. Seating, moving, combining, assigning a server, ending a session, changing a table's condition and every waitlist change write no outbox event, so another host's or server's screen is up to 30 seconds stale.
2. **Navigation extras** listed in the Phase 26 report: remember which groups are open across reloads (Phase 26 D2 left this out), and an "Expand all / Collapse all" control.

## Decisions for the owner

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D1 | Scope? | **Only items 1 and 2 above.** The validation fixture's single location (no transfer, Phase 23 amendment 7) stays as is; the demo seed already shows transfers. The real SMTP and Twilio send stays the owner's manual check. | The other candidates are done (table above). |
| D2 | Event names? | **Past-tense, per change, IDs only**, matching Phases 17–24: `table.session-opened`, `table.session-moved`, `table.session-tables-changed` (combine or remove a table), `table.session-server-assigned`, `table.session-completed`, `table.session-cancelled`, `table.condition-changed`; `waitlist.entry-added`, `waitlist.entry-updated`, `waitlist.entry-notified`, `waitlist.tables-assigned`, `waitlist.entry-removed`, `waitlist.entry-seated`. | Specific names keep the audit-free outbox readable and let a later screen pick only what it needs. |
| D3 | Where are they written? | **In the owning domain, in the transaction that makes the change, after its existing history row**: Restaurant (`session-service.ts`, `table-service.ts`) for session and table changes; Reservations (`waitlist-service.ts`) for waitlist changes; the `seat-party` workflow for `table.session-opened` (it inserts the session); `seat-guest-party` for `waitlist.entry-seated`. | Rule 8 (outbox, after commit) and module ownership. A refused change rolls back, so it writes no event. |
| D4 | Which boards listen? | **Floor:** `table.session-*`, `table.condition-changed`, the `reservation.*` events (holds show on the floor) and `order.closed`. **Waitlist:** `waitlist.*`, `table.session-*`, `table.condition-changed` and `reservation.*` (they change the table recommendations). Both use `useRealtimeRefresh` with the shared 30-second fallback, replacing their own `setInterval`. | Same pattern as the reservations, stock and kitchen boards; nothing depends on the stream. |
| D5 | Section and table configuration changes (create/edit table, section membership, section server)? | **Out**; the 30-second fallback covers them. | They change rarely and mostly from a manager's configuration page. |
| D6 | How are open groups remembered? | **A cookie** `nav_groups` (group IDs and open/closed only, `SameSite=Lax`, `Path=/`, one year, not `HttpOnly` because the browser writes it). The app layout reads it on the server and passes it to `AppShell`, so the first render already matches: no flash and no hydration mismatch. A missing or malformed cookie means the Phase 26 default. | `localStorage` can only be read after hydration, which flashes the default first; that was why Phase 26 left this out. The cookie holds no personal or security data. |
| D7 | Remembered state vs the current page? | **The current page's group always opens when you arrive on a page** (you can still close it there). Every other group follows what you last chose; a group you never toggled is closed. | A remembered "closed" must never hide the link you are on. |
| D8 | Expand all / Collapse all? | **One small text button at the top of the nav**: "Expand all" when any group is closed, otherwise "Collapse all". Collapse all closes every group except the current page's. The result is remembered like a single toggle. | Quick relief for the longer groups without another control per group. |
| D9 | E2E helper? | `expandNavGroups(page)` uses the new "Expand all" button when present, keeping its current fallback. | Fewer clicks per spec; the helper stays the one entry point. |

## Approved Phase 27 Policies

Approved by the owner on 2026-11-18: D1–D9 as recommended. These are binding.

1. **Scope (D1).** Live floor and waitlist boards, and navigation memory with Expand all / Collapse all. Nothing else.
2. **Events (D2).** `table.session-opened`, `.moved`, `.tables-changed`, `.server-assigned`, `.completed`, `.cancelled`; `table.condition-changed`; `waitlist.entry-added`, `.entry-updated`, `.entry-notified`, `.tables-assigned`, `.entry-removed`, `.entry-seated`. Payloads hold IDs only.
3. **Where written (D3).** In the owning domain's transaction, after its history row: Restaurant for sessions and tables, Reservations for the waitlist, `seat-party` for `table.session-opened`, `seat-guest-party` for `waitlist.entry-seated`. A refused change writes nothing.
4. **Listening (D4).** Floor: `table.session-*`, `table.condition-changed`, `reservation.*`, `order.closed`. Waitlist: `waitlist.*`, `table.session-*`, `table.condition-changed`, `reservation.*`. Both through `useRealtimeRefresh` with the 30-second fallback.
5. **Not evented (D5).** Table and section configuration.
6. **Navigation memory (D6, D7).** Cookie `nav_groups` (group IDs and open/closed only; `SameSite=Lax`, `Path=/`, one year), read by the app layout on the server. On arrival the current page's group is open; other groups follow the cookie, closed if never toggled. Malformed means the Phase 26 default. This replaces Phase 26 D2.
7. **Expand all / Collapse all (D8).** One button at the top of the nav; Collapse all keeps the current page's group open; the result is remembered.
8. **E2E helper (D9).** `expandNavGroups` uses Expand all when present.
9. **Boundaries.** No migration, no new permission (149), no rule change; hidden links remain usability only.

## Amendments decided at implementation

1. **Session event names (policy 2).** The plan proposed `table-session.*`, but `outbox_events_event_type_format` (migration 0015) allows only `^[a-z]+[.][a-z-]+$`, with no hyphen before the dot. Changing it would need a migration, which policy 9 excludes, so the session events are `table.session-opened`, `-moved`, `-tables-changed`, `-server-assigned`, `-completed` and `-cancelled`, beside `table.condition-changed`. Meaning and payloads are unchanged; the text above uses the final names.
2. **Where waitlist seating and cancellation events are written (policy 3).** `waitlist.entry-seated` is written by `markPartySeated` and `waitlist.entry-removed` by `cancelOpenWaitlistEntry` (both in Reservations' `party-state.ts`), so seating a waiting reservation party and cancelling a waiting reservation also tell the waitlist. Undoing a mistaken seating (`revertPartySeating`) writes `waitlist.entry-updated`, because the entry is back on the list. Moving a party to new tables or ending its session also turns the tables it left DIRTY, which writes `table.condition-changed` per table.
3. **Waitlist board** also listens to `guest.allergies-changed`, because it shows visit allergies like the reservations board.

## 1. Objectives

Floor and waitlist screens update within about a second of a change made on another device, and the left navigation keeps the person's open groups across reloads with a one-click expand or collapse.

## 2. Scope Boundary

In: outbox events for table sessions, table condition and waitlist entries; the floor and waitlist boards subscribing to them; the provider's event list; the nav cookie, open-state rule and "Expand all / Collapse all" button; tests and docs for these.

Out: any schema change or migration, any new permission (149 stay), any change to seating, waitlist or table rules, server-side authorization (collapsed or remembered links stay usability only), section/table configuration events (D5), the validation fixture's second location, cloud deployment.

## 3. Review Existing Foundation Before Changes

- `src/infrastructure/outbox/outbox.ts` (`writeOutboxEvents`, IDs-only payload rule) and `src/infrastructure/realtime/realtime-hub.ts` (location-scoped delivery).
- `src/components/realtime/realtime-provider.tsx`: `EVENT_TYPES` must list every new type, or the browser never receives it.
- `writeReservationEvent` in `reservation-service.ts` and `tests/integration/reservations/reservation-events.test.ts` as the Phase 24 pattern.
- `session-service.ts` (`moveSession`, `addTableToSession`, `removeTableFromSession`, `assignSessionServer`, `completeSessionInTransaction`, `cancelSessionInTransaction`), `table-service.ts` (`cleanTable`, `changeTableCondition`), `waitlist-service.ts`, and the `seat-party`, `seat-guest-party`, `move-table-session` and `end-table-session` workflows.
- `src/components/app-shell/app-shell.tsx`, `navigation.ts`, the `(app)` layout, `tests/helpers/e2e-ui.ts` (`expandNavGroups`, `openNavLink`) and `tests/e2e/ui-shell.spec.ts`.

## 4. Build Order

1. Restaurant events: a small `writeFloorEvent` helper in the Restaurant module; call it from the session and table services and the seat-party workflow (D2, D3).
2. Waitlist events: a `writeWaitlistEvent` helper in Reservations; call it from `waitlist-service.ts` and `seatWaitlistParty`.
3. Add the new types to `EVENT_TYPES`; switch the floor and waitlist boards to `useRealtimeRefresh` (D4).
4. Navigation: a pure `isNavGroupOpen` rule and cookie parse/serialize in `navigation.ts`; the layout reads the cookie; `AppShell` takes the initial state, writes the cookie on toggle, and renders "Expand all / Collapse all" (D6–D8).
5. Update `expandNavGroups` (D9).
6. Tests (sections 5–7), README and docs (section 8), validation (section 9), completion report.

## 5. Unit Tests

- `isNavGroupOpen`: current group opens on arrival; remembered closed groups stay closed elsewhere; never-toggled groups are closed; toggling on the current page sticks for that page.
- Cookie parse: unknown group IDs, wrong types, oversize and malformed values fall back to the default; serialize round-trips.
- Expand/collapse-all label and result, including that collapse all keeps the current group open.

## 6. Integration Tests

New `tests/integration/restaurant/floor-events.test.ts` and `tests/integration/reservations/waitlist-events.test.ts`:

- Each mutation in D2 writes exactly one event of the expected type, with the actor's organization and location, and a payload of IDs only (session, table, entry IDs; no names, notes, contact details or party details).
- A refused change (version conflict, table not available, wrong state) writes no event.
- Seating from the waitlist writes `table.session-opened` and `waitlist.entry-seated` in the same transaction; seating a reservation keeps writing `reservation.seated` (Phase 24 unchanged).
- Completing a session writes `table.session-completed` and the table goes DIRTY with `table.condition-changed`; marking it clean writes `table.condition-changed` again.
- The canonical Bacon Cheeseburger test and the Phase 24 reservation events test pass unchanged.

## 7. E2E Tests (Playwright)

- Floor: two browser contexts; the host seats a walk-in in one, and the other context's floor shows the table occupied without a reload, well within the 30-second fallback (assert within 10 s). Then mark the table clean and see it available.
- Waitlist: one context adds a waitlist entry; the other context's waitlist board shows it without a reload.
- Navigation (`ui-shell.spec.ts`): a group opened and another closed stay that way after a reload; the current page's group opens even if it was remembered closed; "Expand all" then "Collapse all"; the phone drawer behaves the same.
- Specs using `expandNavGroups` pass unchanged.

## 8. Documentation

- README: the realtime events list (section 23/24 area), the Restaurant and Reservations as-built notes, and a Phase 27 entry in sections 33 and 36.
- CLAUDE.md: add Phase 27 to the phase list.
- `docs/Phase-27-Completion-Report.md`.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first); a dev-server run is advisory (dev mode retries, be2f921)
- [ ] `npm run build`, with no new warnings
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] No schema change: `npm run db:generate` reports no changes; migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants (149); `db:seed:validation` and `db:seed:demo` twice create no duplicates
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] Outbox payloads for the new events hold IDs only (integration test)
- [ ] Canonical Bacon Cheeseburger and Phase 24 reservation events tests pass unchanged

## 10. Required Phase 27 Completion Report

Write `docs/Phase-27-Completion-Report.md`:

```text
PHASE 27 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Leftover review (what was already done, and where):
- Floor and table events:
- Waitlist events:
- Boards listening:
- Navigation memory (cookie, current-group rule):
- Expand all / Collapse all:
- Permissions, audit and boundaries:

Results
- Each floor and waitlist change writes one IDs-only event, none on refusal: PASS / FAIL
- Floor and waitlist boards update on another device without a reload: PASS / FAIL
- Open groups survive a reload with no flash; the current group always opens: PASS / FAIL
- Expand all / Collapse all: PASS / FAIL
- Canonical Bacon Cheeseburger and Phase 24 reservation events unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e CI and dev, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
