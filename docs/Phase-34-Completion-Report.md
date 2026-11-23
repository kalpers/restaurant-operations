# Phase 34 Completion Report: Unclaimed Property, Card Stock and Wider Erase Search

## Summary

Phase 34 follows up on risks recorded in the Phase 33 report. The owner approved decisions D1–D17 on 2026-11-19, along with amendments A1–A10 in the execution plan.

1. **Gift card purchaser details and unclaimed property.**
   - A card can carry optional purchaser details, entered when it is sold.
   - The Exports page has a holder report: the unused balances with the selling location's address and the purchaser's details.
   - A manager can report a card as unclaimed. This posts an `ESCHEATED` entry for the whole balance, deactivates the card and writes a balanced journal line.
2. **Supplier card stock.** Boxes of supplier-printed cards can be registered as `STOCK` before they are sold, up to 1,000 per batch, all or nothing.
   - A cashier sells one by typing its code.
   - An optional setting refuses supplier codes that weren't registered.
   - Unsold stock is deactivated, never deleted.
3. **Wider erase search.** A guest erase now searches every free-text field staff type in, not only the manager log and pre-shift notes:
   - the guest's own visits and other parties' notes and special requests;
   - takeout names;
   - order item instructions, with their kitchen copies;
   - shift and assignment notes;
   - gift card purchaser details.

   In those fields only the guest's words become `[redacted]`, and each change is recorded in append-only `free_text_redactions`. Sent instructions and closed takeout names are frozen by triggers, so the owner approved an exception (D13): the triggers accept only a `[redacted]` substitution with a matching record written in the same transaction.
4. **Points and voids (D2).** This is documented only, with no code change: voids, comps and discounts never reverse loyalty points, and a refunded check's redeemed reward stays spent.
5. **Dev-mode E2E (D15).** Dev-mode E2E is fixed: three dev-server runs in a row had no hard failures.
6. **Empty-database demo run (D16).** D16 was run on the dev database with the new pizza restaurant demo, which replaced the burger demo by owner decision.

**Every check passes:**
- lint and typecheck;
- unit tests: 1039;
- integration tests: 1585;
- E2E in CI mode: 189 plus 1 flaky;
- three dev-mode E2E runs with no hard failures;
- build;
- the production audit;
- migration rebuild and upgrade tests;
- seeding twice: the foundation seed and the demo seed, the demo from an empty database.

The phase is committed in f746614, cc7a765 and 8cde0d1, and CI is green. This report and two older test fixes are not yet committed.

## Environment

- Node 26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker Compose)
- Windows 11; tests run in PowerShell

## Policies (as built)

**Purchaser details, holder report and unclaimed reporting (D3–D6)**
- **Purchaser details** (`gift_card_purchasers`, one row per card):
  - optional name, email, phone and postal address (two lines, city, region, postal code, country);
  - entered at sale with `gift-cards.sell`. Only a new card takes them (`PURCHASER_NEW_CARD_ONLY`), and a reload doesn't change them.
- **Reading and changing** need permission 162, `gift-cards.purchaser.view` (Owner and General Manager, seed `security.gift-card-purchaser-permissions`). Changing also needs `gift-cards.manage`.
  - `PUT /api/gift-cards/{id}/purchaser` changes the details and `POST …/purchaser/clear` clears them.
  - Cleared details are gone for good. A check constraint keeps every field empty once `cleared_at` is set, and the guard trigger refuses any later write.
- **Never exposed:**
  - Purchaser details are never in audit values, logs, outbox or idempotency records, and are never used for messages.
  - `settlements.gift-card-purchaser-changed` names fields only.
  - A run of 13 or more digits is refused in every field (`CARD_DATA_REFUSED`, and a database check).
- **Holder report** (amendment 2):
  - export kind `unclaimed` on the Exports page. It needs `reports.view`, `reports.export`, `reports.settlements` and `gift-cards.purchaser.view`;
  - it covers the unused balances as of one date, organization-wide;
  - columns: card number, first sold date, selling location and its address, last activity, balance, and the purchaser's details or `UNKNOWN`;
  - it is audited as `reports.exported`. It is filing material, not a state's form.
- **Report as unclaimed** (`POST /api/gift-cards/{id}/unclaimed`, `gift-cards.manage`):
  - It records the state (two letters), a filing reference (1 to 60 characters, never 13+ digits) and a report date on `gift_card_escheatments`, one per card.
  - The ledger gets an `ESCHEATED` entry for the whole balance, at the actor's location and business date (amendment 10).
  - The card becomes `INACTIVE`, "Reported as unclaimed". The escheatment row is append-only, and the action is never undone.
  - Refusals: `GIFT_CARD_NOT_SOLD` (stock), `GIFT_CARD_NO_BALANCE`, `GIFT_CARD_SETTLEMENT_OPEN`, `GIFT_CARD_ALREADY_REPORTED`, `INVALID_STATE`, `FILING_REFERENCE_REQUIRED`, `INVALID_REPORT_DATE`.
  - The sales journal posts Dr `GIFT_CARD/ESCHEATED`, Cr `UNCLAIMED_PROPERTY/PAYABLE` (a new line type), and each date still balances.
  - The audit action is `settlements.gift-card-reported-unclaimed`, with no codes.

**Card stock and the stock setting (D7–D10, amendments 1 and 9)**
- **Stock status:**
  - `gift_cards.status = 'STOCK'` exactly when `issued_at` is null. `issued_location_id`, `issued_by_user_id` and `issued_at` are nullable.
  - The guard trigger lets them go from null to set once, at the sale.
  - A stock card has a zero balance, a `GC-` number from registration and an optional printed serial (never 13+ digits).
- **Batches** (`gift_card_stock_batches`, append-only): a `GCB-` number, a description, the receiving location and the count.
  - `POST /api/gift-cards/stock` (`gift-cards.manage`) takes pasted codes, or `serial,code` lines, or a CSV file the browser reads. The file is never uploaded or stored.
  - Codes follow the Phase 33 supplier code rules.
  - A batch holds at most 1,000 cards and is all or nothing. Errors give line numbers only (`STOCK_LIST_INVALID` with `INVALID_CODE`, `INVALID_SERIAL`, `LOOKS_LIKE_CARD_NUMBER`, `DUPLICATE_IN_BATCH`, `GIFT_CARD_CODE_IN_USE`; `STOCK_LIST_EMPTY`, `STOCK_LIST_TOO_LONG`).
  - A batch is idempotent under its key. The response gives counts and last fours only, and codes are kept only as each card's hash and last four.
- **Sale from stock:** typing a stock card's code at sale sells that card. The audit row gains `fromStock`.
  - Lookup, payment, reload, adjustment, cash-out and unclaimed reports refuse unsold stock with `GIFT_CARD_NOT_SOLD`.
  - Manager lists, outstanding counts and card counts leave stock out.
- **`supplier_stock_required`** (program setting, off by default, `gift-cards.manage`, audited as `supplierStockRequired`) refuses a supplier code that isn't registered stock, at sale and at code replacement (`SUPPLIER_CODE_NOT_IN_STOCK`). Generated codes are unaffected.
  - If a stock card's code is used for a replacement, that stock card is retired.
- **Deactivation:** `POST /api/gift-cards/stock/{batchId}/deactivate` deactivates one card or a batch's remainder.
  - A reason is required, and nothing is deleted.
  - The audit action is `settlements.gift-card-stock-deactivated`.
  - The "Card stock" panel on Gift cards lists batches with sold, in-stock and deactivated counts.

**Wider erase search, word-level redaction and the freeze exception (D11–D14, amendments 3–8)**
- **What it searches:** the erase workflow (`src/workflows/erase-guest/`) now searches these kinds, each in its owning module's `services/erase-text.ts`:
  - `PARTY_REQUEST`, `RESERVATION_NOTE`, `WAITLIST_NOTE` (Reservations);
  - `SESSION_NOTE` (Restaurant);
  - `TAKEOUT_NAME` and `ORDER_ITEM_INSTRUCTION` (Orders, with the kitchen ticket copies from Kitchen);
  - `SHIFT_NOTE` and `ASSIGNMENT_NOTE` (Scheduling);
  - `GIFT_CARD_PURCHASER` (Settlements).

  These are in addition to the Phase 33 log entries and pre-shift notes.
- **Where it searches:** each kind is searched at the locations where the eraser holds its view permission (`reservations.view`, `waitlist.view`, `restaurant.view`, `orders.view`, `schedule.view`). Purchasers are searched organization-wide with `gift-cards.purchaser.view`.
  - `guests.erase` is the redaction right.
  - The dialog counts what wasn't searched.
- **Matching:** uses the Phase 33 rules: whole words, name parts of 4 or more letters, full emails, and the last 7 phone digits. Phone digits may be split by spaces or dashes. The shared scanner is in `src/shared/text/free-text-search.ts`.
- **Redaction:** only the matching words become `[redacted]`, and the case of the text around them is kept.
  - A purchaser match clears the whole purchaser row.
  - Log entries and pre-shift notes are still emptied, as in Phase 33.
  - The guest's own reservation, waitlist and table session notes are cleared outright.
- **Inside the transaction:**
  - the matches are worked out again;
  - a ticked `{ kind, id }` that isn't one of them refuses the whole erase with `MENTION_NOT_MATCHED`;
  - each change writes one `free_text_redactions` row (table, row, column, reason, who, when, never the text), only through Auditing's `recordFreeTextRedaction`. The table is append-only by trigger;
  - the erase audit row gains `textRedacted` and `ownNotesCleared` counts.
- **The freeze exception** (migration 0079):
  - `is_text_redaction(old, new)` accepts a change only when the new text holds at least one `[redacted]`, differs from the old, and the old text matches the new text's other pieces in order with something in each gap.
  - `text_unchanged_or_redacted` also requires a `free_text_redactions` row for that table, row and column in the same transaction.
  - `order_items_freeze`, `kitchen_ticket_items_guard` and `orders_settlement_guard` use it for:
    - a sent item's `special_instructions` and `kitchen_instructions_snapshot`, in every status;
    - the kitchen ticket's copy;
    - a closed takeout check's `customer_name`.
  - Every other snapshot stays frozen: price, modifiers, recipe, consumption, tax, category and allergens.
- **Shift and assignment notes** (amendment 5) have no trigger. Scheduling redacts them at any period status, bumps only that row's version and sends no notification.

**Point reversals (D2):** documented in README section 13 and CLAUDE.md. Voids, comps and discounts never reverse points:
- points are earned only when the session ends;
- a session can't end with an OPEN check;
- a CLOSED check can't be voided, comped or discounted;
- voids, comps and discounts made before close already lower the subtotal that earns.

A refunded check's redeemed reward stays spent. No code changed.

**Dev-mode E2E (D15)**
- **Causes fixed:**
  - `disableGuestsAccounts` disabled every guests-domain account, which signed out spec files running in parallel. It now takes the spec's own setup.
  - Under `next dev`, the menu item page shows before it hydrates, so a price typed then was lost. The price step in `menu.spec.ts` now retries until the price is current.
  - The live floor board refresh could reset the "Move or combine" panel mid-step. The combine step in `restaurant.spec.ts` now retries until the extra table shows as occupied.
- **Limits:**
  - The default per-test timeout under `next dev` stays at 60 s, and no retry loop waits more than 60 s. Specs that already set their own budget for long multi-page flows keep it: up to 180 s, and 240 s for the whole-day spec.
  - Dev-mode retries (2) and the 60 s timeout were added in be2f921. CI is unchanged: 30 s, with retries as before.
- **Results:** three dev runs in a row with no hard failures:

| Run | Passed | Flaky | Failed |
|---|---|---|---|
| 1 | 188 | 2 | 0 |
| 2 | 189 | 1 | 0 |
| 3 | 189 | 1 | 0 |

- **Flaky tests left:**
  - `restaurant-day.spec.ts` "a full restaurant day" is the only flaky test in runs 2 and 3, and it is the same one each time. Every failed try used up the spec's whole 240 s budget at a different step; no assertion found a wrong value:
    - run 2, first try: `/cash-drawers` was still compiling;
    - run 3, first and second tries: the table hadn't yet shown "Dirty".

    It passed on retry 1 in run 2 and on retry 2 in run 3. The whole-day flow sits close to its budget under `next dev`, and splitting it or raising its budget is a choice for the owner. CI mode is unaffected.

**Empty-database demo run (D16)**
- The owner decided (2026-11-22) not to repair the old burger demo, whose first D16 attempt failed at a gift card redemption for lack of fries stock. A pizza restaurant demo replaced it under the same `db:seed:demo` command:
  - one location with 6% sales tax on top;
  - a full bar;
  - the burger items kept through `seedDemoKitchen`, so `db:seed:validation` and the canonical test are unchanged;
  - every feature, including Phase 34's stock batch, purchaser details, an unclaimed card and erase mentions;
  - six weeks of history. It is described in `docs/Demo-Data.md`.
- On the dev database, with the owner present, on 2026-11-22:
  - `db:reset`, `db:migrate` and `db:seed`;
  - the owner ran `bootstrap:owner`;
  - `db:seed:demo` run 1 took about 28 minutes: 1080 closed checks, tax at 6.00%, ledger equal to balances, no open shift slots;
  - run 2 added nothing.
- A rerun fix was needed: the menu step's clock is the later of setup + 1 hour and the latest recipe's `effective_from` + 1 minute.

## Results

- Codes and purchaser details never appear in audit, logs, outbox or idempotency responses: **PASS** (`gift-card-stock-unclaimed.test.ts` checks the stored hashes, the batch's idempotency record and the audit rows of stock, purchaser and unclaimed actions). None of these actions writes an outbox event; logs carry IDs only.
- Stock registration is all or nothing and idempotent: **PASS**. A batch with one bad line adds nothing and reports only its line number; a retry with the same key adds nothing.
- An unclaimed report zeroes the balance once and the journal balances: **PASS**. There is one `ESCHEATED` entry, the card becomes inactive, a second report is refused, and the date's journal balances (integration and `sales-journal.test.ts`).
- Erase redacts only confirmed words, in the same transaction, and other snapshot fields stay frozen: **PASS** (`erase-free-text.test.ts`, `migrations.test.ts`, E2E `erase-free-text.spec.ts`). The tests show:
  - a sent item's instruction and its kitchen copy are redacted;
  - a `[redacted]` edit made without its record is refused by the triggers (`DB:orders_closed_frozen` and the item freeze), and the existing freeze tests still refuse other edits;
  - a crafted ID refuses the whole erase.
- Every route enforces its permission and the location header: **PASS**. Each service checks its own permission (integration tests), and the new routes use `requireApiActor`, whose header check is covered by `location-header.test.ts`.
- Canonical Bacon Cheeseburger and idempotent retry unchanged: **PASS**. The canonical tests run unchanged in the integration suite.

## Architectural decisions

- **Each module finds and redacts its own text** (amendment 7). `erase-text.ts` in Reservations, Restaurant, Orders, Kitchen and Scheduling, and the purchaser service in Settlements, return candidates and apply redactions. `erase-guest` orchestrates them, and only Auditing writes `free_text_redactions`.
- **The freeze exception is enforced in the database**, not only in the service. A redaction must match the substitution check and have its record in the same transaction, so a service bug can't change frozen text any other way.
- **Escheatment is a ledger entry plus a record.** Value leaves through `gift_card_entries` like every other movement; `gift_card_escheatments` holds only the filing facts.
- **The new demo is a replacement**, not a second command. The burger kitchen is shared with the validation fixture.

## Migrations

- `0078_phase_34_card_stock_unclaimed_redactions.sql` (generated, reviewed):
  - new tables `gift_card_purchasers`, `gift_card_escheatments`, `gift_card_stock_batches` and `free_text_redactions`;
  - on `gift_cards`: status `STOCK`, nullable `issued_*` with the stock check, `stock_batch_id`, `printed_serial`;
  - ledger kind `ESCHEATED` with its sign and reason checks;
  - `gift_card_programs.supplier_stock_required`.
- `0079_phase_34_guards.sql` (custom):
  - `is_text_redaction`, `free_text_redaction_recorded` and `text_unchanged_or_redacted`;
  - the `free_text_redactions` append-only guard;
  - the redaction exception in `order_items_freeze`, `kitchen_ticket_items_guard` and `orders_settlement_guard`;
  - `gift_cards_guard` for the stock-to-sold step;
  - append-only guards for batches and escheatments;
  - the purchaser guard.

Both are applied to the dev database through the D16 reset. `npm run db:generate` reports "No schema changes".

## Validation results

| Check | Result |
|---|---|
| `npm run lint` | Clean |
| `npm run typecheck` | Clean |
| `npm run test:unit` | 78 files, 1039 passed |
| `npm run test:integration` | 117 files, 1585 passed (see note) |
| `CI=1 npm run test:e2e` (production build) | 189 passed, 1 flaky (guest-profiles allergen save, not this phase), CI green |
| E2E against the dev server | Three runs with no hard failures (table above) |
| `npm run build` | Compiled successfully, 179 pages, no warnings |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run db:generate` | No schema changes |
| Migration reconstruction and upgrade | Pass, including Phase 33 → 34 over existing cards and submitted items |
| `npm run db:seed` twice | No duplicates; 162 permissions |
| `npm run db:seed:demo` from an empty database, twice (D16) | Run 1 complete (1080 closed checks); run 2 added nothing |
| `db:reset` safeguards | Unchanged; their integration tests pass |
| Canonical Bacon Cheeseburger | Pass, unchanged |

**Note on the integration run:**
- The first final run, which ran across midnight into Monday 2026-11-23, passed 1583 of 1585. Neither failure involves Phase 34 code:
  - **The overtime notification test** failed again when run alone, because it used the calendar date where the app uses the business date (before the 4:00 AM cutoff they differ).
  - **The void test's status-history check** passed when run alone; its query had no order.
- Both were fixed in the tests only. The next full run passed all 1585.

## Tests executed

- **Unit:** 9 new tests (1030 → 1039):
  - `gift-card-stock.test.ts` (code list parsing);
  - word-level redaction and split phone digits in `guest-mentions.test.ts`;
  - the `ESCHEATED` journal lines in `sales-journal.test.ts`.
- **Integration:** 15 new tests (1570 → 1585):
  - `settlements/gift-card-stock-unclaimed.test.ts` (10): stock, the setting, deactivation, purchasers, the holder report, unclaimed reporting and secrecy;
  - `reservations/erase-free-text.test.ts` (3): every kind, word-level redaction, the freeze exception, scope and crafted IDs;
  - the Phase 33 → 34 upgrade and trigger checks in `migrations.test.ts`;
  - updated seed counts in `foundation-seeds.test.ts` and `seed-framework.test.ts`.
- **E2E:** 3 new tests:
  - `gift-cards.spec.ts`: a stock batch is registered by pasting and sold by its typed code; a card is sold with purchaser details, then the holder report is exported and the card reported as unclaimed;
  - `erase-free-text.spec.ts`: an erase finds the guest in a takeout name and a shift note and redacts both.

## Files changed

- **Schema and migrations:**
  - `src/db/schema/privacy.ts` (new), `gift-cards.ts`, `gift-card-entries.ts`, `index.ts`;
  - `drizzle/migrations/0078_*`, `0079_*` and their snapshot and journal.
- **Seeds and demo:**
  - `src/db/seeds/gift-card-purchaser-permissions.ts`, `registry.ts`;
  - `scripts/seed-demo.ts`, `scripts/demo/*`, `src/db/demo/pizza/*`, `docs/Demo-Data.md`;
  - the old burger history scripts were removed.
- **Auth and audit:** `permission-catalog.ts`, `auditing/audit-actions.ts`, `auditing/services/redaction-writer.ts` (new), `auditing/index.ts`.
- **Settlements:**
  - `rules/gift-card-stock.ts`, `services/gift-card-stock-service.ts`, `gift-card-purchaser-service.ts` and `gift-card-unclaimed-service.ts` (new);
  - `gift-card-service.ts`, `gift-card-ledger.ts`, `settlement-validators.ts`.
- **Erase text** (`services/erase-text.ts`, new in each): Reservations, Restaurant, Orders, Kitchen, Scheduling. Also `src/shared/text/free-text-search.ts` (new), and in Reservations `rules/guest-mentions.ts`, `guest-profile-service.ts` and `reservation-validators.ts`.
- **Reporting:** `queries/unclaimed-holder-report.ts` (new), `gift-card-report.ts`, `sales-journal.ts` (query and rule), `export-service.ts`, `report-filters.ts`.
- **Workflow:** `src/workflows/erase-guest/erase-guest.ts`.
- **Routes:**
  - `api/gift-cards/stock`, `stock/[batchId]` and `stock/[batchId]/deactivate`;
  - `api/gift-cards/[cardId]/purchaser` and `purchaser/clear`;
  - `api/gift-cards/[cardId]/unclaimed`;
  - the four erase and erase-mentions routes;
  - `api/reports/exports/[kind]`.
- **UI:** `gift-cards/page.tsx`, `gift-card-workspace.tsx`, `reports/exports/page.tsx`, `export-download.tsx`, `erase-guest-panel.tsx`.
- **Tests:**
  - the new files under Tests executed;
  - `tests/helpers/e2e-erase.ts` (new), `e2e-guests.ts`;
  - `briefing-cleanup.ts`, `gift-card-cleanup.ts`;
  - `menu.spec.ts`, `restaurant.spec.ts`, `guest-profiles.spec.ts`, `loyalty.spec.ts`;
  - `foundation-seeds`, `seed-framework`, `migrations`, `gift-cards`, `auth.test.ts`;
  - two older test bugs found during the final validation run and fixed with this report (not committed yet):
    - `notifications/service-polish-notifications.test.ts`: the overtime test dated its time entries by the calendar date, so it failed between midnight and the 4:00 AM cutoff. It now uses `businessDateOf`;
    - `orders/voids-and-discounts.test.ts`: it read an item's status history with no order. It now orders by `occurred_at`.
- **Docs:** `README.md` (sections 9, 13, 19, 20, 21, 33, 36), `CLAUDE.md`, `docs/User-Guide.md`, `docs/Demo-Data.md`, the plan, and this report.

## Risks

- **The freeze exception loosens a core rule.** It is narrow (only `[redacted]` substitutions with a record in the same transaction, only from the erase) and has its own trigger tests. Still, any change to those triggers must keep the check.
- **Matching is still a suggestion.** Nicknames and misspellings aren't found, and a wrongly ticked mention is redacted for good.
- **Text written before the erase** in outbox payloads and old audit details may still hold instructions or names. They are kept for their retention period and aren't searched.
- **Purchaser details are new personal data.** They are optional and need a permission to read, and they can be cleared; otherwise they are kept while the card exists.
- **The holder report isn't a filing.** Dormancy periods and owner rules differ by state, and the owner checks each state's requirements.
- **Reporting as unclaimed can't be undone.** A mistake needs a manager adjustment on a new card.
- **Supplier codes are stored as an unsalted SHA-256** (unchanged since Phase 33). A short printed code could be guessed from a leaked database.
- **The whole-day E2E test** is close to its 240 s budget under `next dev`, so it can need its retry there. CI mode is well inside the budget.

## Remaining issues

- The manual SMTP and Twilio check (a Phase 22 leftover) is still with the owner.
- This report and the two test fixes are not committed.
- `restaurant-day.spec.ts` stays flaky under `next dev` (see Dev-mode E2E). Splitting it or raising its budget is the owner's choice.

## Next-phase readiness

Phase 34 is complete and validated, apart from the items above. No later phase is scheduled. The candidates are:
- event and private-dining bookings;
- FIFO lot costing, which needs a contract rule changed;
- opening, closing and side-work checklists;
- food-safety temperature logs;
- matching supplier invoices against receipts;
- prix-fixe and combo items.
