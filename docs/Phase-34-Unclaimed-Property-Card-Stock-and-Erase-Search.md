# Phase 34: Unclaimed Property, Gift Card Stock and Wider Erase Search Design and Implementation Plan

## Purpose

Owner request, 2026-11-19: take on six items left out of Phase 33 (its D1) or left open in its completion report.

1. **Unclaimed-property filing.** "Unused gift card balances" (Phase 33 D15) lists dormant cards, but a filing needs the owner's name and last known address, and the app keeps neither. Nothing records that a balance was reported and paid over to a state.
2. **Batch gift card stock.** A supplier-printed code (Phase 33 D13) can only be typed at the moment of sale. A box of cards can't be registered in advance, so a mistyped code at the till becomes a new card instead of being caught.
3. **Other point reversals.** Refunds take points back (Phase 33 D7). The owner asked whether voids, comps and discounts after earning should too.
4. **Erase search beyond the manager log.** A guest erase (Phase 33 D2) searches the manager log and pre-shift notes only. Other free text can name the guest too: special requests on other visits, reservation, waitlist and table notes, takeout names, order item instructions and kitchen tickets, and schedule notes. The guest's own reservation, waitlist and table notes aren't cleared either.
5. **E2E under `next dev`.** CI mode passes. In dev mode some tests pass only on retry.
6. **Demo seed from scratch.** `db:seed:demo` hasn't been run end to end on an empty database since 241a8af changed drawers and tip pools.

What already exists (reviewed 2026-11-19):

| Area | What is there | Where |
|---|---|---|
| Gift cards | `gift_cards` (`ACTIVE`/`INACTIVE`, `code_source`, `issued_*` not null), `gift_card_sales`, ledger `gift_card_entries` (9 kinds, `balance_after`, trigger-guarded); program has `dormancy_months` | `src/db/schema/gift-cards.ts`, `gift-card-entries.ts`, migration 0073, `gift-card-service.ts`, `gift-card-ledger.ts` |
| Unused balances | Settlements-area report section, organization-wide, CSV without codes | `src/modules/reporting/queries/gift-card-report.ts` |
| Sales journal | `GIFT_CARD/ISSUED`, `GIFT_CARD/CASHED_OUT`, `GIFT_CARD/ADJUSTED`; must balance per date | `src/modules/reporting/rules/sales-journal.ts` |
| Earning | At session end, from CLOSED checks' `subtotal` (already after discounts), less refunds | `loyalty-service.ts` `earnPointsForFinishedParty`, `end-table-session` workflow |
| Session end | Refused while any check is OPEN (`ORDERS_OPEN`, plus a trigger) | `src/workflows/end-table-session/` |
| Erase | `erase-guest` workflow; clears profile, merged profiles, its parties' name/phone/email/special requests, allergies, messaging; redacts ticked log entries and notes | `src/workflows/erase-guest/`, `guest-profile-service.ts` |
| Free text | `guest_parties.special_requests`, `reservations.notes`, `waitlist_entries.notes`, `table_sessions.notes`, `orders.customer_name` (takeout), `order_items.special_instructions` + `kitchen_instructions_snapshot`, `kitchen_ticket_items.kitchen_instructions_snapshot`, `shifts.notes` + `course_or_station_note`, `shift_assignments.notes` | schema files above |
| Freeze rules | `order_items_freeze` (latest in 0069) refuses changes to instructions after SEND; kitchen ticket items frozen (0016, 0027); only DRAFT schedules are editable | migrations, `schedule-service.ts` |
| E2E dev mode | `retries: 2`, test timeout 60 s, expect 15 s, 2 workers, route warm-up | `playwright.config.ts`, `tests/helpers/e2e-warm-up.ts` |

**Correction to the earlier summary.** The dev-mode test timeout is already 60 seconds (be2f921), not 30. Item 5 is about the tests that still fail on their first try under that limit.

**Item 3 has nothing to reverse.** A session can't end while a check is OPEN, points are earned only when it ends, and a CLOSED check can't be voided, comped or discounted. Voids, comps and discounts made before close already lower `subtotal`, which is what earns. The one movement a refund doesn't undo is a **reward redeemed on that check** (D2).

Expected change: one new permission (161 → 162), two migrations (0078 generated, 0079 custom), no new workflow folder (erase-guest grows).

## Decisions for the owner

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D1 | Scope? | **Items 1, 2, 4, 5 and 6, plus D2 for item 3.** Out: an electronic state filing format, paying the state from the app, linking gift card purchasers to guest profiles, event bookings, FIFO costing, cloud deployment. | These are what the owner chose. Item 3 needs no build beyond D2. |
| D2 | Item 3: anything to build? | **No ledger change.** Document in the README and User Guide why voids, comps and discounts can't follow earning. **Leave a refunded check's redeemed reward spent** (the guest keeps the points spent). **Alternative:** a full refund of a check gives back the reward's points (`REDEMPTION_RESTORED`). | The reward lowered what the guest paid, and the refund returns only what was paid, so the value is already settled. Giving the points back would hand out the reward twice. |
| D3 | Purchaser details: what and when? | **Optional, at issue only:** name, email, phone, and a postal address (line 1, line 2, city, region, postal code, country). One row per card in a new `gift_card_purchasers` table (Settlements). Entered by the seller (`gift-cards.sell`) at issue, changed later by `gift-cards.manage`. Reloads don't change it. No consent field and never used for messages. | A filing needs the last known owner. Optional, because many buyers won't give it, and states accept "owner unknown". Kept apart from `gift_cards` so clearing it never touches the card or ledger. |
| D4 | Who sees purchaser details, and how are they kept private? | **New permission `gift-cards.purchaser.view`** (Owner and General Manager; upgrade seed `security.gift-card-purchaser-permissions`, 161 → 162). Never in audit (field names only), logs, outbox, idempotency responses or receipts. Fields refuse 13+ digits in a row. **"Clear purchaser details"** (`gift-cards.manage` + `gift-cards.purchaser.view`) empties the row, audited without values. A guest erase can find and clear it too (D13). | Same tiering as guest contact details (`guests.contact.view`). A guest asking for erasure must be able to have this cleared. |
| D5 | What does the app produce for a filing? | **A "Holder report" CSV from the unused balances section** (`reports.export` + `gift-cards.purchaser.view`): card number, first sold date, selling location and its address, last activity date, balance, and purchaser name and address, or "UNKNOWN" for each missing field. **Not** the NAUPA electronic format or any state's form. The screen says it is the material for a filing, not the filing. | Each state has its own rules, forms and property codes; the owner or a filing service maps the CSV. Building a state format would be a compliance product. |
| D6 | Recording that a balance was reported and paid to a state? | **"Report as unclaimed" on a card** (`gift-cards.manage`): enter the state (two letters), the filing reference and the report date. It posts a new ledger kind `ESCHEATED` (negative, the whole balance, zero after), sets the card `INACTIVE` with reason "Reported as unclaimed", and keeps the filing details on a new `gift_card_escheatments` row (one per card). Refused for a card with a balance on an OPEN settlement. Journal: Dr `GIFT_CARD/ESCHEATED`, Cr `UNCLAIMED_PROPERTY/PAYABLE`. Audited without codes. **Not undoable.** A guest who later claims from the state is outside the app. | After reporting, the balance is no longer owed to the guest. The ledger must show why it went to zero, and the journal must show the liability moved to a payable. |
| D7 | Card stock: shape? | **Register supplier cards as stock before sale.** A new card status `STOCK`: zero balance, a `GC-` number at registration, `issued_*` empty until sold (the checks become "STOCK exactly when not issued"). A new `gift_card_stock_batches` row per registration: `GCB-000012` number, supplier or description, the location receiving it, count, who and when. Each card may carry the **printed serial** (optional, not secret, never 13+ digits). | Stock cards are real cards that just hold nothing yet, so sale, reports and the ledger need no second model. A serial lets staff find a card without its code. |
| D8 | How are codes entered for a batch? | **Paste (one code per line, optionally `serial,code`) or choose a CSV file that the browser reads and sends as a list.** The file is never uploaded or stored. Up to 1,000 codes per batch, same rules as Phase 33 D13. All or nothing: any invalid, repeated or already registered code refuses the batch with its line numbers (never the code). Idempotent with a client key. The response shows counts and last fours only. `gift-cards.manage`. | Codes are bearer secrets: they exist only as hashes once registered. No stored file means nothing for `FileStorageService` to keep. All or nothing makes a retry safe. |
| D9 | What happens at the sale? | **A typed code that matches a `STOCK` card sells that card** (issued, `ACTIVE`, first `ISSUED` entry). New program setting **"Only sell registered supplier cards"** (`supplier_stock_required`, **off by default**, `gift-cards.manage`): when on, a supplier code that isn't registered stock is refused at sale and at code replacement. Generated codes are unaffected. | With the setting on, a mistyped code is caught instead of becoming a new card. Off by default so nothing changes until the owner registers stock. |
| D10 | Lost or returned stock? | **Deactivate unsold stock** one card at a time or a batch's whole remainder (`INACTIVE`, reason required, `gift-cards.manage`); never deleted. Stock cards can't pay, reload, be cashed out, adjusted or reported as unclaimed. A **"Card stock"** panel on the gift card page lists batches with registered, sold and deactivated counts. Reports leave stock out of card counts. | Same rule as every other configurable record. A stolen unsold card holds nothing and can't be sold once deactivated. |
| D11 | Erase: which other free text is searched? | **Possible mentions in:** special requests of other visits; reservation and waitlist notes; table session notes; takeout customer names; order item instructions and the kitchen ticket copies; shift notes and course/station notes; shift assignment notes; gift card purchaser details (D3). **The erased guest's own** reservation, waitlist and table session notes are cleared outright, as their special requests are today. Same matching as Phase 33 D3, same "ticked by default" dialog, grouped by kind. | Covers every free-text field staff type that can hold a guest's name or number. The guest's own visit notes are about them and should have been cleared already. |
| D12 | How is a mention redacted? | **Only the matching words are replaced with `[redacted]`**, not the whole field, so "No onion – Alvarez allergy" becomes "No onion – [redacted] allergy". Each redaction writes a row to a new append-only `free_text_redactions` (table, row, column, erase reference, who, when; never the text). A purchaser match (D3) clears the whole purchaser row. | Emptying a whole kitchen instruction could drop an allergy or prep note from a live ticket. One shared record shows what changed without adding columns to nine tables. |
| D13 | **Contract conflict:** submitted instructions and kitchen tickets are frozen snapshots (rule 7, CLAUDE.md "Submitted order items store immutable ... snapshots"), and published schedules are edited only through swaps. | **Allow one exception: a redaction from the `erase-guest` workflow.** The freeze triggers accept a change to the instruction text only when the new text is the old text with words replaced by `[redacted]` and a matching `free_text_redactions` row is written in the same transaction. Price, modifier, recipe, consumption, tax and allergen snapshots stay fully frozen. A shift note redaction isn't a schedule change: no notification, no version bump on the period. README section 13 and CLAUDE.md say so. **Alternative:** list these mentions but don't redact them. | A guest's right to be erased outweighs keeping a name inside a note that affects no money, stock or kitchen work. The exception is narrow enough to check in a trigger. |
| D14 | Where is searched, and who may redact? | **`guests.erase` is the redaction right.** A kind is searched at each location where the eraser also holds that kind's view permission: `reservations.view` (visits, reservations), `waitlist.view`, `restaurant.view` (table sessions), `orders.view` (orders, items, tickets), `schedule.view` (shifts, assignments); purchasers need `gift-cards.purchaser.view`. Kinds or locations not searched are counted ("3 kinds at 1 location weren't searched"). The server recomputes matches in the transaction and refuses a ticked ID that isn't one (Phase 33 D4). | No new redaction permissions, and nobody redacts text they couldn't read. Recomputing stops a crafted request. |
| D15 | E2E under `next dev`? | **Fix causes, not limits.** Run the dev suite three times, list every test that needs a retry, and fix each cause: a wait on a real signal instead of a fixed pause, routes missing from the warm-up, a click before hydration. **No timeout above today's 60 s.** Done when three dev runs in a row have no hard failures; any flaky test left is named in the report. CI is unchanged and stays the authoritative run. | Raising limits again hides slow pages. Naming what's left keeps it visible. |
| D16 | Demo seed from scratch? | **On the dev database, with the owner present:** `db:reset` → `db:migrate` → `db:seed` → the owner runs `bootstrap:owner` → `db:seed:demo`, then `db:seed:demo` again (adds nothing). Fix whatever fails in the demo scripts. **This replaces today's dev data**; the demo seed rebuilds it, including this phase's new data. | Only a real empty-database run proves the 241a8af fix. `bootstrap:owner` is interactive and never takes a password argument, so the owner has to run it. |
| D17 | Seeds, demo data and tests? | **`db:seed`** adds the permission (162). **The demo seed adds** a stock batch of 10 supplier cards (2 sold, 1 deactivated), purchaser details on one dormant card, one card reported as unclaimed, a takeout name and a shift note that mention a demo guest. The validation fixture is unchanged. The Phase 22 SMTP/Twilio check stays with the owner. | Every new screen has something to show, and erase can be tried on demo data. |

## Approved Phase 34 Policies

Approved by the owner on 2026-11-19: D1–D17 as recommended (D2 without the alternative; D13 with the redaction exception). These are binding.

1. **Scope (D1).** Items 1, 2, 4, 5 and 6, plus D2. Out: an electronic state filing format, paying the state from the app, linking purchasers to guest profiles, event bookings, FIFO costing, deployment.
2. **No point reversal for voids, comps or discounts (D2).** Documented only; a refunded check's redeemed reward stays spent.
3. **Purchaser details (D3).** Optional at issue: name, email, phone, postal address (line 1, line 2, city, region, postal code, country), one `gift_card_purchasers` row per card; entered with `gift-cards.sell`, changed with `gift-cards.manage`; reloads don't change it; never used for messages.
4. **Purchaser privacy (D4).** Permission `gift-cards.purchaser.view` (Owner, GM; seed `security.gift-card-purchaser-permissions`, 161 → 162); never in audit values, logs, outbox, idempotency responses or receipts; 13+ digits refused; "Clear purchaser details" needs `gift-cards.manage` + `gift-cards.purchaser.view`, audited without values; erase can clear it (policy 13).
5. **Holder report (D5).** CSV from the unused balances section (`reports.export` + `gift-cards.purchaser.view`): card number, first sold date, selling location and address, last activity, balance, purchaser name and address or `UNKNOWN`; not a state format.
6. **Report as unclaimed (D6).** `gift-cards.manage`; state, filing reference, report date on `gift_card_escheatments` (one per card); ledger `ESCHEATED` for the whole balance; card `INACTIVE` "Reported as unclaimed"; refused with a balance on an OPEN settlement; journal Dr `GIFT_CARD/ESCHEATED` Cr `UNCLAIMED_PROPERTY/PAYABLE`; audited without codes; never undone.
7. **Card stock (D7).** Status `STOCK` (zero balance, `GC-` number at registration, `issued_*` empty until sold); `gift_card_stock_batches` (`GCB-` number, description, receiving location, count, who, when); optional non-secret printed serial (never 13+ digits).
8. **Batch entry (D8).** Paste or a browser-read CSV, never uploaded or stored; up to 1,000 codes; Phase 33 code rules; all or nothing with line numbers only; idempotent; response gives counts and last fours; `gift-cards.manage`.
9. **Sale from stock (D9).** A code matching `STOCK` sells that card; setting `supplier_stock_required` (off by default, `gift-cards.manage`) refuses unregistered supplier codes at sale and replacement; generated codes unaffected.
10. **Stock deactivation (D10).** One card or a batch's remainder, reason required, never deleted; stock can't pay, reload, cash out, adjust or be reported; "Card stock" panel; stock excluded from card counts.
11. **Erase targets (D11).** Other visits' special requests, reservation and waitlist notes, table session notes, takeout customer names, order item instructions and kitchen ticket copies, shift and course/station notes, shift assignment notes, purchaser details; the erased guest's own reservation, waitlist and session notes cleared outright.
12. **Word-level redaction (D12).** Only matching words become `[redacted]`; each change writes an append-only `free_text_redactions` row without text; a purchaser match clears the whole row.
13. **Freeze exception (D13).** Frozen instruction text may change only by `[redacted]` substitution with a matching `free_text_redactions` row in the same transaction, from `erase-guest` only; every other snapshot stays frozen; a shift note redaction isn't a schedule change (no notification, no period version bump). README and CLAUDE.md amended.
14. **Who and where (D14).** `guests.erase` is the redaction right; each kind is searched where the eraser holds its view permission (`reservations.view`, `waitlist.view`, `restaurant.view`, `orders.view`, `schedule.view`; purchasers `gift-cards.purchaser.view`); unsearched kinds and locations are counted; matches recomputed in the transaction, crafted IDs refused.
15. **Dev E2E (D15).** Fix causes, no timeout above 60 s; done at three dev runs in a row with no hard failures; leftover flaky tests named; CI unchanged.
16. **Empty-database demo run (D16).** `db:reset` → `db:migrate` → `db:seed` → owner's `bootstrap:owner` → `db:seed:demo` twice, on the dev DB with the owner present.
17. **Seeds (D17).** `db:seed` adds the permission (162); demo seed adds a 10-card stock batch (2 sold, 1 deactivated), purchaser details on a dormant card, one card reported as unclaimed, a takeout name and a shift note mentioning a demo guest; validation fixture unchanged; SMTP/Twilio check stays with the owner.

## Amendments decided at implementation

Approved by the owner on 2026-11-19 with the execution plan.

1. **Stock identity (policy 7).** `gift_cards.issued_location_id`, `issued_by_user_id`, `issued_at` are nullable; `status = 'STOCK'` exactly when `issued_at` is null. The guard lets them go from null to set once, at the sale. The selling location is where the card is sold; the receiving location is on the batch.
2. **Holder report (policy 5).** Export kind `unclaimed` (`reports.view`, `reports.export`, `reports.settlements`, `gift-cards.purchaser.view`) on the Exports page, organization-wide, audited as `reports.exported`.
3. **More frozen rows (policy 13).** A CLOSED order's takeout `customer_name` gets the same exception; on order items and kitchen ticket items it applies in every status.
4. **The trigger check (policy 13).** `is_text_redaction(old, new)`: NEW holds at least one `[redacted]`, differs from OLD, and OLD matches NEW's other pieces in order with something in each gap; plus a `free_text_redactions` row for that table, row and column written in the same transaction.
5. **Shift and assignment notes (policy 13).** No trigger; Scheduling redacts at any period status, bumps only the row, sends nothing.
6. **Erase request.** `redactEntryIds`/`redactNoteIds` stay; `redactMentions: [{ kind, id }]` covers `PARTY_REQUEST`, `RESERVATION_NOTE`, `WAITLIST_NOTE`, `SESSION_NOTE`, `TAKEOUT_NAME`, `ORDER_ITEM_INSTRUCTION` (with its kitchen ticket copies), `SHIFT_NOTE`, `ASSIGNMENT_NOTE`, `GIFT_CARD_PURCHASER`.
7. **Ownership.** Each module finds and redacts its own text; `free_text_redactions` is written only through Auditing's `recordFreeTextRedaction`; `erase-guest` orchestrates.
8. **Search scope (policy 14).** Per kind, the locations where its view permission is held (the Phase 33 pair for the log and notes); purchasers organization-wide with `gift-cards.purchaser.view`; the preview reports what wasn't searched.
9. **Stock at the till (policy 9).** Lookup, payment or reload of a STOCK card is refused as `GIFT_CARD_NOT_SOLD`; manager lists and outstanding counts leave stock out.
10. **Unclaimed posting (policy 6).** `ESCHEATED` at the actor's location and business date; journal Dr `GIFT_CARD/ESCHEATED`, Cr `UNCLAIMED_PROPERTY/PAYABLE` (new line type).

## 1. Objectives

Dormant gift card balances can be filed with the owner's details and recorded as paid to a state. Supplier card stock can be registered before sale, and mistyped codes caught. An erase finds and redacts the guest's name and number wherever staff typed them. Dev-mode E2E runs pass on their first try, and the demo seed is proven on an empty database.

## 2. Scope Boundary

In: purchaser details, the holder report CSV, unclaimed reporting with its ledger and journal lines; stock batches, stock status, the stock setting and stock deactivation; the wider erase search with word-level redaction and the freeze exception; the dev E2E fixes; the empty-database demo run; the permission, migrations, seeds, tests and documentation for these.

Out: everything listed as out in D1; any change to how points are earned or redeemed (unless D2's alternative is chosen); any change to gift card value rules besides `ESCHEATED`; search of free text that can't hold a guest's name (inventory, recipe and menu notes).

## 3. Review Existing Foundation Before Changes

- `gift-card-service.ts` (sale, reload, code replacement, status change, cash-out), `gift-card-ledger.ts` (`findGiftCardIdByCode`, posting under a row lock), migration 0073's ledger trigger, and the sale and card screens.
- `gift-card-report.ts` unused balances, `sales-journal.ts` line codes and its balance test.
- `erase-guest` workflow, the Phase 33 mention matcher, the erase dialog and `eraseGuestProfileInTransaction`.
- `order_items_freeze` (latest definition, 0069), the kitchen ticket item freeze (0016, 0027), `schedule-service.ts` edit rules, and tests that assert those freezes.
- `permission-catalog.ts`, `role-catalog.ts`, upgrade seeds, and `foundation-seeds.test.ts`'s hard-coded counts (bump every one).
- `playwright.config.ts`, `tests/helpers/e2e-warm-up.ts`, `tests/helpers/e2e-ui.ts`, and the demo scripts in `scripts/`.

## 4. Build Order

1. **Migration 0078** (generated, reviewed): `gift_card_purchasers`, `gift_card_escheatments`, `gift_card_stock_batches`, `free_text_redactions`; `gift_cards` status `STOCK`, nullable `issued_*` with the stock check, `stock_batch_id`, `printed_serial`; ledger kind `ESCHEATED`; program `supplier_stock_required`.
2. **Migration 0079** (custom): ledger trigger accepts `ESCHEATED`; the freeze exception (D13) in `order_items_freeze` and the kitchen ticket item trigger; `free_text_redactions` append-only guard.
3. **Permission** (D4): catalog, grants, upgrade seed, counts (162).
4. **Card stock** (D7–D10): code list rules (pure), batch registration, sale from stock, the setting, deactivation, stock panel.
5. **Purchaser details** (D3–D4): sale inputs, card view, change and clear.
6. **Unclaimed** (D5–D6): holder report CSV, "Report as unclaimed", `ESCHEATED` entries, journal lines.
7. **Erase search** (D11–D14): finders per kind (each in its owning module), word-level redaction (pure), the workflow and dialog changes, clearing the guest's own visit notes.
8. **Documentation for D2.**
9. **E2E dev runs** (D15) and fixes.
10. Seeds and demo data (D17), tests (sections 5–7), docs (section 8), the empty-database demo run (D16), validation (section 9), completion report.

## 5. Unit Tests

- Code list parsing: `serial,code` and bare codes, blank lines, repeats within a batch, the 1,000 limit, errors that give line numbers and never codes.
- Word-level redaction: whole-word matches only, case kept around the match, several matches in one field, phone digits split by spaces or dashes, the result passes the freeze check and other text doesn't.
- Holder report rows: "UNKNOWN" for each missing field, selling location address.
- Journal: an `ESCHEATED` entry balances `GIFT_CARD/ESCHEATED` against `UNCLAIMED_PROPERTY/PAYABLE`.

## 6. Integration Tests

- Stock: a batch registers all or nothing and stores no codes; a retry with the same key adds nothing; selling a stock code activates that card; with the setting on, an unregistered supplier code is refused at sale and replacement; deactivated stock can't be sold; stock is left out of card counts; codes never appear in audit, logs, outbox or idempotency responses.
- Purchaser: entered at issue, hidden without `gift-cards.purchaser.view` (API and CSV), changed and cleared by `gift-cards.manage`, never in audit values; 13+ digits refused.
- Unclaimed: the balance goes to zero with one `ESCHEATED` entry and the card becomes inactive; refused on a card with an OPEN settlement balance or on stock; can't be done twice; the journal still balances for that date.
- Erase: finds a guest in each kind, redacts only ticked ones and only the matching words; a submitted item's instruction and its kitchen ticket copy are redacted while prices, modifiers and consumption stay frozen; a non-redaction change to them is still refused; a published shift note is redacted with no notification; kinds without the view permission aren't searched; a crafted ID is refused and nothing is erased; the guest's own reservation, waitlist and session notes are cleared; one `free_text_redactions` row per change, no text in audit.
- Seed: `db:seed` twice gives 162 permissions and no duplicates; the demo seed twice adds nothing new.
- The canonical Bacon Cheeseburger, including the idempotent retry, passes unchanged.

## 7. E2E Tests (Playwright)

- The General Manager registers a stock batch by pasting codes, and a cashier sells one of them by typing its code.
- A cashier sells a card with purchaser details; the General Manager exports the holder report and reports the card as unclaimed.
- The General Manager erases a guest named in a takeout order and a shift note, sees both under possible mentions, confirms, and sees `[redacted]` in each.

## 8. Documentation

- README: section 13 (wider erase search, the freeze exception, why voids and discounts don't reverse points), section 19 (stock, purchaser details, holder report, unclaimed reporting), section 21 (holder report), section 9 (the permission), section 20 (new audit actions), the journal line codes, Phase 34 entries in sections 33 and 36.
- CLAUDE.md: Phase 34 in the phase list; the Guests, Loyalty, Gift cards and Orders policy lines updated, including the rule 7 exception.
- `docs/User-Guide.md`: registering card stock, purchaser details, the holder report and reporting as unclaimed, the wider erase dialog.
- `docs/Phase-34-Completion-Report.md`.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first), and three dev-mode runs (D15)
- [ ] `npm run build`, with no new warnings
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] Migrations 0078 (generated) and 0079 (custom) reviewed; `npm run db:generate` then reports no changes; migration reconstruction and upgrade tests pass, including an upgrade over a database with existing cards and submitted items
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants (162); `db:seed:validation` and `db:seed:demo` twice create no duplicates
- [ ] The empty-database demo run (D16) completes
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] Canonical Bacon Cheeseburger, including the idempotent retry, passes unchanged

## 10. Risks

- **The freeze exception (D13)** loosens a core rule. The trigger check must accept only `[redacted]` substitutions; a bug there would let other edits through, so it gets its own tests.
- **Matching is still a suggestion.** Nicknames and misspellings aren't found, and a wrongly ticked mention is redacted for good.
- **Outbox payloads and old audit details** written before the erase may still hold instruction text. They're kept for their retention period and aren't searched.
- **Purchaser details are new personal data.** They're optional, need a permission to read and can be cleared, but they're kept while the card exists.
- **The holder report isn't a filing (D5),** and dormancy periods and owner rules differ by state. The owner checks each state's requirements.
- **Reporting as unclaimed can't be undone (D6).** A mistaken report needs a manager adjustment on a new card.
- **The empty-database run (D16) replaces the dev data.**

## 11. Required Phase 34 Completion Report

Write `docs/Phase-34-Completion-Report.md`:

```text
PHASE 34 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Purchaser details, holder report and unclaimed reporting:
- Card stock and the stock setting:
- Wider erase search, word-level redaction and the freeze exception:
- Point reversals (D2):
- Dev-mode E2E:
- Empty-database demo run:

Results
- Codes and purchaser details never appear in audit, logs, outbox or idempotency responses: PASS / FAIL
- Stock registration is all or nothing and idempotent: PASS / FAIL
- An unclaimed report zeroes the balance once and the journal balances: PASS / FAIL
- Erase redacts only confirmed words, in the same transaction; other snapshot fields stay frozen: PASS / FAIL
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
