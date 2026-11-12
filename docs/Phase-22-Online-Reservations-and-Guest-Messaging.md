# Phase 22: Online Reservations and Guest Messaging Design and Implementation Plan

## Purpose

Phase 22 builds the second README section 39 group, chosen by the owner on 2026-11-12:

- **Online reservations.** A public, signed-out booking page for each location. A guest picks a date, time and party size from the times the location offers, gives a name and contact details, and gets a booking. A private link lets them view or cancel it later.
- **Guest messaging.** Email and SMS messages for service events only: booking confirmed, changed, cancelled, a reminder, and "your table is ready" for the waitlist. They are sent only with the guest's consent for that channel, through an outside provider, and only after the change that triggered them has committed.
- **Phase 21 leftovers.** Guest and allergen data in the validation and demo seeds, a test that moves and shares an acknowledged item, the `node:crypto` Edge Runtime build warning, and a dev-server E2E run.

Left out on purpose:

- marketing messages, campaigns, loyalty, newsletters and guest list export (consent here covers service messages only)
- two-way messaging and inbound replies, beyond the provider's own STOP handling
- external reservation networks (OpenTable, Resy, Google Reserve) and their APIs
- deposits, card holds and no-show fees (no payment processing)
- online ordering, takeout ordering and delivery
- guest accounts or sign-in (the private link is the only guest credential)
- push notifications, and email or SMS to staff (staff notifications stay in-app)
- multiple active locations, ingredient lots and forecasting (later groups)
- cloud deployment (on hold)

What exists today (checked against the code on 2026-11-12):

- **Reservations.** `reservations` (statuses `PENDING`, `CONFIRMED`, `CHECKED_IN`, `SEATED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`; sources `PHONE`, `IN_PERSON`, `INTERNAL`, `WALK_IN_FUTURE`). `created_by_user_id` is NOT NULL. `createReservation` needs `reservations.manage` and an actor, and reads `allow_reservations`, the default duration and the hold minutes from `location_settings`. Tables are planned by the host; there is no slot or capacity limit on how many bookings a time can take, and no opening hours anywhere in the schema.
- **Waitlist.** `notifyWaitlistEntry` moves an entry to `NOTIFIED` and records who did it. Its comment says "Nothing is sent: there is no SMS, email or push in this application."
- **Guests.** `guest_parties` holds the visit's name, phone, email and special requests. `guest_party_allergies.recorded_by_user_id` is NOT NULL. Guest profiles (Phase 21) are organization-wide, linked by hand, and can be merged and erased. Phase 21 left out consent and messaging.
- **Outbox.** `outbox_events` payloads are identifiers only ("no prices, costs, guest contact or HR data"), and the one in-process processor publishes them to realtime subscribers. Notifications are in-app only.
- **Public access.** There is no `middleware.ts`/`proxy.ts`; every API resolves the signed-in user itself. The only routes that work signed out are sign-in and health. Sign-in throttling (Phase 16) keeps HMAC-keyed counters in PostgreSQL and counts per IP only behind a configured trusted proxy header (`AUTH_CLIENT_IP_HEADER`).
- **Audit.** `audit_events.actor_type` is `USER` or `SYSTEM`; `USER` requires `actor_user_id`.
- **Edge warning.** `src/instrumentation.ts` decides the runtime through the helper `isNodeServerRuntime()` and then imports the outbox and maintenance runners. The bundler can't see through the helper, so it traces the maintenance chain (`notify-time-based-signals` → `timeclock-service` → `idempotency-service` → `node:crypto`) into the Edge build.

It changes these written contract points, which the owner approves with this plan:

- **README section 22:** "POC notifications are in-app only" and "Do not introduce SMS/email/push integration during the POC unless intentionally added later." Guest messaging (email and SMS) is added on purpose. Staff notifications stay in-app.
- **README section 3/4 and CLAUDE.md "Notifications":** a provider-neutral outbound messaging port in `src/infrastructure/messaging/`, called only after commit by its own dispatcher (D2). It's the app's first outbound network integration.
- **README section 9:** still no public registration. Phase 22 adds the first public, signed-out business endpoints (booking only), with their own limits (D6, D7).
- **README section 13:** online source, booking settings, consent, messages, suppressions and manage links. Reservations and party allergies may have no creating user when the source is `ONLINE`.
- **README section 21 (audit):** a `GUEST` actor type for actions taken through the public page.
- **README section 39:** "SMS/email notifications" is built for guests. "External reservation integrations" stays future work.
- **Phase 6 plan, sections 1 and 9 ("Do not implement external SMS/email", "no third-party messaging packages"), and Phase 21 ("no consent, messaging"):** superseded for service messages. The ban on marketing stays.
- **CLAUDE.md:** the Phase 22 line, the notifications line, and a short messaging and online booking policy.

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially sections 3, 4, 9, 13, 21, 22, 23, 24 and the Phase 6, 10, 16 and 21 notes in section 33.
2. Read the Phase 6, 10, 16, 20 and 21 plans and completion reports. Phase 16 is the model for throttling and retention; Phase 10 for the outbox processor.
3. Read `docs/accepted-risks.md`. If D1 adds `nodemailer`, run `npm audit --omit=dev` before and after adding it.

## Decisions for the owner

Approved by the owner on 2026-11-12 as recommended. The policies below follow them.

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | Which providers, and how? | **A provider-neutral port, `MessageSender` (`send(message) → { providerMessageId } or a typed failure`), with three adapters chosen by configuration:** `capture` (the default in development and tests: writes each message as a JSON file under `.local/outbound-messages/`, no network), `smtp` for email (the `nodemailer` package, the one new dependency; any SMTP service works, including SES, SendGrid, Mailgun, Postmark and Azure Communication Services), and `twilio` for SMS (its REST API over `fetch`, no SDK). Either channel can also be `off`. | SMTP keeps email provider-independent and cloud-independent. Twilio's REST API needs no package. The capture adapter lets development, CI and E2E run with no accounts and no network. |
| D2 | How do messages leave the app safely? | **A message outbox of its own.** The change that triggers a message (booking created, waitlist notified) writes a `guest_messages` row in the same transaction: kind, channel, recipient address, rendered subject and body, status `QUEUED`. A separate in-process dispatcher (like the outbox processor, its own interval) claims due rows with `SKIP LOCKED`, sends them outside any transaction, and records `SENT` or the failure, with backoff and a dead-letter `FAILED` after a configured number of attempts. `outbox_events` is not reused. | Rule 8 and rule 5: a message exists only if its change committed, and no network call happens inside a transaction. `outbox_events` payloads must stay free of contact data, so messages can't ride in them. |
| D3 | Can a message be sent twice? | **At most one message per trigger is queued** (unique `dedupe_key`, e.g. `reservation:{id}:confirmed:v{version}`). Delivery is at-least-once: a crash after the provider accepts a message but before it's marked `SENT` can repeat it on restart. The SMTP `Message-ID` and Twilio request are built from the message ID, so a repeat can be recognized. Accept that small risk rather than build a two-phase send. | No provider offers exactly-once delivery. A rare duplicate confirmation is harmless; a lost one isn't. |
| D4 | Which messages? | **Service messages only, from fixed templates in code:** `RESERVATION_CONFIRMED` (created as or moved to `CONFIRMED`), `RESERVATION_RECEIVED` (an online booking waiting for approval, `PENDING`), `RESERVATION_CHANGED` (date, time or party size changed), `RESERVATION_CANCELLED` (by staff or guest), `RESERVATION_REMINDER` (sent by the hourly maintenance run, a location-set number of hours before, default 24) and `WAITLIST_TABLE_READY` (when the host presses Notify). Templates fill in the location name and phone, the date and time in the location's time zone, the party size and the manage link. Staff can't write free text into a message. | Covers what guests expect without building a campaign tool. No free text means a message can't be misused or leak notes. |
| D5 | What counts as consent? | **Consent per channel on the visit**, in `guest_party_message_consents`: channel (`EMAIL`, `SMS`), the address it covers, when it was given, `source` (`ONLINE_FORM` or `STAFF_RECORDED` with the user), and when it was withdrawn. The online form has one unticked box per channel ("Text me about this booking", "Email me about this booking"). Staff tick the same boxes when booking by phone or adding to the waitlist, confirming the guest agreed. **No consent, no message.** Profiles don't carry standing consent in this phase; consent is for one visit. | SMS rules (US TCPA, carrier registration) expect express consent before texting, even for service messages. Per-visit consent is simple to explain and to erase. |
| D6 | How does a guest opt out? | **Three ways, all ending in a suppression.** An unsubscribe link in each email; SMS carries "Reply STOP to opt out", and Twilio's built-in opt-out handling blocks further texts and returns error 21610, which the dispatcher records as a suppression; and staff can withdraw a visit's consent. `message_suppressions` holds an HMAC of the channel and normalized address (no plain address), org-wide. The dispatcher checks it at send time and marks the message `SUPPRESSED`. | An opted-out guest must never be messaged again, even after erase or on a new booking. A keyed hash keeps that promise without keeping their address. |
| D7 | What can the public page do, and how is it protected? | **Book and cancel only.** `/book/{locationCode}` (the location's code, lowercased) shows times, takes a booking, and nothing else. Its APIs live under `/api/public/` and return no staff, table or other guest data. Protection: online booking is off until a manager turns it on; a party size limit (default 6, larger parties are told to call); a booking window (default from 2 hours to 30 days ahead); pacing (at most N covers starting in each slot, default 20); at most 2 upcoming online bookings per normalized phone or email per location; a hidden honeypot field; and per-IP throttling with the Phase 16 design (HMAC-keyed counters, only behind the trusted proxy header). **No CAPTCHA** (it would add an outside script and a third party). | Keeps the public surface small. Each limit is cheap, local and testable. A CAPTCHA can be added later if abuse shows up. |
| D8 | Are online bookings confirmed at once? | **A location setting, `online_requires_approval`, default off.** Off: a booking that passes the limits is `CONFIRMED` and the guest gets `RESERVATION_CONFIRMED`. On: it's `PENDING`, the guest gets `RESERVATION_RECEIVED`, and the host confirms or cancels it (existing transitions), which sends the matching message. Online bookings never get tables assigned automatically; the host plans tables as today. | The restaurant chooses its own control. Table planning stays a host decision, and planning conflicts are still checked when the host assigns. |
| D9 | How is a slot's availability decided? | **Booking hours plus pacing, not table fitting.** `online_booking_periods` (weekday, start, end, per location) lists when bookings may start. Times are offered every `slot_interval_minutes` (default 15) inside a period, after the lead time and within the window. A time is offered while the covers of active reservations (`PENDING`, `CONFIRMED`, `CHECKED_IN`) starting in that slot plus the party size stay within `max_covers_per_slot`. The check runs again inside the booking transaction under a location-level advisory lock, so two guests can't both take the last covers. | Table fitting would promise specific tables online and conflict with host planning (Phase 6). Pacing is what restaurants usually set for online books, and it can't double-book. |
| D10 | Who is the actor for a public action? | **A `GUEST` actor, with no user.** `reservations.created_by_user_id` and `guest_party_allergies.recorded_by_user_id` become nullable, with a CHECK that they're null only for `source = 'ONLINE'` (and `source = 'ONLINE_FORM'` for allergies). `audit_events.actor_type` gains `GUEST` (no user ID). Public commands run through a small `PublicBookingActor` that holds only the location and carries no permissions; they call the same Reservations services, which accept it only on the online paths. | Keeps "who did this" truthful in the history and audit. It doesn't invent a fake user, and the permission checks stay as they are for staff. |
| D11 | What can the private link do? | **View and cancel only, until the reservation time.** A 32-byte random token is sent in the link; only its SHA-256 hash is stored (`reservation_manage_links`). It stops working once the reservation is finished, at its post-grace time, or when the profile is erased. Changing a booking means cancelling it and booking again. A wrong or expired token gets the same "This link isn't valid" answer. | A token is the only credential a guest has, so it's treated like a password reset token: unguessable, stored hashed, never logged. View and cancel cover most needs without letting a link change what the host has planned. |
| D12 | Can online guests give allergies and a profile? | **Allergies yes, profile no.** The form offers the allergen list (Phase 21) with "allergy" or "severe", and the special requests text. They're stored as `RECORDED` party allergies with no recording user. The booking is **never linked to a profile automatically** (Phase 21 D3); the host sees the usual matching suggestions on the reservation. | Allergies at booking help the kitchen. Automatic linking could show another guest's allergies, which Phase 21 ruled out. |
| D13 | Who sees messages and settings? | **Three new codes** (148 in all): `messages.view` (the message history on a reservation or waitlist entry, with status; addresses masked unless the user also holds `guests.contact.view`), `messages.resend` (requeue a `FAILED` message, or send a confirmation again) and `reservations.online.manage` (online booking settings, booking hours and messaging settings). Recording consent at the host stand uses `reservations.manage` or `waitlist.manage`. | Follows the Phase 21 tiers: contact details stay behind `guests.contact.view`. |
| D14 | What happens on erase, and how long are messages kept? | **Erase clears messaging too.** Erasing a profile (Phase 21) also clears, for its linked parties: consent addresses, the recipient address and body of every message (kind, channel, status and times stay), and every manage link. Suppressions stay because they hold only a hash. **Retention:** the maintenance run clears the address and body of messages older than `MESSAGE_RETENTION_DAYS` (default 90). | Honors deletion requests, and keeps contact data only as long as it's useful for answering "did they get the text?". |
| D15 | Are there quiet hours? | **Reminders only**, sent between 09:00 and 21:00 in the location's time zone. A reminder that falls outside is sent at the next 09:00 if the reservation hasn't started by then; otherwise it's skipped. Confirmations, cancellations and table-ready messages go at once, because the guest just acted or is waiting at the door. | Avoids texting guests at night without delaying the messages they're waiting for. |
| D16 | Where do the Phase 21 leftovers go? | **As the last build step**, in the same verified way: the validation and demo seeds gain profiles, allergen tags and declared allergens (idempotent); an integration test moves and shares an acknowledged item and checks the snapshot and acknowledgment travel with it; `instrumentation.ts` tests `process.env.NEXT_RUNTIME === "nodejs"` inline before its dynamic imports, so the Edge build drops the chain (confirm the warning is gone; if it isn't, stop and report); and the E2E suite is run once against `npm run dev`. | Small, independent and already approved as leftovers. |

## Approved Phase 22 Policies

Binding since the owner approved D1–D16 on 2026-11-12.

### A. Messaging infrastructure

1. **Port and adapters (D1).**
   - `src/infrastructure/messaging/`: `message-sender.ts` (the port and its result types), `capture-sender.ts`, `smtp-sender.ts`, `twilio-sender.ts`, and `index.ts`, which picks one adapter per channel from configuration.
   - Configuration is parsed only in `src/config/` (new `messaging-env.ts`): `MESSAGING_EMAIL_PROVIDER` (`capture`, `smtp`, `off`; default `capture`), `MESSAGING_SMS_PROVIDER` (`capture`, `twilio`, `off`; default `capture`), `MESSAGING_FROM_EMAIL`, `MESSAGING_SMTP_URL`, `MESSAGING_TWILIO_ACCOUNT_SID`, `MESSAGING_TWILIO_AUTH_TOKEN`, `MESSAGING_TWILIO_FROM`, `MESSAGE_DISPATCH_INTERVAL_MS` (0 turns it off; default 2000), `MESSAGE_MAX_ATTEMPTS` (default 8), `MESSAGE_RETENTION_DAYS` (default 90), `MESSAGING_CAPTURE_PATH` (default `.local/outbound-messages`, refused inside `public/`).
   - In production, `capture` is refused, and a chosen provider must have its settings. Error messages name the variable, never its value.
   - `.env.example` lists them with empty secrets. Nothing is committed with a credential in it.
   - Adapters set a timeout (10 s), never log the body or address, and turn provider errors into `TRANSIENT`, `PERMANENT` or `OPTED_OUT`.
2. **Messages (D2, D3, D4).**
   - `guest_messages` (Reservations): organization, location, `guest_party_id`, `reservation_id` or `waitlist_entry_id`, `kind`, `channel`, `recipient_address`, `subject`, `body`, `dedupe_key` (unique), `status` (`QUEUED`, `SENDING`, `SENT`, `FAILED`, `SUPPRESSED`, `CANCELLED`), `attempts`, `next_attempt_at`, `last_error_code` (the error kind and provider code, never the message), `provider_message_id`, `sent_at`, `send_after` (quiet hours), `erased_at`.
   - Constrained strings, not enums. CHECKs tie each status to its timestamps. A guard trigger lets the address and body change only to NULL (erase and retention), and status move only forward.
   - Messages are queued by one Reservations service, `queueGuestMessages(transaction, …)`. It checks the visit's consent for each channel and queues nothing without it. Templates are pure functions in `src/modules/reservations/rules/message-templates.ts`.
   - A message waiting to send is `CANCELLED` if its reason went away first (a reminder for a booking that was cancelled, a table-ready text for an entry already seated).
3. **Dispatcher (D2).**
   - `src/infrastructure/messaging/message-dispatcher.ts`, started from `instrumentation.ts` beside the outbox processor, in the Node.js runtime only.
   - Each tick claims up to 20 due `QUEUED` rows (`SKIP LOCKED`) and marks them `SENDING` in a short transaction. It checks suppressions, then sends each outside any transaction and records the result in a second short transaction.
   - `TRANSIENT`: back off (5 s, doubling, capped at 15 min), `FAILED` after `MESSAGE_MAX_ATTEMPTS`. `PERMANENT`: `FAILED` at once. `OPTED_OUT`: `SUPPRESSED` plus a suppression row.
   - A `SENDING` row older than 5 minutes (a crashed process) goes back to `QUEUED` (D3).
   - Failures are logged once per streak, as the outbox processor does. The admin system page (Phase 16) shows queued and failed counts.
4. **Suppressions (D6).**
   - `message_suppressions`: organization, `channel`, `address_hash` (HMAC-SHA-256 of the channel and normalized address with the application secret), `reason` (`UNSUBSCRIBED`, `PROVIDER_OPT_OUT`, `STAFF`), `created_at`. Unique per organization, channel and hash.
   - Email unsubscribe: `/messages/unsubscribe?token=…` with a signed token naming the message. One click records the suppression and withdraws the visit's email consent. The page says it worked, whatever the token held.
   - Phone numbers normalize as in Phase 21. Email uses the auth normalization.

### B. Consent

5. **Consent records (D5).**
   - `guest_party_message_consents`: party, `channel`, `address` (the address at the time), `granted_at`, `source` (`ONLINE_FORM`, `STAFF_RECORDED`), `granted_by_user_id` (null for `ONLINE_FORM`), `withdrawn_at`, `withdrawn_by_user_id`, `withdraw_reason`. At most one active consent per party and channel (partial unique index).
   - Changing the visit's phone or email withdraws that channel's consent. Staff must record it again for the new address.
   - Consent is checked when a message is queued, and suppression when it's sent.
6. **At the host stand.** The reservation and waitlist forms show "Guest agreed to texts" and "Guest agreed to emails" next to the phone and email fields, unticked. The reservation and waitlist detail show each channel's state and a withdraw button.

### C. Online booking

7. **Settings (D7, D8, D9).**
   - `online_booking_settings` (one row per location): `enabled` (default false), `requires_approval` (false), `max_party_size` (6), `min_lead_minutes` (120), `max_days_ahead` (30), `slot_interval_minutes` (15, one of 15/30/60), `max_covers_per_slot` (20), `reminder_hours_before` (24, 0 turns reminders off), `public_note` (shown on the page, 500 characters).
   - `online_booking_periods`: location, `weekday` (0–6), `starts_at`, `ends_at` (local times, end after start; overlapping periods refused). Edited under `reservations.online.manage`.
   - `reservations.source` gains `ONLINE`.
8. **Availability.**
   - A pure rule, `listOfferedSlots`, in `src/modules/reservations/rules/online-slots.ts`: from the periods, settings, the location time zone, now and the covers already booked per slot, it returns the offered local times for a date.
   - It uses `BusinessDateService` for the business date of each slot, and the existing local date and time resolution, so daylight-saving days work as at the host stand.
   - `GET /api/public/locations/{code}/availability?date=&partySize=` returns times only.
9. **Booking.**
   - `POST /api/public/locations/{code}/reservations` takes date, time, party size, name, phone and/or email (at least one), the consent boxes, allergies, special requests (500 characters), the honeypot and an idempotency key.
   - In one transaction it: takes the location advisory lock; checks enabled, window, party size, offered slot and pacing again; checks the per-contact limit; creates the party (no profile), reservation (`ONLINE`, no creating user, `CONFIRMED` or `PENDING`), party allergies, consents and a manage link; queues the confirmation or received message; writes audit (`GUEST` actor) and the outbox event the host screens already refresh on. Then it returns the reference number and the manage link.
   - A retry with the same idempotency key returns the first outcome (no second booking or message).
   - A filled honeypot gets a normal-looking success with nothing stored.
   - Refusals are plain: `SLOT_UNAVAILABLE`, `PARTY_TOO_LARGE`, `OUTSIDE_BOOKING_WINDOW`, `TOO_MANY_BOOKINGS`, `ONLINE_BOOKING_CLOSED`. None reveals other bookings.
10. **Throttling.** Booking, availability and manage-link requests count against `public_throttles` with the Phase 16 rules: per IP only behind `AUTH_CLIENT_IP_HEADER` (default 30 booking attempts per hour), and always per normalized contact (default 5 attempts per hour). The thresholds are environment settings. Throttled requests get 429 with a generic message.
11. **Manage link (D11).**
    - `reservation_manage_links`: reservation, `token_hash`, `created_at`, `expires_at`, `revoked_at`.
    - `/book/manage/{token}` shows the location, date, time, party size and status, and a Cancel button while the reservation is `PENDING` or `CONFIRMED` and hasn't started. Cancelling runs the existing cancel transition with reason "Cancelled by guest" and a `GUEST` actor, frees the slot's covers, and queues `RESERVATION_CANCELLED`.
    - The token never appears in logs, audit or outbox payloads. Request logs strip it from the path.
12. **The page.** `src/app/(public)/book/[locationCode]/` uses the Phase 15 primitives and the light theme, works at phone width, and doesn't load the staff app shell or any session. A location with online booking off, or an unknown code, shows the same "Online booking isn't available" page.

### D. Messages from staff actions

13. **Reservations.**
    - Creating a reservation as `CONFIRMED`, confirming a `PENDING` one, changing its date, time or party size, and cancelling it each queue the matching message for the channels with consent.
    - Marking a no-show, checking in or seating sends nothing.
    - A staff-made booking gets a manage link only when the guest has consent on some channel, since the link travels in the message.
14. **Reminders (D4, D15).** The hourly maintenance run queues `RESERVATION_REMINDER` for `CONFIRMED` reservations starting within `reminder_hours_before` hours that haven't had one (dedupe key per reservation and time), with `send_after` set for quiet hours.
15. **Waitlist (D4).** `notifyWaitlistEntry` queues `WAITLIST_TABLE_READY` (SMS first, else email) for the channels with consent, in its transaction. The host screen shows "Text sent", "Text failed" or "No consent: tell the guest in person". "Text again" on a notified entry queues a second message with a new dedupe key, at most once a minute (amendment 7).
16. **History.** The reservation and waitlist details show the message history (kind, channel, status, time; address masked unless `guests.contact.view`) under `messages.view`, and Resend under `messages.resend`.

### E. Erase, retention and boundaries

17. **Erase (D14).** `eraseGuestProfile` also, in its transaction: nulls `address` on consents and withdraws them, nulls `recipient_address`, `subject` and `body` on messages of the linked parties and marks unsent ones `CANCELLED`, and revokes manage links. A booking that was never linked to a profile can be erased from the reservation detail with the same action and permission (`guests.erase`).
18. **Retention.** The maintenance run nulls the address, subject and body of messages older than `MESSAGE_RETENTION_DAYS`, and deletes expired manage links and old `public_throttles` rows.
19. **Permissions (D13).** Three new codes, 148 in all, seeded by an idempotent `security.guest-messaging-permissions` seed:

    | Code | Covers | Granted to |
    |---|---|---|
    | `messages.view` | Message history and delivery status | Owner, General Manager, Manager, Host |
    | `messages.resend` | Requeue a failed message, send a confirmation again | Owner, General Manager, Manager, Host |
    | `reservations.online.manage` | Online booking settings, booking hours, messaging settings | Owner, General Manager, Manager |

20. **Audit.** A new `GUEST` actor type. New actions:
    - `reservations.online-booked`, `reservations.guest-cancelled` (`GUEST` actor);
    - `reservations.online-settings-changed`, `reservations.booking-hours-changed`;
    - `messages.consent-recorded`, `messages.consent-withdrawn` (channel only), `messages.resent`, `messages.suppressed` (channel and reason, no address).
    - A new `MESSAGING` audit category. Addresses, bodies, tokens and provider credentials never appear in audit rows, logs or outbox payloads.
21. **Outbox.** `reservation.online-booked` (identifiers only) so the host screens refresh. Message sending doesn't use the outbox.
22. **Rules 4, 5, 8 and 15.**
    - Sent message bodies are stored as sent and never re-rendered.
    - No network call happens inside a transaction.
    - Messages are queued in the triggering transaction and sent only after it commits.
    - No payment data is collected, and the public form refuses 13 or more consecutive digits in text fields (the Phase 21 card-safety rule).
23. **Not marketing.** Templates hold service information only. There is no bulk send, no segment and no export of consenting guests.

### F. Phase 21 leftovers (D16)

24. **Seeds.**
    - `db:seed:validation` gains three guest profiles: one with a severe peanut allergy and VIP, one with a milk allergy, and one merged duplicate. It also gains allergen tags on the validation ingredients and a declared `MAY_CONTAIN` on a fried item.
    - `db:seed:demo` gains the tags and two profiles.
    - Both stay idempotent and local-only, as today.
25. **Move and share test.** An integration test sends an item acknowledged against a peanut allergy, moves it to another check on the same session, and shares it between two checks. It checks that the `order_item_allergens` rows, the acknowledgment columns and the ticket alert are unchanged and visible from the new check.
26. **Edge warning.** As in D16. The completion report records the build output before and after.
27. **Dev-server E2E.** One full `npm run test:e2e` against `npm run dev` (with the dev server's test database configuration), results in the report.

## Amendments decided at implementation

Recorded on 2026-11-12 while building. Each says how a policy was carried out.

1. **`nodemailer` 10.5.0 with a peer override** (D1, policy 1). Every `nodemailer` release `next-auth` 4 accepts (`^7.0.7`) has open high-severity advisories. By owner decision, `package.json` pins the patched 10.5.0 and an `overrides` entry gives it to `next-auth`'s optional peer, which only its unused Email provider loads. Recorded as `DEV-004` in `docs/accepted-risks.md`.
2. **Capture in a production build is allowed only for tests** (policy 1). CI-mode E2E runs `next start`, which sets `NODE_ENV=production`. `MESSAGING_ALLOW_CAPTURE_IN_PRODUCTION=true`, set only by the Playwright config, permits `capture` there. Without it, production refuses `capture`.
3. **The opt-out list has its own key, `MESSAGING_SUPPRESSION_KEY`** (D6, policy 4), not `NEXTAUTH_SECRET`. Rotating the sign-in secret would otherwise stop matching every existing opt-out and message guests who opted out. Production requires it when a real provider is set, and `.env.example` says never to rotate it. Outside production a fixed development key is used.
4. **Dispatch code lives with its table** (policy 3). The claim, send and record pass is a Reservations service (`guest-message-dispatch.ts`), since Reservations owns `guest_messages`. `src/infrastructure/messaging/message-dispatcher.ts` is only the timer, as the maintenance runner is for its workflow. The System health counts are an infrastructure read (`message-health.ts`), like the outbox counts.
5. **The email unsubscribe link uses a random token per message**, stored as a SHA-256 hash in `guest_messages.unsubscribe_token_hash` (policy 4), rather than a signed token. Nothing new needs a secret, and the link can't be forged for another message.
6. **The runtime helper `src/config/runtime.ts` was removed** (policy 26). `instrumentation.ts` tests `process.env.NEXT_RUNTIME` inline, which the build replaces, so the Edge bundle drops the Node-only imports.
7. **"Text again" is its own action** (policy 15). Notify can't repeat: the waitlist lifecycle doesn't allow NOTIFIED to NOTIFIED, and changing it was out of scope. A NOTIFIED entry gets "Text again" (`POST /api/waitlist/{id}/messages/table-ready`, `messages.resend`), at most once a minute, audited as `messages.resent`.
8. **Manage links are built in step 2**, not step 4 (policy 11), because staff-sent confirmations carry them. The guest-facing manage page is still built with online booking.
9. **Steps 3 and 4 share one schema migration** (`0055_online_booking`). Reminders read `reminder_hours_before`, which lives in the online booking settings, so that table was needed in step 3.
10. **Online booking retries use a key on the reservation** (policy 9), `reservations.online_request_key_hash` (SHA-256 of the location and the client key, unique). `idempotency_records` needs a user, and storing the first reply there would store the manage token in plain text. A retry returns the first booking with a fresh manage link and writes nothing else.
11. **A guest cancel is marked on the reservation** (policy 11). `reservations.cancelled_by_guest` replaces the cancelling user, and the cancel CHECK requires exactly one of the two. A guest can cancel only while the party is still expected (not checked in or waiting) and before the reservation starts.
12. **Allergies from the booking form have their own source, `ONLINE`** (D12), rather than `RECORDED` with no user, so the CHECK can tie a missing user to the online form.
13. **A `TooManyRequestsError` (429) joins the structured errors** (policy 10). Every public attempt counts, whether it books or is refused.
14. **Erasing one visit has its own audit action and endpoint** (policy 17): `guests.visit-erased`, `POST /api/guest-parties/{id}/erase` under `guests.erase`, refused for a visit linked to a profile.
15. **Each queued reservation message carries its own manage link** (policy 13). A link is created per message, so every link the guest received keeps working, and erase revokes them all.
16. **Messaging configuration is checked when messaging starts, not in `parseEnv`** (policy 1). `next build` runs as production, so a required provider in the general env schema failed the build of every page. `messagingIssues` holds the same rules; `getMessagingConfig()` throws `EnvValidationError` with them, and the dispatcher calls it when the server starts, so a misconfigured production server still refuses to start messaging.

## 1. Objectives

Deliver policies 1–27, the migrations, the tests in sections 5–7, README, CLAUDE.md and User Guide updates, and `docs/Phase-22-Completion-Report.md`.

## 2. Scope Boundary

Out of scope (don't build):

- Marketing, campaigns, loyalty, bulk send, guest list export, standing profile-level consent
- Two-way messaging and inbound SMS webhooks
- External reservation networks; deposits and card holds; online ordering
- Guest accounts; changing a booking through the link
- Staff email, SMS or push notifications
- Multiple active locations, lots and expiry, forecasting, cloud deployment (on hold)

## 3. Review Existing Foundation Before Changes

Confirm from code before each step:

- `createReservation`, `updateReservation`, `confirmReservation`, `cancelReservation` and `notifyWaitlistEntry`: their transactions, where the party and versions change, and how they write audit and outbox.
- `resolveInstant` and `BusinessDateService`, so online slots resolve local times the same way.
- `processOutboxBatch` and `outbox-policy.ts`, so the dispatcher follows the same claim, backoff and dead-letter pattern.
- The login throttle repository and rules, for `public_throttles`.
- `eraseGuestProfile`, for the erase additions.
- The maintenance runner's job list, for reminders and retention.
- `audit_events` actor CHECKs and `audit-actions.ts`, and the request logger, for token stripping.
- `src/instrumentation.ts` and the build output, for the Edge warning.

If any conflicts with the policies, stop and explain before changing it.

## 4. Build Order

Migrations start at 0051. Each step generates its own migration (plus a custom one for triggers and guards), reviewed before applying, and leaves lint, typecheck, unit and integration tests green.

1. **Messaging infrastructure:** configuration, the port, the capture, SMTP and Twilio adapters, `guest_messages`, `message_suppressions`, the dispatcher and its health counts. (`nodemailer` added here; `npm audit --omit=dev` checked.)
2. **Consent and staff messages:** consents, templates, `queueGuestMessages`, the reservation and waitlist hooks, host stand checkboxes, message history, resend, permissions seed, audit.
3. **Reminders, erase and retention:** the maintenance jobs, quiet hours, erase additions.
4. **Online booking:** settings and periods, the slot rule, nullable actors and the `GUEST` actor, the public APIs, throttling, manage links, the public pages, the settings screen.
5. **Phase 21 leftovers:** seeds, the move and share test, the Edge warning, the dev-server E2E run.
6. **E2E, documentation and the completion report.**

## 5. Unit Tests

- *Slots:* periods and interval; lead time and window; pacing with existing covers; a daylight-saving day; a period across midnight refused.
- *Templates:* each kind renders the location time zone time and the manage link; no notes or allergies in any body.
- *Consent and suppression:* address normalization and the HMAC; a changed address withdraws consent.
- *Dispatcher policy:* backoff, dead letter, error classification, stale `SENDING` recovery, quiet hours.
- *Configuration:* production refuses `capture` and missing provider settings; errors don't include values.
- *Adapters:* SMTP and Twilio requests built correctly against fakes; timeouts become `TRANSIENT`; Twilio 21610 becomes `OPTED_OUT`.

## 6. Integration Tests

- **Message outbox:** a message is queued only when its change commits (a rolled-back booking leaves none); the dispatcher sends once with the capture adapter; transient failure retries then fails; suppression stops a send; no network call inside a transaction (the sender is never called while a transaction is open).
- **Consent:** no consent queues nothing; withdrawing cancels queued messages; changing the phone withdraws SMS consent.
- **Staff flows:** create, confirm, change and cancel queue the right messages once; a retried request queues no second message; waitlist Notify queues a table-ready text.
- **Reminders:** queued once inside the window, delayed by quiet hours, cancelled when the booking is cancelled.
- **Online booking:** offered slots match the rule; booking creates party, reservation (`ONLINE`, no user), allergies, consent, link and message in one transaction; two concurrent bookings can't both take the last covers; the per-contact limit; disabled location; honeypot stores nothing; the idempotent retry; throttling returns 429.
- **Manage link:** view and cancel with the token; a wrong, expired or erased token gets the same answer; the token isn't stored in plain text or logged.
- **Erase and retention:** erase clears consents, addresses, bodies and links and keeps statuses and the suppression; retention clears old bodies.
- **Permissions:** every new staff API refuses without its permission; addresses masked without `guests.contact.view`; public APIs expose no staff, table or other-guest data.
- **Audit:** the `GUEST` actor is written for online booking and guest cancel; no address, body or token in any audit row.
- **Phase 21 leftovers:** the move and share test (policy 25); seeds run twice without duplicates.
- **Canonical scenario:** the Bacon Cheeseburger test passes unchanged, and the scenario's reservation, with SMS consent, queues one confirmation and one table-ready message when it goes through the waitlist path.
- **Migrations:** reconstruction and upgrade-from-Phase-21 checks; existing reservations keep their creating user; online booking is off for existing locations.

## 7. E2E Tests (Playwright)

- **New `online-booking.spec.ts`:** a manager turns on online booking with Friday hours; a guest (signed out) books a table for 4 with a peanut allergy and SMS consent; the confirmation appears in the capture folder with a manage link; the host sees the online booking with the allergy and the message history; the guest cancels through the link and the host sees it cancelled.
- **Waitlist text:** the host adds a walk-in with SMS consent and presses Notify; the capture folder has the table-ready text and the entry shows "Text sent".
- **Consent missing:** Notify without consent shows "tell the guest in person" and nothing is captured.
- **Every existing spec** still passes, in CI mode and once against the dev server.

## 8. Documentation

- **README sections 3, 4, 9, 13, 21, 22, 23 and 39:** the policies as built.
- **README section 33:** a "Phase 22 Online Reservations and Guest Messaging" note.
- **Section 36 and the CLAUDE.md phase list:** Phase 22, plus the notifications line and a short messaging and online booking policy in CLAUDE.md.
- **Phase 6 and Phase 21 plans:** amendments noting the superseded messaging lines.
- **`docs/User-Guide.md`:** online booking settings, the guest's booking and manage pages, consent at the host stand, message history, the waitlist text.
- **`docs/Cloud-Deployment-Guide.md`:** the messaging settings and secrets a deployment would need. It stays a guide only, with no deployment.
- **`.env.example`:** the new variables.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first), and once against `npm run dev`
- [ ] `npm run build`, with no `node:crypto` Edge Runtime warning
- [ ] `npm audit --omit=dev` clean after adding `nodemailer`
- [ ] Migrations generated, reviewed and committed; `npm run db:generate` then reports no changes
- [ ] Migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants; `db:seed:validation` and `db:seed:demo` twice create no duplicates
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] The canonical Bacon Cheeseburger test passes unchanged
- [ ] No provider call while a transaction is open
- [ ] No address, body, token or credential in audit rows, logs or outbox payloads
- [ ] No message queued without consent; none sent to a suppressed address

## 10. Required Phase 22 Completion Report

Write `docs/Phase-22-Completion-Report.md`:

```text
PHASE 22 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL / nodemailer

Policies (as built)
- Messaging infrastructure (port, adapters, message outbox, dispatcher, suppressions):
- Consent:
- Online booking (settings, slots, booking, throttling, manage link, page):
- Messages from staff actions (reservations, reminders, waitlist, history):
- Erase, retention, permissions, audit and boundaries:
- Phase 21 leftovers:

Results
- Messages queued only on commit and sent only after it: PASS / FAIL
- No message without consent; none to a suppressed address: PASS / FAIL
- Online booking can't exceed pacing under concurrency: PASS / FAIL
- Idempotent booking retry creates one booking and one message: PASS / FAIL
- Manage token stored hashed, never logged: PASS / FAIL
- Erase clears messaging personal data and keeps history: PASS / FAIL
- No contact data, bodies or tokens in audit, logs or outbox: PASS / FAIL
- Edge Runtime warning gone: PASS / FAIL
- Canonical Bacon Cheeseburger unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e CI and dev, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
