# Phase 22 Completion Report: Online Reservations and Guest Messaging

PHASE 22 COMPLETION REPORT

## Summary

Phase 22 builds README section 39 group 2, chosen by the owner on 2026-11-12, plus the Phase 21 leftovers. Plan: `docs/Phase-22-Online-Reservations-and-Guest-Messaging.md`. It was approved with D1–D16 as recommended and has 16 amendments recorded while building.

- **Guest messaging.** Email and SMS service messages to guests: confirmed, request received, changed, cancelled, reminder and table ready.
  - They go through a provider-neutral port with capture, SMTP and Twilio adapters.
  - Each message is queued in the transaction of the change it reports and sent by a dispatcher after commit, with no transaction open.
  - A message is sent only with the visit's consent for that channel, and never to an address on the opt-out list.
- **Online booking.** A public, signed-out page per location (`/book/{code}`).
  - It offers times from booking hours, with lead time, a booking window, a party-size limit and per-slot pacing, all checked again under a location lock.
  - The guest gets a private link to view or cancel the booking. Only a SHA-256 hash of its token is stored.
  - Public actions are recorded with a new `GUEST` audit actor.
- **Phase 21 leftovers.**
  - The validation and demo seeds now include allergen tags, a declared `MAY_CONTAIN` and guest profiles.
  - A new test moves and shares an acknowledged item.
  - The `node:crypto` Edge Runtime build warning is gone.
  - The E2E suite was run against the dev server.

Nothing is committed. The owner reviews and commits.

## Environment

- Node v26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker `postgres:17-alpine`)
- nodemailer 10.5.0, pinned exactly. An npm `overrides` entry lets `next-auth`'s optional peer use it; see DEV-004 below.
- Base commit `0d906d5`, Windows 11, PowerShell, local Docker database

## Policies (as built)

- **Messaging infrastructure (port, adapters, message outbox, dispatcher, suppressions)**
  - `src/infrastructure/messaging/`: `MessageSender` returns a result and never throws. Adapters:
    - `capture` writes JSON files and sends nothing.
    - `smtp` uses nodemailer, plain text only, with file and URL access disabled.
    - `twilio` calls the REST API over `fetch`. 429, 5xx, 401 and 403 are retried; 21610 is an opt-out; other 4xx fail.
    - Each provider call has a 10 s timeout.
  - Configuration is parsed in `src/config/` (`env.ts`, `messaging-env.ts`). Production must name both providers and refuses `capture` unless `MESSAGING_ALLOW_CAPTURE_IN_PRODUCTION=true`, which only the Playwright config sets. A real provider needs its settings and `MESSAGING_SUPPRESSION_KEY`. These rules are checked when messaging starts (amendment 16).
  - `guest_messages`: one unique dedupe key per trigger. CHECKs tie each status to its timestamps. A guard trigger keeps identity fixed, lets content only be cleared, and moves status only forward.
  - The dispatcher, in Reservations (`guest-message-dispatch.ts`) and started from `instrumentation.ts`:
    1. sends `SENDING` rows older than 5 minutes back to the queue;
    2. claims due rows with `SKIP LOCKED` in a short transaction;
    3. sends each one with no transaction open;
    4. records the outcome only if the row is still under its claim.

    Retries back off from 5 s, doubling, up to 15 min. A message fails after `MESSAGE_MAX_ATTEMPTS` (8).
  - `message_suppressions` holds an HMAC of the channel and normalized address, is append-only, and survives erase.
  - Admin → System health shows guest messages waiting and failed.
- **Consent**
  - `guest_party_message_consents`: one active consent per visit and channel. The address is E.164 for SMS and normalized for email. Source is `STAFF_RECORDED` or `ONLINE_FORM`. A consent is withdrawn once and never re-opened.
  - The host forms have two unticked boxes.
  - A changed phone or email withdraws that channel (`ADDRESS_CHANGED`). Withdrawing cancels waiting messages.
  - Staff can withdraw from the Messages panel. The email unsubscribe link records `UNSUBSCRIBED`.
- **Online booking (settings, slots, booking, throttling, manage link, page)**
  - **Settings.** `online_booking_settings` and `online_booking_periods`, at Host → Online booking (`reservations.online.manage`). Without a settings row, online booking is off.
  - **Slots.** `listOfferedSlots` is pure. A time is offered when it is inside a booking period (start included, end excluded), exists on that date (daylight-saving gaps are skipped), is past the lead time and inside the window, and the slot's covers plus this party stay within the pacing limit.
  - **Booking.** `createOnlineReservation` runs under `pg_advisory_xact_lock` for the location.
    - It checks the slot again and allows at most 2 upcoming online bookings per contact.
    - It creates the party (no profile), the reservation (`ONLINE`, no creating user, `CONFIRMED` or `PENDING`) and the allergies (source `ONLINE`).
    - It records the consents (`ONLINE_FORM`), creates the manage link, and queues the confirmation or "request received" message.
    - It writes audit with a `GUEST` actor and the `reservation.online-booked` outbox event.
    - A retry with the same key returns the first booking (amendment 10). A filled spam-trap field gets a normal-looking reply and nothing is stored.
  - **Throttling.** `public_throttles` keeps a fixed one-hour window per HMAC key: 5 attempts per contact, and 30 per IP behind `AUTH_CLIENT_IP_HEADER` only. Over the limit is a 429.
  - **Manage link.** View, and cancel until the start time while the party is still expected. Every bad token gets the same answer. A guest cancel sets `cancelled_by_guest`, cancels waiting messages and queues the cancellation message.
  - **Pages.** `src/app/(public)/`: booking, manage, and unsubscribe (a button that POSTs, so link scanners change nothing). No staff shell; they work at phone width.
- **Messages from staff actions (reservations, reminders, waitlist, history)**
  - Messages are queued by: create as `CONFIRMED`, confirm, a change of date, time or party size (which also cancels any waiting reminder), and cancel. No-show and seating cancel what is waiting.
  - Reminders come from the hourly maintenance run. One per reservation time, only for bookings made before the window opened, between 09:00 and 21:00 local time, and skipped if they could only go out after the start.
  - Notify on the waitlist queues the table-ready message (SMS first, else email). "Text again" repeats it at most once a minute (amendment 7).
  - The Messages panel on each card shows consent, history (addresses masked without `guests.contact.view`, never bodies), Retry, Send confirmation again, and Text again.
- **Erase, retention, permissions, audit and boundaries**
  - Erasing a profile now also withdraws and clears its visits' consents, clears message addresses, subjects and bodies (cancelling unsent messages), and revokes manage links.
  - An unlinked visit can be erased on its own (`guests.visit-erased`).
  - Maintenance clears finished messages older than 90 days and deletes expired manage links and old throttle windows.
  - Three new permissions (148 in all): `reservations.online.manage` (Owner, General Manager, Manager); `messages.view` and `messages.resend` (Owner, General Manager, Manager, Host).
  - New audit category `MESSAGING`, and a third actor type, `GUEST`.
  - Outbox events `reservation.online-booked` and `reservation.guest-cancelled` carry identifiers only.
  - Templates are fixed text: no notes, special requests or allergies.
- **Phase 21 leftovers**
  - New seed step `phase21.validation-guests-allergens`: 13 ingredients tagged and reviewed, French Fries declared `MAY_CONTAIN` wheat, a severe-peanut VIP profile, a milk-allergy profile, and a duplicate merged into it. The demo seed adds the tags and two profiles.
  - New integration test: an acknowledged burger is moved, then shared. Its `order_item_allergens` rows, acknowledgment columns and ticket alert stay the same.
  - `instrumentation.ts` checks `NEXT_RUNTIME` inline, and `src/config/runtime.ts` was removed.
  - The full E2E suite was run against `next dev`.

## Results

- Messages queued only on commit and sent only after it: **PASS**.
  - A message is written only in the transaction of its change.
  - A test reading from a separate connection sees the claim committed (`SENDING`) while the provider is being called.
- No message without consent, and none to a suppressed address: **PASS**. Covered by integration tests for consent, withdrawal, address change, provider opt-out and unsubscribe.
- Online booking can't exceed pacing under concurrency: **PASS**. When two concurrent parties of 5 compete for an 8-cover slot, one is booked and the other gets `SLOT_UNAVAILABLE`.
- An idempotent booking retry creates one booking and one set of messages: **PASS**.
- Manage token stored hashed and never logged: **PASS**. Only the SHA-256 hash is stored; `apiRoute` never logs URLs.
- Erase clears messaging personal data and keeps history: **PASS**.
- No contact data, message bodies or tokens in audit, logs or outbox: **PASS**. The tests assert this on audit rows, outbox payloads and suppression rows.
- Edge Runtime warning gone: **PASS**. `npm run build` prints no `node:crypto` or Edge Runtime warning.
- Canonical Bacon Cheeseburger unchanged: **PASS**. The canonical tests run unchanged in the full integration suite.

## Architectural decisions

- **D1 and DEV-004: one new dependency.**
  - Every nodemailer release that `next-auth` 4 accepts (`^7.0.7`) has high-severity advisories.
  - By owner decision, nodemailer 10.5.0 is pinned and given to `next-auth`'s optional peer through `overrides`. `next-auth` loads it only in its Email provider, which this app never imports.
  - Recorded as accepted risk `DEV-004`, with controls and review triggers. `npm audit --omit=dev` is clean.
- **The first outbound network integration.** It sits behind `MessageSender`, and nothing sends while a transaction is open. Messages use their own outbox table rather than `outbox_events`, whose payloads must stay free of contact data.
- **The first public business endpoints.** They act as a `GUEST` (no user, no permissions, one location), use separate routes (`/api/public`) and are throttled.
- **Code location.** Dispatch logic lives in Reservations, beside its table. The infrastructure runner is only the timer (amendment 4).
- **Opt-out key.** The opt-out list uses its own key, `MESSAGING_SUPPRESSION_KEY`. A rotation of `NEXTAUTH_SECRET` therefore never re-enables messages to an opted-out guest (amendment 3).
- **No architecture deviations.** No new server, queue, cache or database. All new tables are owned by Reservations.

## Migrations

| Migration | Contents |
|---|---|
| `0051_guest_messaging` | `guest_messages`, `message_suppressions` |
| `0052_guest_messaging_guards` | Custom: the message guard (identity, content can only be cleared, forward-only status, no delete) and the append-only suppression guard |
| `0053_guest_message_consents` | `guest_party_message_consents` (short, hand-named foreign keys: generated names passed PostgreSQL's 63-character limit), `reservation_manage_links`, and the `MESSAGING` audit category |
| `0054_guest_message_consents_guards` | Custom: consents change only to be withdrawn or have their address cleared; manage links only revoked, and deleted only once expired or revoked |
| `0055_online_booking` | `online_booking_settings`, `online_booking_periods`, `public_throttles`; `reservations.source` gains `ONLINE`, plus `cancelled_by_guest`, `online_request_key_hash` and nullable `created_by_user_id` (CHECKed to `ONLINE`); party allergies gain source `ONLINE` with a nullable recording user; the `GUEST` audit actor |

All five were generated, reviewed and kept (0052 and 0054 are custom by design). `npm run db:generate` reports no changes. Migrations 0053–0055 were regenerated before they were ever applied outside test databases, once to fix the foreign-key name length and once to add the step 4 columns. On the dev database, `npm run db:migrate` applied 0051–0055 (56 migrations recorded).

## Validation results

| Check | Result |
|---|---|
| `npm run lint` | Clean |
| `npm run typecheck` | Clean |
| `npm run test:unit` | 886 / 886 passed (60 files) |
| `npm run test:integration` | 1380 / 1380 passed (90 files, 13.2 min) on the final full run. The run before it had 2 failures: the migration test's expected table list lacked the three step 4 tables. Only the test's list was changed. |
| `npm run test:e2e`, CI mode (`next start`) | 159 / 159 passed (6.1 min) |
| `npm run test:e2e`, dev server (`next dev`) | Full run: 137 / 159 passed. All 12 failures were 5-second assertions that ran out while `next dev` compiled a route on first request (pages still saving, still on `/login`, a dialog waiting on an API that hadn't compiled), across inventory, kitchen, menu, 86 board, reservations, restaurant, service polish, guest profiles and the new online booking spec. Re-run: all 12 pass. The one test change was a 20 s wait for the first load of the public booking page. A `--last-failed` re-run can't run a serial spec's later tests alone (their earlier tests set up the location), so those specs were re-run in full: online booking 7 / 7, guest profiles 3 / 3. The Playwright config already notes this dev-mode compile delay; CI uses the production build. |
| `npm run build` | Succeeds; no `node:crypto` or Edge Runtime warning |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (all) | 11 moderate, development tooling only (`esbuild` via `drizzle-kit`, `minimatch` via `eslint-config-next`), tracked as DEV-002; none from nodemailer |
| Migration reconstruction and upgrade tests | Pass (`migrations.test.ts`, 23 tests) |
| `npm run db:seed` twice (dev database) | First run: 1 applied, 25 already applied. Second run: 0 applied, 26 already applied. 148 permissions, 148 distinct |
| `db:seed:validation` twice | The validation seed test builds its own database and runs every step twice; the second run adds no rows to any counted table, including the 7 Phase 21 tables |
| `db:reset` safeguards | The existing reset guard tests pass in the integration suite |
| Bacon Cheeseburger canonical test | Passes unchanged |
| No provider call while a transaction is open | Tested |
| No address, body, token or credential in audit, logs or outbox | Tested |

## Tests executed

- **Unit: 886** (836 at the end of Phase 21, +50). New: env messaging rules, adapters (SMTP and Twilio classification, Twilio request shape, capture, `public/` refusal), dispatch policy, message addresses and the suppression hash, templates, reminder schedule and quiet hours, online slots and period validation.
- **Integration: 1380** (1323 at the end of Phase 21, +57). New files:
  - `infrastructure/message-dispatch.test.ts` (14)
  - `reservations/guest-messaging.test.ts` (24: consent, staff messages, waitlist, history and resend, reminders, erase, retention)
  - `reservations/online-booking.test.ts` (15)

  Added to existing files: the move-and-share test (`orders/allergens.test.ts`), the Phase 21 upgrade seed test, the validation seed step, and updated permission, table and seed counts.
- **E2E: 159** (152 at the end of Phase 21, +7), in both CI mode and against the dev server (see Validation results). New `online-booking.spec.ts`:
  - a closed page;
  - manager settings;
  - a guest booking with an axe check, a peanut allergy and the captured confirmation;
  - the host's view and message history;
  - a guest cancel through the link;
  - the waitlist table-ready text;
  - Notify without consent.

## Files changed

- **New: messaging and online booking.** `src/infrastructure/messaging/` (port, three adapters, `index.ts`, dispatcher runner, health, adapter tests); `src/config/messaging-env.ts`; `src/db/schema/guest-messaging.ts` and `online-booking.ts`; `src/db/seeds/guest-messaging-permissions.ts`.
- **New: Reservations.** Rules `message-address`, `message-dispatch-policy`, `message-templates`, `reminder-schedule` and `online-slots`, each with tests; services `guest-message-dispatch`, `guest-message-service` and `online-booking-service`; `repositories/public-throttle-repository.ts`; `public-request.ts`.
- **New: routes.** `src/app/api/public/` (availability, booking, guest cancel, unsubscribe); `src/app/api/reservations/online-settings/` (settings and booking hours); message history, confirmation resend and table-ready resend under reservations and waitlist; `src/app/api/guest-messages/[messageId]/resend`; `src/app/api/guest-parties/[partyId]/message-consents/[channel]` and `/erase`.
- **New: UI.** `src/app/(public)/` (book, manage, unsubscribe); `src/app/(app)/host/online-booking/`; `src/components/public/` (shell, booking form, cancel and unsubscribe buttons); `src/components/reservations/guest-messages.tsx` and `online-booking-settings-form.tsx`.
- **New: seeds and tests.** `scripts/demo-guests-allergens.ts`, `scripts/validation-guests-allergens.ts`; migrations 0051–0055 with their snapshots; `tests/fixtures/messaging-cleanup.ts`, `tests/helpers/e2e-online-booking.ts`, `tests/e2e/online-booking.spec.ts`, and the three integration files above.
- **Changed: application code.** `env.ts`, `instrumentation.ts`, `app-error.ts` (adds `TooManyRequestsError`), the audit writer and actions, the permission and role catalogs, the system health service and page, the schema files `auditing`, `guest-parties`, `reservations` and `index`, the seed registry, maintenance, the party, reservation, waitlist, party-state, guest-profile and party-allergy services and repositories, the validators, the reservation and waitlist boards and pages, host tabs, and the realtime event list.
- **Changed: scripts and tests.** `scripts/seed-demo.ts`, `seed-validation.ts` and `maintenance.ts`; test fixtures and helpers (cleanup, E2E capture path); count and list updates in the database tests.
- **Changed: docs and config.** `README.md` (sections 9, 13, 20, 22, 33, 36 and 39); `CLAUDE.md`; `docs/User-Guide.md`; `docs/Cloud-Deployment-Guide.md`; `docs/accepted-risks.md` (DEV-004); the Phase 6 and Phase 21 plans (amendment notes); the Phase 22 plan (approval and 16 amendments); `.env.example`; `playwright.config.ts`; `package.json` and `package-lock.json`.
- **Removed.** `src/config/runtime.ts`.

## Risks

- **At-least-once delivery (D3).** A crash after the provider accepts a message but before it is marked `SENT` repeats it once on recovery. SMTP carries a stable `Message-ID`. Twilio has no idempotency key for Messages, so a duplicate text is possible.
- **DEV-004.** The nodemailer peer override must be revisited when `next-auth` is upgraded.
- **No CAPTCHA (D7).** Abuse limits are pacing, the per-contact limit, the spam-trap field and throttles. Per-IP throttling works only behind a trusted proxy header, so without one a distributed script is limited only per contact and per slot.
- **SMS compliance.** Consent is recorded per visit. US carriers also require A2P 10DLC or toll-free registration, and Twilio's STOP handling must stay on. That is an operator task, listed in the Cloud Deployment Guide.
- **No real-provider runs.** Real SMTP and Twilio sends weren't exercised; tests used the capture adapter and a fake `fetch`.
- **Phone numbers.** `toE164` reads national numbers for the US and Canada only. Other countries need a number typed with `+` and the country code.

## Remaining issues

- Under `next dev`, the E2E suite has compile-time flakes, as Phase 15 noted. All 159 pass in CI mode and on a re-run; a dev-mode run on a slower machine may need the same re-run.
- Reminders and table-ready texts depend on the in-process timers. As with the outbox, run exactly one app instance.
- Phone numbers for the per-contact limit are compared after normalization. A guest who uses both a phone number and an email counts against each.
- The reservations board still refreshes every 30 s. The new realtime events are delivered, but the board doesn't subscribe to them yet.

## Next-phase readiness

Phase 22 is complete pending owner review of this report. Nothing is committed yet. Cloud deployment stays on hold, and no Phase 23 is scheduled. The remaining README section 39 groups the owner discussed on 2026-11-12 are:

- multiple active locations, with ingredient lots and expiry;
- demand forecasting for the schedule generator.
