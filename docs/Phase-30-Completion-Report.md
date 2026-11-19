# PHASE 30 COMPLETION REPORT

## Summary

Phase 30 builds guest loyalty. The owner approved it on 2026-11-19 (D1–D16 as recommended), with nine amendments. Amendments 1–8 were approved with the execution plan; amendment 9 is a correction found while building.

The contract change came first. CLAUDE.md, README section 39 and the Phase 6 and Phase 21 plans now allow loyalty. **Marketing consent, marketing messages, campaigns and guest list export are still banned.**

What was built:
- One points program per organization.
- A visit linked to an ACTIVE profile earns points once, when its table session ends.
- Rewards are reward-only discounts, redeemed on a check and posted when the check closes.
- An append-only points ledger with a running balance that PostgreSQL guards.
- Merge, erase and unlink rules, manual adjustments, screens, a loyalty report in Sales, and demo data.

There are three new permissions (152 in all) and two migrations (0070 generated, 0071 custom). No dependency changed.

All checks pass: lint, typecheck, unit, integration, E2E in CI mode, build and the production audit.

The demo redemption was added after the phase was committed (owner request, 2026-11-19); see "Demo redemption" below.

Fixed after the report was first written (owner request, 2026-11-19): the validation seed now runs on the dev database. See "Validation seed fix" below.

## Environment

- Node v26.13.0
- npm 12.2.0
- Next.js 16.4.5
- PostgreSQL 17.11 (Docker Compose)

## Policies (as built)

**Contract change.** Only "no loyalty" was lifted.
- CLAUDE.md Guests line: "No marketing consent or marketing messages (service messages only, Phase 22)", plus a new Loyalty (Phase 30) line.
- README: section 13 domain text and table list, section 17 (reward-only discounts), section 21 (the loyalty report), section 39, and the Phase 30 entries in sections 33 and 36.
- `docs/User-Guide.md` has a Loyalty points section, and its scope note now lists what loyalty doesn't do.

**Program and earning.**
- `guest_loyalty_programs` holds one row per organization. The program is off until enabled.
- Rates are whole numbers from 0 to 100: points per $1 and points per visit.
- `enabled_at` is set on the first enable and never moves.
- `earnPointsForFinishedParty` runs inside `completeTableSession`, after `markPartyCompleted`.
- It earns only when all of these hold: the program is enabled, the visit finished after `enabled_at`, the party is COMPLETED, and the profile is ACTIVE.
- Points = floor(sum of the CLOSED checks' `subtotal` × points per dollar) + points per visit, when at least one check is CLOSED.
- A partial unique index allows one EARNED entry per party.
- The subtotal and both rates are stored on the entry. Nothing is ever recalculated.

**Ledger and balance.**
- `guest_loyalty_entries` kinds: EARNED, REDEEMED, ADJUSTED, MERGED_OUT, MERGED_IN, ERASED.
- Points are signed whole numbers, with a sign check per kind. Each entry also stores `balance_after`, location, business date (from BusinessDateService), party, order, redemption, related profile, reason and user.
- `postLoyaltyEntry` is the only writer. It locks the profile's `guest_loyalty_balances` row, then writes the entry and the balance in one transaction.
- Migration 0071:
  - refuses UPDATE and DELETE on entries;
  - refuses an entry whose `balance_after` doesn't continue the profile's previous entry;
  - refuses a balance row that differs from its latest entry;
  - makes redemptions append-only;
  - requires a reward's definition to be reward-only in its own organization;
  - freezes the `reward_only` flag.

**Rewards and redemption.**
- `guest_loyalty_rewards` has a number, a name (1 to 80 characters), a cost (1 to 1,000,000) and active. Rewards are deactivated, never deleted.
- Each reward creates its own `reward_only` discount definition, `LOYALTY-<n>` (amendment 4). The picker never offers it. The ordinary apply and edit refuse it with `REWARD_ONLY_DISCOUNT`. The Discounts page shows it read-only.
- Redemption runs through `POST /api/orders/{id}/loyalty-rewards`, in the `redeem-loyalty-reward` workflow:
  - needs `loyalty.redeem`, uses idempotency scope `loyalty.redeem`, and takes the order's `expectedVersion`;
  - the check must be OPEN with no OPEN settlement, and its party must be linked to an ACTIVE profile;
  - it locks the order first, then the balance;
  - available points (balance less pending rewards) must cover the cost;
  - the discount is applied through `applyDiscountInTransaction`, which runs every discount rule except the permission check (amendment 3);
  - it writes `guest_loyalty_redemptions` and audits `loyalty.reward-redeemed`.
- A redemption is pending while its order is OPEN and its discount APPLIED.
- `completeSettlement` calls `postRedemptionsForClosedOrder`. It posts REDEEMED only for discounts still APPLIED with an amount above zero (amendment 6).
- A replay returns the first result and applies nothing more.
- Each refusal writes nothing: `LOYALTY_NOT_ENABLED`, `NO_LINKED_GUEST`, `INSUFFICIENT_POINTS`, `REWARD_INACTIVE`, `REWARD_NEEDS_ITEM`, `SETTLEMENT_IN_PROGRESS`.

**Unlink, merge, erase, refunds, adjustments.**
- Unlinking or relinking a visit that has a redemption is refused (`REWARD_APPLIED`).
- Merge posts MERGED_OUT and MERGED_IN for the duplicate's balance. It locks both balances in ID order. The merge audit row gains `pointsMoved`.
- Erase posts ERASED to bring the balance to zero and keeps the entries. The erase audit row gains `pointsCleared`.
- Merge and erase are both refused while a reward is pending (`REWARD_PENDING`).
- An erased profile never earns or redeems (amendment 5).
- Refunds change no points. The refund screen shows the visit's EARNED entry and a link to the profile (amendment 7).
- Adjustments run through `POST /api/guests/{id}/loyalty/adjustments`:
  - need `loyalty.adjust`;
  - take whole, non-zero points and a required reason with no card digits;
  - may not leave available points below zero;
  - are audited.

**Permissions, audit and boundaries.**
- New permissions:
  - `loyalty.redeem`: Server, Bartender and Manager;
  - `loyalty.adjust` and `loyalty.manage`: Manager;
  - Owner and General Manager get all three through the catalog rules.
- Seeded by `security.loyalty-permissions`.
- Audit actions, category GUESTS: `loyalty.program-changed`, `loyalty.reward-created`, `loyalty.reward-updated`, `loyalty.reward-redeemed`, `loyalty.points-adjusted`.
- No outbox event.
- The Orders module never reaches loyalty data or services; a boundary test checks this (amendment 9).
- No change to settlement, tax, inventory, kitchen or tip rules.

**Screens.**
- Guest profile: a Loyalty points panel with balance, available points, rewards on open checks, history with business dates, and Adjust points.
- Order screen: a Loyalty box with the linked guest's available points and a Redeem form, showing only the rewards they can afford.
- `/host/guests/loyalty`: program settings and rewards. It appears in the Service navigation group under `loyalty.manage` (amendment 2).
- Settlement page: the refund note.

**Report.** Three Sales sections, under `reports.sales` (amendment 1):
- `loyaltyPoints`: per business date at the location;
- `loyaltyRewards`: rewards redeemed, with the discount frozen on the check;
- `loyaltyOutstanding`: points held now, organization-wide.

The page and the CSV contain no guest names or contact details.

## Results

| Check | Result |
|---|---|
| Points earned once per finished visit from CLOSED check subtotals | PASS |
| Redemption is an ordinary discount, posted at close, retries apply nothing more | PASS |
| Balance equals the ledger after every scenario; ledger is append-only | PASS |
| Canonical Bacon Cheeseburger and idempotent retry unchanged | PASS |

The canonical result covers two runs: the existing suites with the program off, and a Phase 30 variant with the program on and a linked profile. In the variant, the retry adds no ticket, ledger, consumption or loyalty row, and the visit earns exactly once at session end.

## Architectural decisions

- **Loyalty stays in Reservations** (D3). The module list is unchanged. Cross-domain steps run in the `end-table-session`, `close-order` and new `redeem-loyalty-reward` workflows.
- **Orders gains two internal pieces:**
  - `applyDiscountInTransaction`, shared by the two public apply functions and the workflow;
  - reward-definition create and update hooks, used only by the Loyalty service in the same transaction.
- **Points leave at close, not at redemption** (D9). Removing a discount and voiding a check need no loyalty hook or reversal entry.
- **Lock order is order, then balance**, in both redemption and close, so the two never deadlock. Merge locks balances in ID order.
- **`lockLoyaltyBalance` reads before it inserts.** The 0071 balance guard sees an inserted row before any conflict is detected, so `INSERT … ON CONFLICT DO NOTHING` on an existing row would be refused. The integration tests found this.

## Migrations

- `0070_guest_loyalty.sql` (generated, reviewed):
  - adds `guest_loyalty_programs`, `guest_loyalty_reward_number_counters`, `guest_loyalty_rewards`, `guest_loyalty_redemptions`, `guest_loyalty_entries` and `guest_loyalty_balances`;
  - adds `discount_definitions.reward_only`.

  Five foreign keys are named explicitly because their generated names reached 63 characters or more. The first generation (only ever applied to the local dev database, never committed) had truncated names. I removed my own two migrations from the dev database and regenerated.
- `0071_guest_loyalty_guards.sql` (custom): the ledger, balance, redemption, reward and reward-only guards described under Policies.
- Both are applied to the dev database. `drizzle-kit generate` reports no schema changes. The migration reconstruction, foreign-key name and upgrade tests pass.

## Validation results

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run test:unit` | 71 files, 982 tests passed |
| `npm run test:integration` | 106 files, 1,500 tests passed |
| `npm run test:e2e`, CI mode (`CI=1`, production build, dev server stopped) | 180 passed in 5.6 minutes, including `loyalty.spec.ts`; 0 failed, 0 flaky |
| `npm run test:e2e`, dev-server run | not run (advisory) |
| `npm run build` | compiled, 167 pages, no warnings |
| `npm audit --omit=dev` | 0 vulnerabilities; no dependency change |
| `npm run db:seed` twice | 1 applied, then 0 applied of 28; 152 permissions; no duplicate grants |
| `npm run db:seed:demo` twice | first run enabled the program (1 per $1, 5 per visit), added 2 rewards and gave 2 demo guests starting points; second run added nothing |
| `npm run db:seed:validation` | first refused on the dev database by the Phase 28 leftover; after the fix below, the first run applied all six validation steps and the second and third runs skipped every step |
| `db:reset` safeguards | unchanged; `src/db/maintenance/database-safety.test.ts` passes |

## Tests executed

- **Unit:** `src/modules/reservations/rules/loyalty.test.ts` (6 tests). The permission count (`auth.test.ts`) and navigation (`navigation.test.ts`) tests were updated.
- **Integration:** `tests/integration/reservations/loyalty.test.ts` (14 tests):
  - earning, rate snapshots, no retroactive earning, program off, unlinked visits;
  - the canonical burger with the program on;
  - redemption, pending points, idempotent replay, posting at close;
  - a removed reward discount;
  - item rewards;
  - each refusal writes nothing;
  - reward-only definitions stay out of the ordinary paths;
  - concurrent redemptions on two checks for one guest;
  - unlink, merge and erase;
  - the triggers;
  - authorization;
  - the report.
- **Integration updates:**
  - Phase 29 upgrade seed test;
  - permission totals moved to 152;
  - seed key lists;
  - expected table list;
  - Sales section order;
  - Orders-to-loyalty boundary test.
- **Fixtures:** `tests/fixtures/loyalty-cleanup.ts` is called from the order and guest cleanups.
- **E2E:** `tests/e2e/loyalty.spec.ts` with `tests/helpers/e2e-loyalty.ts`:
  - a manager turns loyalty on and creates a reward;
  - a linked visit earns at session end;
  - the server redeems the reward on the next check;
  - the points are pending, then posted at close.

  The spec turns the program off again afterwards.

## Files changed

**New:**
- `docs/Phase-30-Guest-Loyalty.md`, `docs/Phase-30-Completion-Report.md`
- `drizzle/migrations/0070_guest_loyalty.sql`, `0071_guest_loyalty_guards.sql` and their snapshots
- `src/db/schema/guest-loyalty.ts`, `src/db/seeds/loyalty-permissions.ts`
- `src/modules/reservations/rules/loyalty.ts` (and test), `services/loyalty-ledger.ts`, `services/loyalty-service.ts`
- `src/workflows/redeem-loyalty-reward/redeem-loyalty-reward.ts`
- `src/modules/reporting/queries/loyalty-report.ts`
- Routes: `src/app/api/loyalty/program`, `src/app/api/loyalty/rewards`, `src/app/api/loyalty/rewards/[rewardId]`, `src/app/api/guests/[profileId]/loyalty`, `src/app/api/guests/[profileId]/loyalty/adjustments`, `src/app/api/orders/[orderId]/loyalty-rewards`
- `src/app/(app)/host/guests/loyalty/page.tsx`, `src/components/orders/loyalty-rewards-panel.tsx`
- `scripts/demo-loyalty.ts`
- Tests: `tests/fixtures/loyalty-cleanup.ts`, `tests/helpers/e2e-loyalty.ts`, `tests/integration/reservations/loyalty.test.ts`, `tests/e2e/loyalty.spec.ts`

**Changed:**
- Docs: `CLAUDE.md`, `README.md`, `docs/User-Guide.md`, `docs/Phase-6-Reservations-Waitlist.md`, `docs/Phase-21-Guest-Profiles-and-Allergens.md`
- Schema and seeds: `src/db/schema/orders.ts` (`reward_only`), `src/db/schema/index.ts`, `src/db/seeds/registry.ts`
- Auth and audit: `src/modules/auth/permission-catalog.ts`, `role-catalog.ts`, `src/modules/auditing/audit-actions.ts`
- Services: `src/modules/orders/services/discount-service.ts`, `src/modules/reservations/services/guest-profile-service.ts`, `validators/reservation-validators.ts`, `src/modules/reporting/services/report-service.ts`
- Workflows: `src/workflows/close-order/complete-settlement.ts`, `src/workflows/end-table-session/end-table-session.ts`
- Pages: the guest profile, order, settlement and discounts pages
- Components: navigation and icons, `order-workspace.tsx`, `settlement-workspace.tsx`
- Scripts: `scripts/seed-demo.ts`
- Tests: the database, reporting and orders authorization tests and fixtures listed above

## Demo redemption

Added at the owner's request after commit 54e168d, completing policy 16.

`seedDemoRedemption` in `scripts/demo-loyalty.ts` runs once from `db:seed:demo`. It plays one finished visit at MAIN, using only the services staff would use:
- a walk-in "Demo Guest Peanut", linked to the profile;
- French Fries and a House IPA sent;
- "Free fries" redeemed on the fries;
- the kitchen and bar work completed;
- the check settled by external card, so no cash drawer is needed;
- the session ended, which earns the visit's points, and the table cleaned.

It is skipped once the guest has any redemption. It is also skipped when the program is off, the guest or reward is missing, or no clean dining table is free.

On the dev database the first run made check #2: $11.00 of items, $4.50 off for the fries, $6.50 paid. The ledger shows −50 (REDEEMED) and +11 (EARNED: 6 for $6.50, plus 5 for the visit), so the balance went from 180 to 141. The second run printed "already there" and added nothing. Typecheck and lint are clean.

## Validation seed fix

Added at the owner's request after the phase was validated. It is not part of the Phase 30 scope.

**Cause.** On 2026-11-18 `db:seed:validation` ran on a dev database whose demo service history had left MAIN with too little ground beef and too few buns. Each canonical burger needs 8 oz of beef and one bun. SEND refused with `INSUFFICIENT_STOCK` partway through the dine-in visit. Before this session, on 2026-11-19, someone sent and settled that check in the app. The table session was never ended, so the reservation stayed SEATED and every later run refused.

**Fix** (`scripts/validation-fixture.ts`):
- When SEND refuses for stock, the script records exactly the reported shortage as found stock through the Inventory service (audited, ledger and balance together) and sends again.
- A SEATED validation diner whose checks are all closed is finished: its kitchen work is completed, the session ends and the table is cleaned.
- Any other leftover still refuses with the old message.
- `docs/Phase-13-Validation-Seed-Data.md` describes both.

**Tests.** New `tests/integration/validation/validation-seed-recovery.test.ts` (3 tests) uses its own database. It drains the beef and buns to zero, leaves a seated validation visit with a closed check and an open session, then runs the fixture twice. It checks:
- the visit is finished;
- the shortage was recorded as found and sold;
- the second run skips;
- every balance equals the ledger.

All 7 validation test files pass (72 tests). Lint and typecheck are clean.

**Dev database.**
- The first run finished the stuck visit (reservation, party and session COMPLETED; kitchen item COMPLETED; table clean) and applied all six validation steps. The 8 oz of beef left at MAIN was exactly enough for the takeout burger, so no found-stock entry was needed this time.
- The next two runs skipped everything.

## Risks

- **Earning depends on the hand-made link.** A visit not linked before its session ends earns nothing, and the only fix afterwards is a manager adjustment. The User Guide tells hosts to link at seating.
- **Refunds don't reverse points.** A refunded check keeps the points its visit earned unless a manager adjusts them.
- **Outstanding points are a liability that nothing values in money.** They are not in the sales journal; the report shows the count only.
- **The "Outstanding" section is organization-wide.** In an "All my locations" comparison it repeats on each location.
- **The program is organization-wide.** Turning it on shows the Loyalty box on every location's order screens.

## Remaining issues

- The manual SMTP and Twilio check (Phase 22 leftover) is still with the owner.
- A dev-server E2E run was not done; the CI-mode run is the authoritative one.
- Nothing is committed.

## Next-phase readiness

Phase 30 is complete and validated, apart from the items above. No later phase is scheduled. The remaining candidates from the 2026-11-18 list are:
- gift card balances;
- a manager log and pre-shift notes;
- event and private-dining bookings;
- FIFO lot costing, which needs a rule changed in the contract.
