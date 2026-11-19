# Phase 32: Manager Log and Pre-Shift Notes Design and Implementation Plan

## Purpose

Owner request, 2026-11-19: managers keep a daily log of what happened at each location, and write pre-shift notes that staff read before service.

Restaurants hand information from shift to shift in a manager log book ("walk-in door sticking, called the repair company", "Table 12 complained about the steak, comped dessert") and brief staff before service ("tonight's special is the halibut, we're out of the rosé, VIP at 8 o'clock"). Today the app has neither. Shift notes exist only on schedule assignments, and those are shown to schedule reviewers only.

Scope answers from the owner (2026-11-19): a **daily log per location and business date** with categories, where entries are never edited or deleted and a correction is a new entry; **pre-shift notes on a page**, optionally aimed at positions, with no read receipts and no alerts; the **log seen by managers only**, and pre-shift notes readable by all staff.

What already exists (reviewed 2026-11-19):

| Area | What is there | Where |
|---|---|---|
| Business date | One `BusinessDateService` (location time zone and cutoff) | `src/shared/time/business-date-service.ts` |
| Location header | Every browser write sends `x-location-id`; a mismatch is 409 `LOCATION_CHANGED` | auth guards, `resolveCurrentLocation` |
| Positions | `positions` and `employee_positions` (work performed, separate from roles) | `src/db/schema/employees.ts` |
| Shift notes | Free text on schedule assignments, shown to schedule reviewers only (Phase 14) | Scheduling |
| Permissions | 155 codes; new codes go through a versioned upgrade seed (`security.*-permissions`) | `src/modules/auth/permission-catalog.ts`, `role-catalog.ts`, `src/db/seeds/` |
| Audit | `audit_events`, categories fixed by a check constraint; action names `^[a-z]+[.][a-z-]+$` | `src/db/schema/auditing.ts`, `src/modules/auditing/audit-actions.ts` |
| Dashboard | Overview and Locations today panels | `src/app/(app)/dashboard/page.tsx` |
| Navigation | Five groups (insights, service, back-of-house, people, admin), each link gated by one permission | `src/components/app-shell/navigation.ts` |

Expected change: five new permissions (155 → 160) and two migrations (0074 generated, 0075 custom guards).

## Decisions for the owner

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D1 | Scope? | **A daily manager log and pre-shift notes, as the owner chose.** Out: follow-ups or tasks on log entries, read receipts, notifications, attachments or photos, comments or replies, entries written by staff, a log report or CSV, and logs compared across locations. | These were the owner's choices. Each item left out is a feature of its own with rules to decide. |
| D2 | Which module owns them? | **Restaurant** (the location's day of service), in new `services/manager-log-service.ts` and `pre-shift-service.ts` with their repositories, queries and validators. No workflow. | The module list is fixed by the contract. Both features belong to a location's service day, which Restaurant already owns. Neither crosses domains beyond reading positions, so neither is a workflow. |
| D3 | The log's shape? | **`manager_log_entries`:** `id`, `organization_id`, `location_id`, `entry_number` (per organization, shown as `LOG-000123`), `business_date DATE`, `category`, `body` (1 to 4000 characters), `author_user_id`, `author_employee_id` (null when the user has no employee), `corrects_entry_id` (null, or an earlier entry at the same location), `created_at`, and the redaction columns from D6. | One row per entry follows the paper log book. A business number lets managers refer to an entry ("see LOG-000412"). |
| D4 | Which business date does an entry get? | **The current business date by default. The writer may choose the previous business date instead, and nothing earlier.** Both come from `BusinessDateService` at the time of writing. `created_at` always records the real instant. | A closing manager often writes after the 4:00 AM cutoff about the night before. Allowing any earlier date would let the log be rewritten after the fact. |
| D5 | Categories? | **A fixed, constrained list:** `SERVICE`, `INCIDENT`, `MAINTENANCE`, `STAFFING`, `GUEST`, `OTHER`. Not configurable. | The conventions prefer configurable tables for categories, but nothing reports on these. A settings screen would add scope with no use yet. This is a deliberate exception; a later phase can move to a table without changing any entry. |
| D6 | Never edited or deleted, but what if an entry holds something it must not? | **Entries are append-only (a database trigger refuses UPDATE and DELETE). A correction is a new entry that names the one it corrects, and the original is shown marked "Corrected by LOG-…". One exception: a holder of `manager-log.redact` (Owner and General Manager) may redact an entry with a reason.** Redaction replaces the body with nothing, sets `redacted_at`, `redacted_by_user_id` and `redaction_reason` (1 to 500 characters), and leaves the category, author, date and number. The trigger allows only that change, once. Redaction is audited (D11). | The log is free text. Managers will sometimes write a guest's phone number, a medical detail or HR information there. Phase 21's erase rule and rule 15 (no unnecessary HR data) need a controlled way to remove it, so "never edited" can't be absolute. A redaction that keeps the entry's place, and says who removed it and why, preserves the log's honesty. |
| D7 | Pre-shift notes' shape? | **`pre_shift_notes`:** `id`, `organization_id`, `location_id`, `business_date`, `title` (1 to 120), `body` (1 to 2000), `pinned` (shown first), `active`, `version`, `created_by_user_id`, `updated_by_user_id`, timestamps. **`pre_shift_note_positions`** (note, position). No rows means everyone. A note is for one business date; a manager may write it for today or a future date (up to 14 days ahead). | Briefings are about a particular service day. Writing ahead covers "Saturday's private party". Position targeting uses the existing positions and changes no role. |
| D8 | Can a note be changed? | **Yes, until its business date has passed:** edit (optimistic concurrency on `version`, mismatch is a conflict) or withdraw (`active = false`, never deleted). After the date, notes are read only. Edits are not audited; the row records who last changed it. | Unlike the log, a note is a plan, and fixing a typo or a changed special is normal. Notes are not a sensitive or money action under the audit decision. |
| D9 | Who sees which notes? | **Holders of `pre-shift.view` see today's active notes aimed at everyone, plus those aimed at a position they hold** (an active `employee_positions` row). Holders of `pre-shift.manage` see every note, past and future, with its positions. Position targeting is only a filter for relevance, not access control, and the screen says so. | Staff want only what concerns them. Everything in a note is fit for all staff, since it's a briefing, so it doesn't need to be protected. |
| D10 | Where do they appear? | **Two new pages and a dashboard panel.** `/manager-log` (service group, `manager-log.view`): one business date at a time with a date picker, category filter, a text search across a range of up to 31 days, and "Add entry". `/pre-shift` (service group, `pre-shift.view`): today's notes for the reader. Managers also get a "Manage notes" view by date. The Dashboard shows a "Pre-shift notes today" panel to `pre-shift.view` holders. All times show in the location's time zone. | Staff look for the briefing when they arrive, and the dashboard is the first page after sign-in. The log is a page managers open on purpose. |
| D11 | Permissions and audit? | **New codes:** `manager-log.view`, `manager-log.write`, `manager-log.redact`, `pre-shift.view`, `pre-shift.manage` (155 → 160), added by the upgrade seed `security.manager-log-permissions`. Grants: Owner and General Manager get all five; Manager gets everything except `manager-log.redact`; every other system role gets `pre-shift.view`. **Audit:** only redaction, as `restaurant.manager-log-redacted`, category `ORGANIZATION`. The row names the entry and the reason's length, never the body. Writing an entry isn't audited, because the entry itself records who wrote it, when and where. | This follows the owner's "managers only" choice. Redaction removes recorded information, so it's the one sensitive action here. No new audit category is needed. |
| D12 | Concurrency, idempotency and events? | **Adding a log entry takes a client idempotency key** (scope `restaurant.manager-log-entry`), so a double-tap or retry adds one entry. Notes use `version`. No outbox events or realtime updates, and no notifications. | A duplicate entry in an append-only log can't be removed, so a retry must not create one. Live updates have no request behind them. |
| D13 | Seeds, leftovers and the rest? | **The demo seed adds a few log entries (including one correction) and pre-shift notes for recent and upcoming dates at MAIN** (idempotent, local dev DB only). The validation fixture is unchanged. No report changes. Guest erase (Phase 21) does not search free text, which is a risk (section 10); redaction is the tool. The Phase 22 manual SMTP/Twilio check stays with the owner. | Demo data shows the feature. Searching free text for guest names would be unreliable and could erase the wrong thing. |

## Approved Phase 32 Policies

Approved by the owner on 2026-11-19: D1–D13 as recommended. These are binding.

1. **Scope (D1).** A daily manager log and pre-shift notes. Follow-ups, read receipts, notifications, attachments, comments, staff-written entries, log reports or CSV and cross-location log views stay out.
2. **Module (D2).** Restaurant owns both (services, repositories, queries, validators); no workflow.
3. **Log entries (D3).** `manager_log_entries` with a per-organization `entry_number` shown as `LOG-000123`, `business_date`, `category`, `body` (1 to 4000), author user and employee (nullable), `corrects_entry_id` (same location), `created_at`, and the redaction columns.
4. **Business date (D4).** The current business date by default, or the previous one by choice, both from `BusinessDateService`; nothing earlier.
5. **Categories (D5).** Fixed constrained list `SERVICE`, `INCIDENT`, `MAINTENANCE`, `STAFFING`, `GUEST`, `OTHER`; not configurable (a deliberate exception).
6. **Append-only with one redaction (D6).** A trigger refuses DELETE and every UPDATE except a single redaction by a `manager-log.redact` holder with a reason (1 to 500): body emptied, `redacted_at`, `redacted_by_user_id`, `redaction_reason` set, nothing else changed. Corrections are new entries naming the original, which is shown "Corrected by LOG-…".
7. **Notes (D7).** `pre_shift_notes` (`business_date`, `title` 1 to 120, `body` 1 to 2000, `pinned`, `active`, `version`, created/updated by user) and `pre_shift_note_positions`; no positions means everyone; dates from today to 14 days ahead.
8. **Note changes (D8).** Edit (optimistic `version`) or withdraw (`active = false`) until the date has passed; then read only; not audited.
9. **Visibility (D9).** `pre-shift.view` holders see today's active notes for everyone plus those for positions they hold; `pre-shift.manage` holders see all notes. Targeting is relevance, not access control.
10. **Pages (D10).** `/manager-log` (service group, `manager-log.view`: date picker, category filter, text search over up to 31 days, Add entry), `/pre-shift` (service group, `pre-shift.view`, with Manage notes for managers), and a "Pre-shift notes today" dashboard panel; location time zone throughout.
11. **Permissions and audit (D11).** `manager-log.view`, `manager-log.write`, `manager-log.redact`, `pre-shift.view`, `pre-shift.manage` (155 → 160) via seed `security.manager-log-permissions`. Owner and GM all five; Manager all but redact; every other system role `pre-shift.view`. Only redaction is audited: `restaurant.manager-log-redacted`, category `ORGANIZATION`, never the body.
12. **Idempotency and events (D12).** Adding a log entry takes an idempotency key (scope `restaurant.manager-log-entry`); notes use `version`; no outbox events, realtime or notifications.
13. **Seeds and leftovers (D13).** The demo seed adds log entries (one correction) and notes at MAIN, idempotent; the validation fixture and reports are unchanged; guest erase doesn't search free text (risk); the SMTP/Twilio check stays with the owner.

## Amendments decided at implementation

Approved by the owner on 2026-11-19 with the execution plan.

1. **Number counter (policy 3).** A fourth table, `manager_log_number_counters` (one row per organization), assigns entry numbers, as `gift_card_number_counters` does for gift cards.
2. **Held positions are per location (policy 9).** A reader holds a position when the employee linked to their user has an active `employee_positions` row for it at the current location.
3. **Manage notes page (policy 10).** The manager view is its own page, `/pre-shift/manage` (`pre-shift.manage`), linked from `/pre-shift`. Navigation gets two links, Manager log and Pre-shift.
4. **Author shown by employee name (policy 3).** Pages show the author's employee name, or "No employee record" when the user has none, never an email.

## 1. Objectives

Managers record what happened each business day, at each location, in a log that can't be rewritten (only corrected, or redacted by a senior manager with a reason). Staff read the day's pre-shift notes that concern them.

## 2. Scope Boundary

In: the two tables (plus note positions), their guards, services, routes and pages; the dashboard panel; the five permissions with their upgrade seed; the redaction audit action; the demo seed; tests and documentation for these.

Out: follow-ups, read receipts, notifications, attachments, comments, staff-written log entries, log reports or CSV, cross-location log views, configurable categories, any change to orders, inventory, settlements, scheduling or reporting; cloud deployment.

## 3. Review Existing Foundation Before Changes

- `src/modules/restaurant/` (service and repository patterns, `access.ts`, location work), and how an existing Restaurant route checks permissions and the location header.
- `BusinessDateService` and how another domain asks it for "today" and "previous" business dates.
- `employee_positions` reads (active rows for a user's employee) without touching HR data.
- `runIdempotent` and an existing idempotency scope; the business number pattern used for gift cards (`GC-000123`).
- The audit action catalog and sanitizer (field names that it refuses).
- A custom guard migration from an earlier phase (for example `0073_gift_card_guards.sql`) for the append-only trigger pattern.
- `navigation.ts`, the dashboard page, and `foundation-seeds`/`seed-framework`/`migrations` tests that count permissions, seed keys and tables.

## 4. Build Order

1. **Migration 0074** (generated, reviewed): the three tables with constraints (category list, body lengths, a redacted entry has an empty body and all three redaction fields, `corrects_entry_id` same organization). Name long foreign keys explicitly.
2. **Migration 0075** (custom): the append-only trigger on `manager_log_entries` (no DELETE; an UPDATE only redacts once and changes nothing else), and a check that a correction names an entry at the same location.
3. **Permissions:** catalog, role grants, upgrade seed, test counts (160).
4. **Manager log:** business date rule (D4), service, repository, queries (by date, range search), routes (list, add with idempotency, correct, redact with audit).
5. **Pre-shift notes:** service (date window, edit, withdraw, version), reader query (everyone + held positions), manager query, routes.
6. **UI:** `/manager-log`, `/pre-shift` with Manage notes, the dashboard panel, navigation links.
7. Demo seed (D13).
8. Tests (sections 5–7), docs (section 8), validation (section 9), completion report.

## 5. Unit Tests

- Business date choice: current or previous only; around the cutoff and across a time-zone boundary.
- Note date window: today through 14 days ahead; editable only until its date has passed.
- Reader filter: everyone-notes plus held-position notes; withdrawn and other dates left out; pinned first.
- Entry number formatting (`LOG-000123`).

## 6. Integration Tests

- Adding an entry stores the right business date, author and number; a retry with the same idempotency key adds nothing; a different key adds a second entry.
- Direct SQL UPDATE or DELETE of an entry is refused by the trigger; a second redaction is refused; a redaction that changes anything but the redaction fields is refused.
- A correction names an earlier entry at the same location; one at another location is refused.
- Redaction empties the body, keeps the rest, writes one audit row with no body text; it is refused without `manager-log.redact`.
- Every route refuses without its permission and with a mismatched location header; `manager-log.view` without `.write` can read but not add.
- Notes: create for today and a future date, refused past 14 days or in the past; edit with a stale version is a conflict; withdraw hides it from readers; edits refused after the date.
- A Server holding the SERVER position sees everyone-notes and SERVER notes, not COOK notes; a manager sees all.
- Seed: `db:seed` twice gives 160 permissions and no duplicate grants; the demo seed twice creates no duplicates.
- The canonical Bacon Cheeseburger passes unchanged.

## 7. E2E Tests (Playwright)

- A manager adds a log entry, corrects it, and sees the "Corrected by" mark; the General Manager redacts an entry with a reason and sees the redacted mark.
- A manager writes a pre-shift note for the SERVER position; a server signs in and sees it on the dashboard and on `/pre-shift`; a cook does not see it.
- A server can't open `/manager-log` (access denied).

## 8. Documentation

- README: section 12 (Restaurant: manager log and pre-shift notes), section 9 (the five permissions), section 20 (the redaction audit action), and Phase 32 entries in sections 33 and 36.
- CLAUDE.md: add Phase 32 to the phase list and a short policy line.
- `docs/User-Guide.md`: writing, correcting and redacting log entries; writing and reading pre-shift notes.
- `docs/Phase-32-Completion-Report.md`.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first); a dev-server run is advisory
- [ ] `npm run build`, with no new warnings
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] Migrations 0074 (generated) and 0075 (custom) reviewed; `npm run db:generate` then reports no changes; migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants (160); `db:seed:validation` and `db:seed:demo` twice create no duplicates
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] Canonical Bacon Cheeseburger, including the idempotent retry, passes unchanged

## 10. Risks

- **Free text can hold personal data (D6, D13).** Guest erase does not scrub the log or notes. Redaction is manual and depends on a senior manager noticing. The add-entry screen reminds writers not to record contact details, health details or HR matters.
- **Redaction is an exception to append-only (D6).** It is limited to Owner and General Manager, happens once, keeps the entry's place and is audited. Even so, a redacted entry's original text is gone for good.
- **Fixed categories (D5)** go against the "prefer configurable tables" convention. Moving to a table later needs a migration, but no entry changes.
- **Position targeting is not access control (D9).** Anyone with `pre-shift.manage` sees every note, and a reader with no position sees only everyone-notes.

## 11. Required Phase 32 Completion Report

Write `docs/Phase-32-Completion-Report.md`:

```text
PHASE 32 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Manager log (business date, categories, append-only, corrections, redaction):
- Pre-shift notes (dates, positions, editing, withdrawal, who sees what):
- Pages and dashboard panel:
- Permissions, audit, idempotency and boundaries:

Results
- Log entries cannot be updated or deleted except one audited redaction: PASS / FAIL
- An idempotent retry adds no second entry: PASS / FAIL
- Staff see only everyone-notes and their positions' notes: PASS / FAIL
- Every route enforces its permission and the location header: PASS / FAIL
- Canonical Bacon Cheeseburger and idempotent retry unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e CI and dev, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
