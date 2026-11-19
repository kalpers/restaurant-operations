# Phase 31: Gift Card Balances Design and Implementation Plan

## Purpose

Owner request, 2026-11-19: the restaurant sells its own gift cards, and the app keeps each card's balance so staff can take a card as payment, see what is left on it and stop it being spent twice.

Today `GIFT_CARD` is only a label on a recorded tender (Phase 11). Nothing checks or reduces a balance, so a card can be spent any number of times and nobody can say how much the restaurant owes on cards it has sold. This phase changes a rule in the contract: README section 19 says the application **"does not authorize or process … gift-card balances"**, and the Phase 11 plan (policy 2) says **"Do not process … gift-card balances."** Approving this plan lifts that rule for **the restaurant's own cards only**. Settlement stays record only: nothing charges a card, contacts a provider or processes a payment, and no payment SDK is installed.

What already exists (reviewed 2026-11-19):

| Area | What is there | Where |
|---|---|---|
| Gift card tender | `GIFT_CARD` tender type with `settlements.tender.gift-card` (Server, Bartender, managers). No tips. Free-text `external_reference` only | `src/db/schema/settlements.ts`, `settlements/services/settlement-service.ts` (`recordTender`) |
| Tender void and cancel | A RECORDED tender is voided only while its settlement is OPEN; a settlement is cancelled only once no RECORDED tender is left | `settlement-service.ts` (`voidTender`, `cancelSettlement`) |
| Refunds | `order_refunds` on CLOSED orders, any tender type including `GIFT_CARD`, record only, voidable | `settlements/services/refund-service.ts` |
| Cash drawers | Sessions with float, paid-in/out, cash tenders and cash refunds; expected cash at close | `src/db/schema/drawers.ts`, `settlements/rules/drawer-math.ts`, `drawer-service.ts` |
| Card safety | No PAN, CVV, track data or PIN column; text fields refuse 13 or more consecutive digits (Zod, service, check constraint) | `settlements.ts` (`NO_PAN`) |
| Sales journal | Phase 28 balanced daily CSV with fixed line codes; tenders are debits as `TENDER/<type>` | `reporting/rules/sales-journal.ts`, `reporting/queries/sales-journal.ts` |
| Ledger pattern | Phase 30 points ledger: append-only entries with `balance_after`, balance row, triggers in a custom migration | `src/db/schema/guest-loyalty.ts`, `drizzle/migrations/0071_guest_loyalty_guards.sql` |
| Hashed secrets | Phase 22 manage links stored only as a SHA-256 hash | `reservation_manage_links` |

Permissions today: 152. Last migration: `0071`.

## Decisions for the owner

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D1 | Scope? | **The restaurant's own gift cards: sell a new card, reload it, look up its balance and history, pay a check with it (in part or in full), put value back when a tender is voided or a refund goes to a card, manager adjustments, cash-out of the balance, deactivate and reactivate a card, replace a lost code, a gift card report and sales journal lines.** Out: payment processing, third-party gift card providers (recorded as `OTHER`), printing cards or barcodes, selling cards online, a guest-facing balance page, e-gift cards by email or SMS, expiry, fees, bonus or promotional cards ("buy $50, get $10"), linking cards to guest profiles, house accounts. | This is what a restaurant needs at the counter. Each item left out needs its own rules: online sales need payment processing, a public balance page needs public endpoint rules, and bonus value needs a rule on when the bonus counts as a discount. |
| D2 | Contract change? | **Lift "no gift-card balances" for cards the restaurant issues itself.** README section 19 becomes: "It does not authorize or process card payments, house-account receivables, or external-provider payments. Since Phase 31 it keeps the balance of the restaurant's own gift cards, record only." CLAUDE.md gets a short Gift cards line. The Phase 11 plan gets a note that Phase 31 supersedes its gift card ban. Rule 15 is unchanged: no PIN, and the card code is never logged or audited. | The balance is the restaurant's own record of what it owes, like the points ledger. No money moves through the app. |
| D3 | Which module owns it? | **Settlements**, beside tenders, refunds and drawers. No new module and no workflow: selling, redeeming, refunding and cashing out all happen inside the Settlements module's own transactions. | Every gift card movement is a tender, a refund or a drawer movement, and all of those already live in Settlements. The module list in CLAUDE.md stays the same. |
| D4 | How is a card sold? | **A gift card sale is its own record (`gift_card_sales`), not an order line.** Staff enter an amount and record how the guest paid: `CASH` (into an OPEN drawer session where the location requires drawers, with received amount and change), `EXTERNAL_CARD` (safe metadata only) or `OTHER` (with a description). Not `GIFT_CARD` or `HOUSE_ACCOUNT`. One sale creates the card (`ISSUED`) or adds to an existing one (`RELOADED`). Amount from 1.00 to the maximum balance, in cents. Idempotent (scope `gift-cards.sell`). **A sale is not revenue: no tax, no tip, not in sales reports, tip pools or forecasts.** | Selling a gift card creates money owed to the guest, not a sale; the sale happens when the card is spent on a check, which is already taxed and counted. Keeping it off orders means no menu item, recipe, kitchen ticket or tax category is involved. |
| D5 | The card code? | **The app makes the code: 16 characters from Crockford base32 in four groups (for example `7KQ2-M9XD-4TPA-W3HR`), about 80 random bits. Only a SHA-256 hash and the last 4 characters are stored.** The full code is shown once when the card is sold, for staff to write on or attach to the card; it never appears again, in audit, logs or outbox events. Each card also has a non-secret number (`GC-000123`) for receipts and lookups by managers. Typing the code (or scanning it with a keyboard scanner) is needed to pay with a card or check its balance. | The code works like cash: whoever holds it can spend it, so it is treated as a secret like the Phase 22 manage link. Letters mean it can never trip the 13-digit card-number rule. Pre-printed card stock with its own numbers would need the codes entered by hand and stored the same way; that is left out (see Risks). |
| D6 | Where can a card be used? | **Anywhere in the organization.** A card sold at one location can be spent at any active location. Every ledger entry records the location and business date where it happened. | Guests expect one card for one restaurant group. The amount owed is the organization's; the report still shows each location's movements. |
| D7 | Ledger? | **`gift_card_entries`, append-only (trigger refuses UPDATE and DELETE), with `balance_after`.** Kinds: `ISSUED`, `RELOADED`, `SALE_VOIDED`, `REDEEMED`, `REDEMPTION_VOIDED`, `REFUNDED`, `REFUND_VOIDED`, `ADJUSTED`, `CASHED_OUT`. Signed `NUMERIC(12,2)` amounts (positive adds). Each row carries card, location, business date, user, and the sale, tender or refund it came from, plus a reason where one is required. `gift_cards.balance` changes with each entry in the same transaction under a row lock; triggers keep `balance_after` equal to the previous entry plus the amount, never below zero, and the card's balance equal to its latest entry. | The Phase 30 pattern (rule 6 for stock): the ledger is the record, the balance is for locking and fast reads, and corrections are new entries. |
| D8 | Settings? | **`gift_card_programs`, one row per organization: `enabled` (off by default) and `max_balance` (default 500.00, at most 10,000.00).** While it is off, a `GIFT_CARD` tender is recorded as it is today. While it is on, every new `GIFT_CARD` tender must name one of the restaurant's cards; other companies' cards go under `OTHER`. Turning it off is refused while any card holds a balance (`GIFT_CARDS_OUTSTANDING`). | Existing tenders and existing habits keep working until a manager turns cards on. Turning it off with value outstanding would strand guests' money. |
| D9 | Paying with a card? | **A `GIFT_CARD` tender with the card's code.** Inside `recordTender`'s transaction, after the order and settlement locks, the card row is locked; the tender amount must be no more than the card's balance and no more than what remains on the check. The tender stores `gift_card_id`, and a `REDEEMED` entry is written at once. A card can pay part of a check and another tender the rest. Refusals: `GIFT_CARD_NOT_FOUND` (the same message for any wrong code), `GIFT_CARD_INACTIVE`, `INSUFFICIENT_GIFT_CARD_BALANCE` (shows the balance so staff can take that much). The existing tender idempotency key covers the retry: no second entry. Gift card tenders still take no tip. | Taking the value when the tender is recorded is the only way to stop two terminals spending the same balance. A RECORDED tender is only ever reversed by voiding it, so the reversal has one place to live. |
| D10 | Voids, cancels and refunds? | **Voiding a gift card tender (settlement still OPEN) writes `REDEMPTION_VOIDED` and puts the amount back.** Cancelling a settlement already needs every tender voided first. **A refund recorded as `GIFT_CARD` goes onto a card that paid that check** (chosen from its gift card tenders, so no code is typed), writing `REFUNDED`, and is no more than the gift card tenders on that check. Voiding that refund writes `REFUND_VOIDED`, refused if the card no longer holds the amount (`INSUFFICIENT_GIFT_CARD_BALANCE`). On a check paid another way, a refund can't be made as `GIFT_CARD` while the program is on (`GIFT_CARD_REFUND_NOT_ALLOWED`). | Money goes back the way it came. Refunding onto a brand-new card would be a sale with no payment, which D4 doesn't allow. |
| D11 | Mistaken sale? | **A manager can void a sale (`SALE_VOIDED`, reason required) while the card still holds the full amount of that sale and, for cash, the drawer session it went into is still OPEN.** The payment record is marked VOIDED (never deleted); cash leaves the drawer's expected total. | Same rule as voiding a cash tender. After the value has been spent, the sale is a fact and a refund is not possible. |
| D12 | Cash-out, adjustments and card status? | **Cash-out:** a manager pays out the whole balance in cash with a reason, from an OPEN drawer session where the location requires drawers; `CASHED_OUT` brings the balance to zero and leaves the drawer. **Adjustments:** add or remove value with a reason (up to 200 characters), never below zero or above the maximum balance; `ADJUSTED`. **Status:** `ACTIVE` / `INACTIVE` (deactivate and reactivate, reason required); an inactive card can't be spent, reloaded or adjusted, and its balance stays. **Replace code:** for a lost or stolen card, a manager issues a new code for the same card (old hash replaced, shown once); the balance and history stay. All four are audited. | Some states require cash back for small balances on request; doing it through the drawer keeps cash counts right. Deactivating, never deleting, matches every other configurable record. A lost card is common and the balance belongs to the guest. |
| D13 | Permissions and roles? | **Three new: `gift-cards.view` (look up a card by code or number, balance and history; Server, Bartender, Host and managers), `gift-cards.sell` (sell and reload; Server, Bartender and managers), `gift-cards.manage` (settings, void a sale, cash-out, adjustments, status, replace code; Manager, General Manager, Owner).** Paying with a card stays under `settlements.tender.gift-card`; refunds under `settlements.refund`. 152 becomes 155. | Selling is a counter task; correcting balances and paying out cash are manager tasks (rule 2). Codes use the existing hyphen style (`settlements.tender.gift-card`). |
| D14 | Audit and events? | **Audited (category SETTLEMENTS): sales, sale voids, cash-outs, adjustments, status changes, code replacements and settings changes, by card number (`GC-000123`) and amounts.** The existing tender and refund audit rows gain the card number. The code, its hash and its last four characters never appear in audit, logs or outbox payloads. No new outbox event. | Money actions are audited (audit decision). The code is a bearer secret (rule 15). Nothing on the floor needs to refresh live. |
| D15 | Drawers? | **Expected cash = today's formula + cash gift card sales − voided cash sales − cash-outs**, for the session each went into. The drawer close screen shows "Gift card sales (cash)" and "Gift card cash-outs" as their own lines. | A drawer that took cash for a card must count it, or every gift card sale shows as cash over. |
| D16 | Sales journal and reports? | **Journal:** a sale posts Dr `TENDER/<payment type>`, Cr `GIFT_CARD/ISSUED` on the sale's business date; a sale void reverses it; a cash-out posts Dr `GIFT_CARD/CASHED_OUT`, Cr `TENDER/CASH`; an adjustment posts `GIFT_CARD/ADJUSTED` against `GIFT_CARD_ADJUSTMENT/ADJUSTED`. Redemptions stay `TENDER/GIFT_CARD` and refunds to a card stay `REFUND/GIFT_CARD` as today; the bookkeeper maps `GIFT_CARD/*` and `TENDER/GIFT_CARD` to one liability account. Every day still balances. **Report:** a Gift cards section in the Settlements area (`reports.settlements`): sold, reloaded, redeemed, refunded, adjusted and cashed out by business date and location, and the organization's outstanding balance at the end of the range. CSV by card number only, never the code. | One balanced journal, no chart of accounts (Phase 28). The outstanding balance is money the restaurant owes and the owner will ask for it. |
| D17 | Screens, seeds and leftovers? | **Settlement panel:** the Gift card tender asks for the code, shows the balance and offers "Use balance". **Gift cards page** (Service group, `gift-cards.view`): sell or reload, look up by code, card history; manager actions and the settings on the same page for `gift-cards.manage` holders. **Refund screen:** pick the card when refunding as Gift card. **Drawer close:** the two new lines. The demo seed turns the program on and sells, spends and reloads a few cards (idempotent, local dev DB only); the validation fixture is unchanged. Leftovers: the manual SMTP/Twilio check stays with the owner. | Where servers and managers already work. |

## Approved Phase 31 Policies

Approved by the owner on 2026-11-19: D1–D17 as recommended. These are binding.

1. **Scope (D1).** The restaurant's own gift cards: sell, reload, look up, pay with (in part or in full), value back on tender void and refunds to a card, adjustments, cash-out, deactivate and reactivate, replace a lost code, a report and journal lines. Payment processing, third-party providers, printing, online sales, guest-facing balances, e-gift delivery, expiry, fees, bonus value, profile links and house accounts stay out.
2. **Contract (D2).** "No gift-card balances" is lifted for the restaurant's own cards only; settlement stays record only. CLAUDE.md, README section 19 and the Phase 11 plan are updated before any code. Rule 15 is unchanged.
3. **Ownership (D3).** Settlements owns gift cards. No new module, no workflow.
4. **Selling (D4).** `gift_card_sales`, its own record, never an order line. Paid by `CASH` (drawer rules as for cash tenders, received and change), `EXTERNAL_CARD` (safe metadata) or `OTHER` (description). Creates the card (`ISSUED`) or adds to one (`RELOADED`). Amount 1.00 to the maximum balance. Idempotent (scope `gift-cards.sell`). Not revenue: no tax, tip, sales report, tip pool or forecast.
5. **Code (D5).** App-generated, 16 Crockford base32 characters in four groups, about 80 random bits. Stored only as a SHA-256 hash and the last 4 characters; the full code is returned once at sale (and at code replacement) and never appears in audit, logs or outbox payloads. Non-secret card number `GC-000123`. Paying and looking up by code need the full code.
6. **Where (D6).** Organization-wide; every entry records its location and business date.
7. **Ledger (D7).** `gift_card_entries`, append-only by trigger, with `balance_after`; kinds `ISSUED`, `RELOADED`, `SALE_VOIDED`, `REDEEMED`, `REDEMPTION_VOIDED`, `REFUNDED`, `REFUND_VOIDED`, `ADJUSTED`, `CASHED_OUT`; signed `NUMERIC(12,2)`. `gift_cards.balance` changes with each entry under a row lock; triggers keep `balance_after` = previous + amount, never negative, and the card's balance equal to its latest entry.
8. **Settings (D8).** `gift_card_programs` per organization: `enabled` (off by default), `max_balance` (default 500.00, at most 10,000.00). Off: `GIFT_CARD` tenders recorded as before. On: every new `GIFT_CARD` tender names a card. Turning off refused while any card holds a balance (`GIFT_CARDS_OUTSTANDING`).
9. **Paying (D9).** In `recordTender`, after the order and settlement locks, the card row is locked; amount ≤ balance and ≤ remaining. The tender stores `gift_card_id`; `REDEEMED` is written at once. Refusals `GIFT_CARD_NOT_FOUND` (one message for any wrong code), `GIFT_CARD_INACTIVE`, `INSUFFICIENT_GIFT_CARD_BALANCE` (with the balance) write nothing. The tender idempotency key covers retries. No tips.
10. **Voids and refunds (D10).** Voiding a gift card tender writes `REDEMPTION_VOIDED`. A `GIFT_CARD` refund goes onto a card that paid that check, chosen from its gift card tenders, up to their total; `REFUNDED`. Voiding it writes `REFUND_VOIDED`, refused if the card no longer holds the amount. While the program is on, a `GIFT_CARD` refund on a check with no gift card tender is refused (`GIFT_CARD_REFUND_NOT_ALLOWED`).
11. **Sale void (D11).** `gift-cards.manage`, reason required, only while the card holds the full sale amount and, for cash, its drawer session is OPEN. The sale is marked VOIDED, never deleted; `SALE_VOIDED`.
12. **Cash-out, adjustments, status, code (D12).** Cash-out pays the whole balance in cash with a reason from an OPEN drawer session where required (`CASHED_OUT`). Adjustments with a reason up to 200 characters, within 0 and the maximum (`ADJUSTED`). `ACTIVE` / `INACTIVE` with a reason; inactive cards can't be spent, reloaded or adjusted. Replace code issues a new code for the same card. All audited.
13. **Permissions (D13).** `gift-cards.view` (Host, Server, Bartender, managers), `gift-cards.sell` (Server, Bartender, managers), `gift-cards.manage` (Manager, General Manager, Owner). Paying stays `settlements.tender.gift-card`; refunds `settlements.refund`. 152 becomes 155.
14. **Audit and events (D14).** Category SETTLEMENTS: sales, sale voids, cash-outs, adjustments, status, code replacements, settings, by card number and amounts. Tender and refund audit rows gain the card number. No code, hash or last four anywhere. No new outbox event.
15. **Drawers (D15).** Expected cash adds cash gift card sales and subtracts voided cash sales and cash-outs; the close screen shows them as their own lines.
16. **Journal and report (D16).** Sale: Dr `TENDER/<payment type>`, Cr `GIFT_CARD/ISSUED`; sale void reverses it on its date; cash-out: Dr `GIFT_CARD/CASHED_OUT`, Cr `TENDER/CASH`; adjustment: `GIFT_CARD/ADJUSTED` against `GIFT_CARD_ADJUSTMENT/ADJUSTED`. Redemptions and refunds keep their existing lines. Report: Gift cards section in the Settlements area (`reports.settlements`), movements by date and location, outstanding balance at the end of the range, CSV by card number only.
17. **Screens and seeds (D17).** Settlement panel gift card tender with code, balance and "Use balance"; Gift cards page (Service group); refund card picker; drawer close lines. Demo seed turns the program on and sells, spends and reloads a few cards; validation fixture unchanged.
18. **Boundaries.** Migrations 0072 (generated) and 0073 (custom); no change to tax, inventory, kitchen, tip pool or loyalty rules.

## Amendments decided at implementation

Approved by the owner on 2026-11-19 with the execution plan.

1. **The code is never stored, even in idempotency records (policy 5).** Idempotent commands store their response, so a sale stores its result without the code and the code is added to the first response only. A replayed sale says the code was already shown; a manager replaces it if it was lost. Tender requests put the code's SHA-256, not the code, into the idempotency fingerprint.
2. **Selling also needs the payment method's tender permission (policies 4, 13):** `settlements.tender.cash`, `.external-card` or `.other`, beside `gift-cards.sell`. Servers and bartenders sell for cash or external card.
3. **The balance lives on the card row (policy 7).** `gift_cards.balance`, no separate balance table. A card is inserted at 0 and its `ISSUED` entry moves it. A cash-out records its drawer session on its entry; there is no cash-out table.
4. **Refund limit per card (policy 10):** at most that card's RECORDED tenders on the check minus its earlier unvoided refunds.
5. **Paths (policy 17):** the page is `/gift-cards` in the Service group after Cash drawers (`gift-cards.view`); the API is under `/api/gift-cards/`.
6. **Outstanding balance (policy 16)** is each card's latest entry with a business date on or before the range end, organization-wide; movements are for the selected location.
7. **No reference on card tenders (policy 9):** with the program on, a `GIFT_CARD` tender takes no external reference; the card is the reference.

## 1. Objectives

The restaurant sells its own gift cards, staff take them as payment without a card ever being spent twice, every cent on a card is accounted for in an append-only ledger, and the owner can see how much is owed on cards at any date.

## 2. Scope Boundary

In: the contract change (D2); program settings; cards, codes and the ledger; selling and reloading with drawer, external card or other payment; paying with a card and voiding that tender; refunds onto a card; sale voids, cash-out, adjustments, status and code replacement; drawer totals; journal lines and the report; permissions, audit, screens, the demo seed and documentation.

Out: payment processing; third-party gift card providers; card printing and barcodes; online sales; guest-facing balances; e-gift delivery; expiry and fees; bonus or promotional value; cards linked to guest profiles; house accounts; any change to tax, inventory, kitchen, tip pool or loyalty rules; cloud deployment.

## 3. Review Existing Foundation Before Changes

- `src/db/schema/settlements.ts`, `settlement-service.ts` (`recordTender`, `voidTender`, `cancelSettlement`, lock order), `settlement-math.ts` (`planTender`, `reconcile`), validators and the tender UI on the order screen.
- `refund-service.ts`, `drawer-math.ts` (`expectedCash`, refund limits), `drawer-service.ts` (close and its facts query), the drawer close screen.
- `reporting/rules/sales-journal.ts` and its query; the Settlements report area and CSV export rules.
- Phase 30 ledger: `guest-loyalty.ts` schema, `0071_guest_loyalty_guards.sql`, the posting service and its lock pattern.
- Phase 22 manage link hashing; permission and role catalogs, the permission seed pattern (`src/db/seeds/*-permissions.ts`), audit action registry, idempotency scopes, navigation.

## 4. Build Order

1. **Contract change** (D2) in CLAUDE.md, README and the Phase 11 plan.
2. **Migration 0072** (generated): `gift_card_programs`, `gift_card_number_counters`, `gift_cards`, `gift_card_sales`, `gift_card_entries`, `settlement_tenders.gift_card_id`, `order_refunds.gift_card_id`. **Migration 0073** (custom): append-only and `balance_after` guards on `gift_card_entries`, card balance equal to its latest entry.
3. **Pure rules** (unit tested): code generation, normalization (case, dashes, Crockford look-alikes) and hashing; sale, redemption, refund, adjustment and cash-out limits; drawer and journal arithmetic.
4. **Ledger posting service** in Settlements: lock the card, write the entry, update the balance.
5. **Settings, sell, reload, look up** services and routes.
6. **Redemption** in `recordTender`; **void** in `voidTender`; **refunds** and refund voids.
7. **Sale void, cash-out, adjustments, status, replace code.**
8. **Drawer** totals (D15); **journal** lines and the **report** (D16).
9. Permissions seed and role grants (D13); audit (D14).
10. Screens (D17), demo seed.
11. Tests (sections 5–7), docs (section 8), validation (section 9), completion report.

## 5. Unit Tests

- Code: 16 Crockford characters, normalized input (lower case, spaces, dashes, `O`→`0`, `I`/`L`→`1`) matches; never 13 digits in a row.
- Limits: sale within 1.00 and max balance; redemption no more than balance and remaining; refund no more than the check's gift card tenders; adjustment within 0 and max; cash-out equals the balance.
- Drawer expected cash with gift card sales, voided sales and cash-outs.
- Journal day with sales, voids, cash-outs and adjustments balances; existing journal tests unchanged.

## 6. Integration Tests

- **Canonical Bacon Cheeseburger** passes unchanged with the program off and on (paid in cash). A variant paid partly by gift card: one `REDEEMED` entry, the order closes; the retried tender with the same key writes nothing more.
- Program off: a `GIFT_CARD` tender is recorded as before with no card. Program on: a `GIFT_CARD` tender without a card is refused; turning off with a balance outstanding is refused.
- Sale: cash into the drawer (refused with no open session where required), external card, other; `ISSUED` then `RELOADED`; above max balance refused; the code is returned once and only its hash is stored.
- Redemption refused with a wrong code, an inactive card or too little balance; a refusal writes nothing. Two concurrent tenders on one card can't together exceed its balance.
- Voiding the tender puts the value back; a refund onto the card and its void; refund as gift card on a check paid in cash refused.
- Sale void refused once value was spent or the drawer closed; cash-out zeroes the balance and lowers expected cash; adjustment limits; inactive card refuses spending and reloading; replacing the code makes the old one fail and keeps the balance.
- Ledger UPDATE and DELETE refused by the trigger; balance equals the sum of entries after every scenario.
- Drawer close and the journal balance with gift card activity; sales reports and tip pools are unchanged by card sales.
- Authorization: each route refuses without its permission. No code, hash or last four in audit rows, outbox payloads or the CSV.

## 7. E2E Tests (Playwright)

- A manager turns gift cards on; a server sells a $50 card for cash and sees the code once.
- The server rings a check, pays $30 with the card and the rest in cash; the order closes and the card shows $20 left.
- A manager looks up the card by number and sees its history; the drawer close shows the cash card sale.

## 8. Documentation

- CLAUDE.md: a Gift cards line, Phase 31 in the phase list.
- README: section 19 (D2), Domain 12 tables, the Phase 31 entries in sections 33 and 36, Reporting (Gift cards section, journal lines), Cash drawers.
- A note in `docs/Phase-11-Settlement-Payments.md` that Phase 31 supersedes its gift card ban.
- `docs/User-Guide.md`: selling, paying with and managing gift cards.
- `docs/Phase-31-Completion-Report.md`.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first); a dev-server run is advisory
- [ ] `npm run build`, with no new warnings
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] Migrations 0072 (generated) and 0073 (custom) reviewed; `npm run db:generate` then reports no changes; migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants (155); `db:seed:validation` and `db:seed:demo` twice create no duplicates
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] Canonical Bacon Cheeseburger, including the idempotent retry, passes unchanged

## 10. Risks

- **A lost code can't be recovered (D5).** Only the hash is stored. The guest needs the card number (`GC-…`) from the receipt for a manager to replace the code; a guest with neither loses the balance, as with cash.
- **No pre-printed card stock.** Codes come from the app; a restaurant that bought numbered cards would write the code on them. Entering pre-printed numbers is future work.
- **Unclaimed property.** Many states require unspent gift card balances to be reported after some years. The report shows outstanding balances and each card's last activity, but nothing reports or escheats them.
- **Third-party cards.** Once the program is on, other companies' gift cards must be recorded as `OTHER`; staff need telling.
- **Journal mapping.** `TENDER/GIFT_CARD` (redemptions) and `GIFT_CARD/*` (sales, cash-outs, adjustments) must be mapped to the same liability account by the bookkeeper.

## 11. Required Phase 31 Completion Report

Write `docs/Phase-31-Completion-Report.md`:

```text
PHASE 31 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Contract change (what was lifted, what stays record only):
- Cards, codes and settings:
- Ledger and balance (kinds, append-only, locking):
- Selling, paying, voids, refunds, cash-out, adjustments:
- Drawers, journal and report:
- Permissions, audit and boundaries:

Results
- A card is never spent past its balance, including concurrent tenders: PASS / FAIL
- Card sales are not revenue: no tax, tips or sales report change: PASS / FAIL
- Balance equals the ledger after every scenario; ledger is append-only: PASS / FAIL
- Drawer and sales journal balance with gift card activity: PASS / FAIL
- No code, hash or last four in audit, logs, outbox or CSV: PASS / FAIL
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
