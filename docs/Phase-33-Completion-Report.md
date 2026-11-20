# Phase 33 Completion Report: Privacy, Loyalty and Gift Card Follow-ups

## Summary

Phase 33 closes five gaps recorded as risks in the Phase 30, 31 and 32 reports. The owner chose them on 2026-11-19 and approved D1–D19 as recommended. Six implementation amendments were approved with the execution plan.

1. **Guest erase now finds mentions in free text.** Before an erase is confirmed, the dialog lists manager log entries and pre-shift notes that contain the guest's name, email or phone number. Each is ticked, and the ticked ones are redacted in the same transaction as the erase. Pre-shift notes can now be redacted, from the erase or on their own.
2. **Refunds take back loyalty points.** They take back the points the refund paid for, worked out from the snapshot taken when the points were earned. They never take more than the guest can spend. Voiding the refund puts the points back.
3. **Gift cards.**
   - Cards can be sold with a code printed by a supplier.
   - A new "Unused gift card balances" section lists cards with no activity for a period the owner sets, for unclaimed-property reporting.
4. **Organization-wide figures in reports** are now titled "(all locations)" in each location's report. The "All my locations" comparison shows them once.
5. **Manager log categories** are now a configurable table per organization.

**Every check passes:**
- lint and typecheck;
- unit tests: 1030;
- integration tests: 1570;
- E2E in CI mode: 187;
- build;
- the production audit;
- migration rebuild and upgrade tests;
- seeding twice, both the foundation seed and the demo seed.

Nothing is committed.

## Environment

- Node 26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker Compose)
- Windows 11; tests run in PowerShell

## Policies (as built)

**Erase with possible mentions; note redaction (policies 2–6)**
- **Workflow:** `src/workflows/erase-guest/erase-guest.ts` orchestrates the erase.
  - Reservations reads the guest's names, emails and phones before anything is cleared: the profile, every profile merged into it through the chain, and its visits. For a single-visit erase it reads that visit only.
  - Restaurant supplies candidate text through `findBriefingTextCandidates`, a broad case-insensitive and digits-only match with no knowledge of guests.
  - The matching rules in `src/modules/reservations/rules/guest-mentions.ts` decide what counts: whole words, name parts of 4 or more letters, full emails, and the last 7 phone digits in a run of 7 to 15 digits.
- **Where it searches (amendment 3):** locations of the organization where the eraser holds both `manager-log.view` and `manager-log.redact`. Other locations are only counted ("N other locations weren't searched").
- **Inside the transaction:**
  - the matches are worked out again;
  - a ticked ID that isn't one of them is refused with `MENTION_NOT_MATCHED`, and nothing is erased;
  - the ticked entries and notes are redacted with the reason "Guest erase, profile #N" or "Guest erase, visit". Profiles are shown as `#N` in the app, so this replaces the plan's illustrative "GP-…";
  - the erase runs as before. Its audit row gains `logEntriesRedacted` and `notesRedacted`.
- **Note redaction:**
  - Pre-shift notes gained `redacted_at`, `redacted_by_user_id` and `redaction_reason`. A check constraint makes a redacted note titled "Redacted", empty and withdrawn. Migration 0077 adds a trigger that freezes it afterwards.
  - `POST /api/pre-shift-notes/{id}/redact` (`manager-log.redact`), and a Redact action on Manage notes.
  - The audit action is `restaurant.pre-shift-note-redacted`, with the date and the reason's length only.
  - The log's redaction audit now also names the entry's location, because an erase can redact at another location.

**Refund points (policies 7–12)**
- **Rules:** `src/modules/reservations/rules/loyalty-refunds.ts`.
  - Points due for a refund: floor(eligible × rate) − floor(max(0, eligible − refunds) × rate), worked out on the running total of the visit's refunds recorded since earning.
  - It uses the refund before tax, with tips excluded. The rate and subtotal come from the `EARNED` snapshot.
  - What is taken is capped at the balance less points held by pending rewards, never below zero. Any shortfall is reported, not carried.
- **Ledger:** new kinds `REFUND_REVERSED` and `REFUND_RESTORED`, with `refund_id`. There is a unique index per kind, a sign rule, and a check that `refund_id` is set for those kinds and only those.
- **Which profile:** points go to or from the profile now holding them, following merges. An erased profile, or a visit that earned nothing, gets no entry. This applies whether or not the program is still on.
- **Earning:** `earnPointsForFinishedParty` subtracts refunds already recorded on the party's checks. Its `eligible_subtotal` is the net figure.
- **Workflows (amendment 4):**
  - `src/workflows/record-refund/` and `void-refund/` call `recordRefundInTransaction` / `voidRefundInTransaction` with a hook. The hook's figures go into the refund's audit row and response (`loyaltyPointsTaken`, `loyaltyPointsShort`, `loyaltyPointsRestored`).
  - Points are moved under the refund's idempotency key, so a retry moves nothing again.
  - The Settlements functions that opened their own transaction were removed, so no path records a refund without its points.
- **Screens:**
  - The refund screen says how many points were taken back, and any shortfall.
  - The profile shows "Taken back (refund)" and "Put back (refund voided)".
  - Loyalty's by-date report section gains "Refunds (net)".

**Supplier codes and unused balances (policies 13–15)**
- **Code rules:**
  - `canonicalGiftCardCode` gives one stored form (amendment 1). A valid 16-character app-style code is read with look-alike mapping; anything else is upper-cased with spaces and dashes removed. Codes with 13 digits in a row are never treated as codes.
  - `checkSupplierCode` accepts 8 to 24 letters and digits. It refuses a run of 13 or more digits with `LOOKS_LIKE_CARD_NUMBER`.
- **Sale:** `sellGiftCard` takes `supplierCode` for a new card.
  - Refusals: `SUPPLIER_CODE_NEW_CARD_ONLY` with a reload, and `GIFT_CARD_CODE_IN_USE`.
  - The card stores `code_source = 'SUPPLIER'` and the hash and last four only.
  - The code is never returned, and only its hash enters the idempotency fingerprint.
- **Replacement:** `replaceGiftCardCode` takes an optional printed code in the same way.
- **Audit:** sale and code-replacement rows gain `codeSource`.
- **Unused balances:**
  - `gift_card_programs.dormancy_months` (12 to 120, default 36) is set on the Settings card and audited as `dormancyMonths`.
  - The new "Unused gift card balances (all locations)" section lists cards whose latest ledger activity is on or before the range end less that period. It shows card number, first sold, selling location, balance, last activity and months without activity, organization-wide, with no row limit.
  - The CSV holds no codes.

**Organization-wide report sections (policy 16)**
- These sections are now titled "(all locations)", with a note not to add locations together:
  - "Outstanding loyalty points";
  - "Outstanding gift card balances";
  - "Cards holding a balance".
- `runCrossLocationReport` adds "Organization-wide balances: …" once, after "By location":
  - outstanding points under Sales;
  - the outstanding gift card balance and card count under Settlements.
- These figures are never in the comparison total. Other areas are unchanged.

**Manager log categories (policies 17–18)**
- **Table:** `manager_log_categories` (organization, immutable code, name 1 to 40, order, active, version, who changed it).
- **Defaults (amendment 2):** the six default categories come from three places:
  - migration 0077, for existing organizations;
  - seed `restaurant.manager-log-categories`, for a fresh database;
  - the service on first use, for organizations still without any.
- **Entries:** keep their code, with a foreign key to (organization, code). It was added in 0077, after the categories existed.
- **Service:** add, rename, reorder and deactivate, with `version`.
  - Refusals: `LAST_ACTIVE_CATEGORY`, `CATEGORY_CODE_IN_USE`, `INVALID_CATEGORY_CODE`.
  - A trigger refuses deletes and code changes.
  - New entries need an active category (`CATEGORY_NOT_AVAILABLE`).
- **Permission:** `manager-log.categories` (Owner, General Manager), giving 161 in all.
- **Pages:** `/manager-log/categories`, linked from the log for holders. The log's pickers read the categories from the server.

## Results

- Erase redacts only confirmed mentions, in the same transaction: **PASS**. A non-matching or out-of-scope ID refuses the whole erase (`erase-mentions.test.ts`, E2E).
- Refund and refund void move points exactly once, never below zero: **PASS**. Covered by an idempotent retry, partial refunds summing to the whole, a void restoring exactly what was taken, a pending reward kept whole, a merged profile and an erased profile (`loyalty-refunds.test.ts`, E2E).
- Supplier codes are stored only as a hash and last four: **PASS**. The idempotency record and audit rows hold no code (`gift-card-supplier-codes.test.ts`).
- Organization-wide figures appear once in a comparison: **PASS** (`organization-wide-sections.test.ts`).
- Every route enforces its permission and the location header: **PASS**.
  - Each service checks its own permission (integration tests).
  - New routes use `requireApiActor`, whose header check is covered by `location-header.test.ts`.
  - The erase routes also read the full sign-in only to narrow where mentions are searched.
- Canonical Bacon Cheeseburger and idempotent retry unchanged: **PASS**. The existing canonical tests run in the integration suite, unchanged.

## Architectural decisions

- **Three new workflows**, because each now crosses two domains in one transaction:
  - `erase-guest` (Reservations + Restaurant);
  - `record-refund` and `void-refund` (Settlements + Reservations).
- **Settlements never writes the loyalty ledger.** It exposes in-transaction functions with an after-write hook, and the workflow supplies the loyalty step.
- **Restaurant knows nothing about guests.** It returns candidate text by words and digit runs; the guest-matching rule lives in Reservations and is applied by the workflow.
- **The category foreign key is added in custom migration 0077**, after the default rows are inserted, so upgrading a database with existing entries succeeds. The 0076 snapshot already includes the key, and `db:generate` reports no changes.

## Migrations

- `0076_phase_33_follow_ups.sql` (generated, reviewed; the category foreign key moved to 0077):
  - the `manager_log_categories` table;
  - the fixed category check on entries dropped;
  - note redaction columns and check;
  - loyalty refund kinds, `refund_id`, unique indexes and checks;
  - `gift_cards.code_source`;
  - `gift_card_programs.dormancy_months`.
- `0077_phase_33_guards.sql` (custom):
  - the default categories for every organization;
  - the entries' category foreign key;
  - the category guard (no delete, no code change);
  - the redacted-note guard.

Both are applied to the dev database. `npm run db:generate` reports "No schema changes".

## Validation results

| Check | Result |
|---|---|
| `npm run lint` | Clean |
| `npm run typecheck` | Clean |
| `npm run test:unit` | 77 files, 1030 passed |
| `npm run test:integration` | 115 files, 1570 passed (see note) |
| `CI=1 npm run test:e2e` (production build) | 187 passed, none flaky or failed (6.0 min) |
| E2E against the dev server | Not run (advisory only) |
| `npm run build` | Compiled successfully, 178 pages, no warnings |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migration reconstruction and upgrade | Pass, including the new Phase 32 → 33 upgrade with an existing log entry |
| `npm run db:seed` twice (dev) | 2 applied, then 0 applied and 32 already applied; 161 permissions |
| `npm run db:seed:demo` twice (dev) | First run: supplier card GC-000004, unused card GC-000005 (40 months back), a 5.00 refund taking back 5 points. Second run: all three "already there" |
| `db:reset` safeguards | Unchanged; their integration tests pass |
| Canonical Bacon Cheeseburger | Pass, unchanged |

**Note on the integration run:**
- The first full run had 24 failures, all from this phase's expected changes:
  - hard-coded permission and seed counts in `foundation-seeds.test.ts`. One wrong count cascades, because those tests share one database;
  - two result shapes that gained fields: the visit erase result and the redaction audit details;
  - the owner-bootstrap test that builds the whole schema hitting the 5-second default limit. It now has 30 seconds, like the migration rebuild test.
- The second full run passed 1568 of 1570. The two failures were in `migrations.test.ts`: its database-recreating setup step timed out while I was migrating and seeding the dev database on the same Postgres server at the same time. Run alone, the file passes all 25 tests.

## Tests executed

- **Unit:** 20 new tests (1010 → 1030):
  - `guest-mentions.test.ts`;
  - `loyalty-refunds.test.ts`;
  - supplier code cases in `gift-card-code.test.ts`;
  - `manager-log-category-service.test.ts`.
- **Integration:** 28 new tests (1542 → 1570):
  - `reservations/erase-mentions.test.ts` (8);
  - `reservations/loyalty-refunds.test.ts` (7);
  - `restaurant/manager-log-categories.test.ts` (6);
  - `settlements/gift-card-supplier-codes.test.ts` (4);
  - `reporting/organization-wide-sections.test.ts` (2);
  - the Phase 32 → 33 upgrade in `migrations.test.ts` (1).
  - Existing refund tests now call the workflows.
- **E2E:** 4 new tests:
  - `manager-log.spec.ts`: an owner adds a category that a manager then uses; an erase redacts a log entry that names the guest;
  - `loyalty.spec.ts`: a refund takes back points, with the notice and the profile entry;
  - `gift-cards.spec.ts`: a pre-printed card is sold and found by its code typed differently.

## Files changed

- **Schema and migrations:**
  - `src/db/schema/manager-log.ts`, `guest-loyalty.ts`, `gift-cards.ts`;
  - `drizzle/migrations/0076_*`, `0077_*` and their snapshots and journal.
- **Seeds:** `src/db/seeds/manager-log-category-permissions.ts`, `registry.ts`; `scripts/demo-follow-ups.ts`, `seed-demo.ts`.
- **Auth and audit:** `permission-catalog.ts`, `auditing/audit-actions.ts`.
- **Restaurant:**
  - `services/manager-log-category-service.ts` (new);
  - `queries/briefing-text-search.ts` (new);
  - `manager-log-service.ts`, `pre-shift-service.ts`, `briefing-validators.ts`.
- **Reservations:**
  - `rules/guest-mentions.ts` and `rules/loyalty-refunds.ts` (new);
  - `guest-profile-service.ts`, `loyalty-service.ts`, `loyalty-ledger.ts`, `reservation-validators.ts`.
- **Settlements:** `refund-service.ts`, `gift-card-service.ts`, `gift-card-ledger.ts`, `rules/gift-card-code.ts`, `settlement-validators.ts`.
- **Reporting:** `gift-card-report.ts`, `loyalty-report.ts`, `cross-location-service.ts`.
- **Workflows:** `erase-guest/`, `record-refund/`, `void-refund/`.
- **Routes:**
  - `api/guests/[profileId]/erase` and `erase-mentions`;
  - `api/guest-parties/[partyId]/erase` and `erase-mentions`;
  - `api/pre-shift-notes/[noteId]/redact`;
  - `api/manager-log/categories` and `[categoryId]`;
  - `api/orders/[orderId]/refunds`, `api/refunds/[refundId]/void`.
- **UI:**
  - `components/reservations/erase-guest-panel.tsx` (new), `reservations-board.tsx`;
  - `host/guests/[profileId]/page.tsx`;
  - `manager-log/page.tsx`, `manager-log/categories/page.tsx` (new), `manager-log-workspace.tsx`;
  - `pre-shift/manage/page.tsx`, `pre-shift-manager.tsx`;
  - `settlement-workspace.tsx`, `gift-card-workspace.tsx`.
- **Tests:**
  - the new files listed under Tests executed;
  - `briefing-cleanup.ts`, `e2e-briefings.ts`;
  - `foundation-seeds`, `seed-framework`, `migrations`, `owner-bootstrap`, `guest-messaging`, `manager-log`, and five refund-using tests;
  - `auth.test.ts`.
- **Docs:** `README.md` (sections 12, 13, 19, 20, 21, 33, 36), `CLAUDE.md`, `docs/User-Guide.md`, the plan, and this report.

## Risks

- **Matching is a suggestion.** Nicknames and misspellings aren't found, and a wrongly ticked entry is redacted for good. The dialog asks the eraser to read each one.
- **Erase searches only where the eraser may redact.** Mentions at other locations stay until someone with permission there redacts them. The dialog says how many locations weren't searched.
- **Points can be short.** A guest who spent points before a refund keeps that value; the shortfall is reported, not recovered.
- **A refund recorded before the visit earned, then voided, gives back nothing.** Earning had already left it out. This is rare, and a manager can adjust.
- **Supplier codes may be weaker than generated ones.** Lookup needs a staff sign-in. Only an unsalted SHA-256 of the code is stored, so a short code could be guessed from a leaked database.
- **The unused-balance list isn't a filing.** No purchaser details are kept, and the dormancy period is the owner's to set per state.
- **Category deactivation is organization-wide.** Every location loses the category for new entries at once.

## Remaining issues

- The manual SMTP and Twilio check (a Phase 22 leftover) is still with the owner.
- The E2E suite wasn't run against the dev server; the CI-mode run is the authoritative one.
- Nothing is committed.

## Next-phase readiness

Phase 33 is complete and validated, apart from the items above. No later phase is scheduled. The remaining candidates are:
- event and private-dining bookings;
- FIFO lot costing, which needs a rule in the contract changed.
