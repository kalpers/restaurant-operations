# PHASE 31 COMPLETION REPORT

## Summary

Phase 31 builds the restaurant's own gift cards. The owner approved the plan on 2026-11-19 (D1–D17 as recommended) and seven amendments with the execution plan.

The contract change came first. CLAUDE.md, README section 19 and the Phase 11 plan now allow the app to keep the balance of the restaurant's own gift cards. **Settlement stays record only:** nothing charges a card, contacts a provider or processes a payment, and other companies' gift cards are recorded as `OTHER`.

What was built:
- An organization-wide gift card program, off by default, with a maximum balance per card.
- Cards with an app-generated code that is stored only as a hash and shown once, plus a public card number (`GC-000123`).
- Selling and reloading cards as their own records, never as order lines or revenue.
- An append-only balance ledger per card that PostgreSQL guards.
- Paying with a card as a `GIFT_CARD` tender, with the value taken when the tender is recorded and put back when it is voided.
- Refunds onto a card that paid the check, and refund voids.
- Manager actions: void an unspent sale, cash out, adjust, deactivate and replace a lost code.
- Drawer totals, sales journal lines, a gift card report in Settlements, screens and demo data.

There are three new permissions (155 in all) and two migrations (0072 generated, 0073 custom). No dependency changed. Nothing is committed.

All checks pass: lint, typecheck, unit, integration, E2E in CI mode, build and the production audit.

## Environment

- Node v26.13.0
- npm 12.2.0
- Next.js 16.4.5
- PostgreSQL 17.11 (Docker Compose)

## Policies (as built)

**Contract change.**
- README section 19 now reads: the app "does not authorize or process card payments, house-account receivables, or external-provider payments. Since Phase 31 it keeps the balance of the restaurant's own gift cards, record only".
- CLAUDE.md has a Gift cards (Phase 31) line and Phase 31 in the phase list.
- `docs/Phase-11-Settlement-Payments.md` notes that Phase 31 supersedes its gift card ban for the restaurant's own cards.
- Section 39 still lists payment processing as future work.

**Cards, codes and settings.**
- `gift_card_programs`: one row per organization, `enabled` (off by default), `max_balance` from 1.00 to 10,000.00 (default 500.00). Turning it off is refused while any card holds a balance (`GIFT_CARDS_OUTSTANDING`).
- While off, a `GIFT_CARD` tender is recorded exactly as before, with no card. While on, every new `GIFT_CARD` tender must name a card (`GIFT_CARD_CODE_REQUIRED`) and takes no reference.
- A code is 10 random bytes written as 16 Crockford base32 characters in four groups. A code is redrawn if it would contain 13 digits in a row. Input ignores case, spaces and dashes and reads O as 0 and I or L as 1.
- `gift_cards` stores the SHA-256 of the normalized code and its last four characters, never the code. The code is returned once, by the sale or a code replacement, in a `Cache-Control: no-store` response. It goes in request bodies only, never in URLs.
- Idempotency records keep the sale result without the code or the last four (amendment 1). A replayed sale says the code was already shown. Tender requests fingerprint the code's hash, not the code.
- Any code that opens no card gives the same refusal, `GIFT_CARD_NOT_FOUND`. Lookup by code needs `gift-cards.view`; lookup by number needs `gift-cards.manage`.
- Cards are organization-wide. Every ledger entry records its location and business date.

**Ledger and balance.**
- `gift_card_entries` has nine kinds: `ISSUED`, `RELOADED`, `SALE_VOIDED`, `REDEEMED`, `REDEMPTION_VOIDED`, `REFUNDED`, `REFUND_VOIDED`, `ADJUSTED`, `CASHED_OUT`.
- Amounts are signed `NUMERIC(12,2)`. Each kind has a sign check and a reference check (sale, tender or refund). A reason is required for voids, adjustments and cash-outs. One entry per kind per sale, tender or refund.
- The balance lives on `gift_cards.balance` (amendment 3). `postGiftCardEntry` is the only writer. It runs under the card's row lock and moves the balance and bumps the card version in the same transaction.
- Migration 0073 refuses:
  - UPDATE and DELETE on entries;
  - an entry whose `balance_after` doesn't continue the card's previous entry;
  - a card balance different from its latest entry;
  - deleting a card, or changing its number, organization or issue facts;
  - any change to a sale other than RECORDED → VOIDED with its void fields.
- Card sales and cash-out entries use the Phase 17 open-drawer guard, so cash only goes into or comes out of an open session at the same location.

**Selling.**
- `POST /api/gift-cards` needs `gift-cards.sell` plus the payment's tender permission (amendment 2). Servers and bartenders sell for cash or external card; `OTHER` stays with managers.
- Payment is `CASH` (received and change, drawer rules as for cash tenders), `EXTERNAL_CARD` (safe metadata only) or `OTHER` (description). Never `GIFT_CARD` or `HOUSE_ACCOUNT`.
- A sale without a code issues a new card; with a code it reloads an ACTIVE card. Amount from 1.00 up to what keeps the card within the maximum (`GIFT_CARD_SALE_TOO_SMALL`, `GIFT_CARD_MAX_BALANCE`). Idempotency scope `gift-cards.sell`.
- A sale is not an order: no tax, no tip, not in sales reports, tip pools or forecasts.

**Paying, voids and refunds.**
- `recordTender` locks the order, then the settlement, then the card. The amount may not exceed the card's balance (`INSUFFICIENT_GIFT_CARD_BALANCE`, with the balance in the details) or what remains. `REDEEMED` is written at once, and the tender stores `gift_card_id`. A refusal writes nothing.
- `voidTender` writes `REDEMPTION_VOIDED`, putting the value back. Cancelling still needs every tender voided first.
- A `GIFT_CARD` refund, with the program on, names a card that paid this check (`giftCardId`). It is limited to that card's recorded tenders on the check less its recorded refunds there (amendment 4, `REFUND_EXCEEDS_GIFT_CARD`), on top of the order's own refund limit. It writes `REFUNDED`.
- On a check with no card tender of the restaurant's own cards, a gift card refund is refused (`GIFT_CARD_REFUND_NOT_ALLOWED`).
- Voiding the refund writes `REFUND_VOIDED`, refused if the card no longer holds the amount.

**Manager actions** (`gift-cards.manage`; each needs a reason and the card's or sale's version):
- **Void a sale:** only at the sale's location, while the card holds the whole sale amount (`GIFT_CARD_SALE_SPENT`) and, for cash, its drawer session is still open. The sale becomes VOIDED with a voided business date, and `SALE_VOIDED` is posted.
- **Cash out:** pays out the whole balance (`GIFT_CARD_EMPTY` if none), from an open drawer where the location requires one. Also needs `settlements.tender.cash`. Idempotency scope `gift-cards.cash-out`.
- **Adjust:** signed amount, never below zero or above the maximum; needs the program on and the card ACTIVE.
- **Deactivate or reactivate:** an inactive card can't be spent, reloaded, adjusted, cashed out or refunded onto; its balance stays.
- **Replace code:** a new code for the same card, shown once; the old code stops working and the balance and history stay.

**Drawers, journal and report.**
- Expected cash = the Phase 17 formula + recorded cash card sales − cash-outs, per session. The drawer page shows "Gift card sales (cash)" and "Gift card cash-outs" when either is not zero.
- Sales journal lines:
  - a sale: Dr `TENDER/<payment type>`, Cr `GIFT_CARD/ISSUED`, on its business date;
  - a sale void: the reverse, on the date voided;
  - a cash-out: Dr `GIFT_CARD/CASHED_OUT`, Cr `TENDER/CASH`;
  - net adjustments: `GIFT_CARD/ADJUSTED` against `GIFT_CARD_ADJUSTMENT/ADJUSTED`.

  Spending stays `TENDER/GIFT_CARD` and refunds `REFUND/GIFT_CARD`. Every day still balances.
- Settlements report (`reports.settlements`) gains three sections:
  - **Gift card movements:** by business date at the location;
  - **Outstanding gift card balances:** the organization, as of the range end (amendment 6);
  - **Cards holding a balance:** each card's public number, balance and last activity, up to 500 cards.

  The CSV holds card numbers only.

**Permissions, audit and boundaries.**
- Three new permissions:
  - `gift-cards.view`: Host, Server, Bartender, Manager;
  - `gift-cards.sell`: Server, Bartender, Manager;
  - `gift-cards.manage`: Manager.

  Owner and General Manager hold all three. 155 in all. Seed `security.gift-card-permissions`.
- Audit category SETTLEMENTS:
  - `settlements.gift-card-program-changed`
  - `settlements.gift-card-sold`
  - `settlements.gift-card-sale-voided`
  - `settlements.gift-card-cashed-out`
  - `settlements.gift-card-adjusted`
  - `settlements.gift-card-status-changed`
  - `settlements.gift-card-code-replaced`

  Tender recorded and voided, and refund recorded and voided, gain `giftNumber`. The card is recorded as `giftNumber` (`GC-000123`); never its code, hash or last four.
- No new outbox event; the existing settlement events carry identifiers only.
- No change to tax, inventory, kitchen, tip pool or loyalty rules. Settlement writes no inventory and changes no fulfillment or table session.

**Screens.**
- **Settlement panel:** choosing Gift card asks for the code, offers Check balance (shows the card number and balance) and Use balance (the smaller of balance and remaining). Tender lines show "Gift card GC-…". The refund form picks the card from those that paid the check, or explains why none can.
- **`/gift-cards`** (Service group, after Cash drawers, `gift-cards.view`; amendment 5):
  - sell or reload, with the code shown once in a large banner until staff confirm they've written it down;
  - look up by code, or by number for managers;
  - card detail with balance, last four and history;
  - for managers: outstanding total, settings, recent cards, sale voids, adjust, cash out, deactivate or reactivate, and replace code.

## Results

| Check | Result |
|---|---|
| A card is never spent past its balance, including concurrent tenders | PASS |
| Card sales are not revenue: no tax, tips or sales report change | PASS |
| Balance equals the ledger after every scenario; ledger is append-only | PASS |
| Drawer and sales journal balance with gift card activity | PASS |
| No code, hash or last four in audit, logs, outbox or CSV | PASS |
| Canonical Bacon Cheeseburger and idempotent retry unchanged | PASS |

- The concurrency test sends two tenders for $15 each on a $20 card from two checks at once: one succeeds, the other is refused, and $5 remains.
- The secrets test searches every audit, outbox and idempotency row of the test organization for the code (with and without dashes), its hash and its last four. The CSV test checks the gift card CSV holds the card number but neither the last four nor the code.
- The canonical result covers two runs: the existing suites, which run with the program off, and a Phase 31 variant. In the variant, the burger is sent, the SEND is retried with the same key (replayed, no new inventory movement), and the check is paid $10 by gift card and the rest in cash.

## Architectural decisions

- **Settlements owns gift cards** (D3). There is no new module and no workflow: selling, spending, refunding and cashing out all run in Settlements' own transactions. Reporting reads the tables read-only, as for every other domain.
- **The schema is split across two files to avoid an import cycle.** `gift-cards.ts` holds programs, counters, cards and sales; `gift-card-entries.ts` holds the ledger, which references tenders and refunds. `settlements.ts` imports cards for the new `gift_card_id` columns.
- **Value moves when the tender is recorded, not at close.** A RECORDED tender is only reversed by voiding it, so the reversal has one place. Taking the value under the card lock is what stops two terminals spending the same balance.
- **Lock order:**
  - tenders: order → settlement → card;
  - refunds: order → card;
  - sales and sale voids: program (share) → card → sale → drawer (share);
  - cash-outs: card → drawer (share).

  No path locks a card before an order, so they can't deadlock.
- **Audit naming.** The audit table requires `domain.action` with no hyphen in the domain, so actions are `settlements.gift-card-*`. The audit sanitizer refuses any field whose name contains "card" (a guard against card numbers), so the public number is audited as `giftNumber`. I kept both guards as they are rather than loosen them.
- **Stored responses carry no last four.** Sale and cash-out results kept in idempotency records use a card view without `lastFour`. The integration test found the first version stored it.

## Migrations

- `0072_gift_cards.sql` (generated, reviewed):
  - adds `gift_card_programs`, `gift_card_number_counters`, `gift_cards`, `gift_card_sales` and `gift_card_entries`;
  - adds nullable `gift_card_id` to `settlement_tenders` (GIFT_CARD only, no reference) and `order_refunds` (GIFT_CARD only, no tip), with indexes.

  Every foreign key is named explicitly; none reaches 63 characters.
- `0073_gift_card_guards.sql` (custom): the entry, card and sale guards, and the open-drawer triggers on sales and entries.
- Both are applied to the dev database. `drizzle-kit generate` reports no schema changes. The migration reconstruction, foreign-key name and table-list tests pass.

## Validation results

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run test:unit` | 73 files, 998 tests passed |
| `npm run test:integration` | 108 files, 1,522 tests passed (995 s) |
| `npm run test:e2e`, CI mode (`CI=1`, production build, dev server stopped) | 181 passed in 6.5 minutes, including `gift-cards.spec.ts`; 0 failed, 0 flaky |
| `npm run test:e2e`, dev-server run | not run (advisory) |
| `npm run build` | compiled, 171 pages, no warnings |
| `npm audit --omit=dev` | 0 vulnerabilities; no dependency change |
| `npm run db:seed` twice | 1 applied of 29, then 0 applied; 155 permissions; no duplicate grants |
| `npm run db:seed:demo` twice | first run turned gift cards on, sold GC-000001 to GC-000003, reloaded one and spent $10.00 of one on a closed takeout check; second run added nothing |
| `npm run db:seed:validation` | every step already applied; nothing to do; validation fixture unchanged |
| `db:reset` safeguards | unchanged; `src/db/maintenance/database-safety.test.ts` passes in the unit run |

## Tests executed

- **Unit:**
  - `src/modules/settlements/rules/gift-card-code.test.ts` (6 tests): format, redraw on 13 digits, uniqueness, normalization, refusals, card numbers;
  - `gift-card-math.test.ts` (8 tests): sale, cash, spending, per-card refund, adjustment and cash-out limits;
  - one new case each in `drawer-math.test.ts` and `sales-journal.test.ts`.

  `auth.test.ts` (155 codes) and `navigation.test.ts` (53 links, Gift cards in Service) were updated.
- **Integration:** `tests/integration/settlements/gift-cards.test.ts` (18 tests):
  - program off keeps the old tender;
  - sale with the code once and only its hash stored, with the audit row recording `giftNumber`;
  - reload, limits and an inactive card;
  - tender permission and drawer rules for sales;
  - turning off refused with a balance;
  - paying, with an idempotent retry and close;
  - the canonical Bacon Cheeseburger partly paid by card, with a replayed SEND;
  - a split card and cash payment;
  - refusals that write nothing;
  - tender void;
  - concurrent tenders;
  - refunds onto a card with the per-card limit, and refund voids;
  - a gift card refund refused on a cash check;
  - sale voids, including a spent card;
  - cash-out with drawer totals and a clean drawer close;
  - adjust, version conflict, permission refusals, replace code and lookup by number;
  - the triggers;
  - the report, sales figures, journal lines and the CSV.
- **Integration updates:**
  - a Phase 30 upgrade seed test with each code's role holders;
  - every permission total moved up by three;
  - seed run counts 29;
  - seed key lists;
  - the expected table list.
- **Fixtures:** `tests/fixtures/gift-card-cleanup.ts`, called from the order cleanup before tenders, refunds, drawers and idempotency records are removed.
- **E2E:** `tests/e2e/gift-cards.spec.ts` with `tests/helpers/e2e-gift-cards.ts`:
  - a manager turns gift cards on from the navigation;
  - a server sells a $50 card and the code is shown once;
  - the card pays $5.00 of a check on the settlement screen (Check balance, card number on the tender) and the rest goes on the external terminal;
  - the check closes;
  - the manager finds the card by number: $45.00 with its history.

  Afterwards the spec takes the remaining value off with an audited adjustment and turns gift cards off.

## Files changed

**New:**
- `docs/Phase-31-Gift-Card-Balances.md`, `docs/Phase-31-Completion-Report.md`
- `drizzle/migrations/0072_gift_cards.sql`, `0073_gift_card_guards.sql` and their snapshots
- `src/db/schema/gift-cards.ts`, `src/db/schema/gift-card-entries.ts`, `src/db/seeds/gift-card-permissions.ts`
- `src/modules/settlements/rules/gift-card-code.ts`, `gift-card-math.ts` (and tests)
- `src/modules/settlements/services/gift-card-ledger.ts`, `gift-card-service.ts`
- `src/modules/reporting/queries/gift-card-report.ts`
- `src/app/api/gift-cards/` (program, sell and list, lookup, history, adjust, cash-out, status, replace-code, sale void)
- `src/app/(app)/gift-cards/page.tsx`, `src/components/settlements/gift-card-workspace.tsx`
- `scripts/demo-gift-cards.ts`
- `tests/integration/settlements/gift-cards.test.ts`, `tests/fixtures/gift-card-cleanup.ts`, `tests/e2e/gift-cards.spec.ts`, `tests/helpers/e2e-gift-cards.ts`

**Changed:**
- `CLAUDE.md`, `README.md`, `docs/Phase-11-Settlement-Payments.md`, `docs/User-Guide.md`
- `src/db/schema/settlements.ts`, `src/db/schema/index.ts`, `src/db/seeds/registry.ts`
- `src/modules/settlements/services/settlement-service.ts`, `refund-service.ts`, `drawer-service.ts`; `rules/drawer-math.ts`; `queries/settlement-queries.ts`; `validators/settlement-validators.ts`
- `src/modules/reporting/rules/sales-journal.ts`, `queries/sales-journal.ts`, `services/report-service.ts`
- `src/modules/auth/permission-catalog.ts`, `role-catalog.ts`; `src/modules/auditing/audit-actions.ts`
- `src/components/settlements/settlement-workspace.tsx`, `src/app/(app)/orders/[orderId]/settlement/page.tsx`, `src/app/(app)/cash-drawers/page.tsx`, `src/components/app-shell/navigation.ts`, `nav-icons.tsx`
- `scripts/seed-demo.ts`
- Tests: `auth.test.ts`, `navigation.test.ts`, `drawer-math.test.ts`, `sales-journal.test.ts`, `foundation-seeds.test.ts`, `seed-framework.test.ts`, `migrations.test.ts`, `tests/fixtures/order-cleanup.ts`

## Risks

- **A lost code can't be recovered** (D5). Only the hash is kept. A manager can replace the code for a guest who has the card number from the receipt; a guest with neither loses the balance, as with cash.
- **No pre-printed card stock.** Codes come from the app, so staff write or attach them to the card. Entering numbers printed by a card supplier is future work.
- **Unclaimed property.** Many states require unspent balances to be reported after some years. The report shows outstanding balances and each card's last activity, but nothing reports or escheats them.
- **Other companies' gift cards** must be recorded as `OTHER` once the program is on, and gift card refunds on checks paid that way must use another tender. Staff need telling.
- **Journal mapping.** The bookkeeper must map `TENDER/GIFT_CARD` and `GIFT_CARD/*` to the same liability account.
- **The demo seed prints the demo codes** to the terminal once. That is a local developer script, like the screen that shows a code once; the codes are not stored or logged by the app.

## Remaining issues

- The manual SMTP and Twilio check (Phase 22 leftover) is still with the owner.
- A dev-server E2E run was not done; the CI-mode run is the authoritative one.
- Nothing is committed.

## Next-phase readiness

Phase 31 is complete and validated, apart from the items above. No later phase is scheduled. The remaining candidates from the 2026-11-18 list are:
- a manager log and pre-shift notes;
- event and private-dining bookings;
- FIFO lot costing, which needs a rule changed in the contract.
