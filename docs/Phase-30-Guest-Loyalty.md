# Phase 30: Guest Loyalty Design and Implementation Plan

## Purpose

Owner request, 2026-11-19: guests known to the restaurant earn points on their visits and spend them on rewards that staff apply to a check.

Phase 28 deferred loyalty (plan section 11) because it changes a rule in the contract: CLAUDE.md says **"No loyalty, marketing consent or guest messaging"** under Guests (Phase 21), and README section 39 lists customer loyalty as future work. Approving this plan lifts the loyalty part of that rule only. **Marketing consent, marketing messages, campaigns and guest list export stay banned.**

What already exists (reviewed 2026-11-19):

| Area | What is there | Where |
|---|---|---|
| Guest profiles | Organization-wide, `ACTIVE` / `MERGED` / `ERASED`, owned by Reservations; `guests.view`, `guests.contact.view`, `guests.manage`, `guests.merge`, `guests.erase` | `src/db/schema/guest-parties.ts`, `reservations/services/guest-profile-service.ts` |
| Profile link | `guest_parties.guest_profile_id`, linked and unlinked by hand, only while the party isn't finished (`COMPLETED`, `CANCELLED`, `NO_SHOW`) | `guest-profile-service.ts` (`FINISHED_PARTY_STATUSES`, `PARTY_FINISHED`) |
| Orders and parties | `orders.guest_party_id`, copied from the table session when a dine-in or bar check opens. Takeout and bar tabs with no session have none | `src/db/schema/orders.ts`, `order-service.ts` |
| Session end | `end-table-session` refuses while any check is OPEN (`ORDERS_OPEN`) and marks the party `COMPLETED` in the same transaction | `src/workflows/end-table-session/end-table-session.ts` |
| Visit history | Worked out on read from linked parties and order snapshots; nothing stored | `reservations/queries/guest-visits.ts` |
| Discounts | `discount_definitions` (ITEM / ORDER, FIXED_AMOUNT / PERCENTAGE), applied as snapshotted `order_discounts` / `order_item_discounts` with a reason, `is_comp`, `APPLIED` / `REMOVED`; `orders.discount.apply`, `orders.discount.manage` | `src/db/schema/orders.ts`, `orders/services/discount-service.ts` |
| Close | `close-order` closes a check when its settlement reconciles | `src/workflows/close-order/` |
| Merge and erase | Merge is never undone (`guest_profile_merges`); erase clears personal data from the profile, profiles merged into it and its visits, and keeps orders | `guest-profile-service.ts` |
| Manage link | Phase 22 private link for online bookings (view and cancel only) | `reservation_manage_links` |

Permissions today: 149. Last migration: `0069`.

## Decisions for the owner

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D1 | Scope? | **One points program per organization: earning from finished visits, a rewards list, redeeming a reward on a check, manual adjustments, merge and erase rules, and a loyalty report.** Out: tiers, expiry, birthday rewards, guest-facing balances (manage link or a public page), any guest message about points, marketing, gift cards, stored value, and earning on takeout or tabs with no party. | This is the smallest program a restaurant would run. Each item left out needs its own rules (expiry needs a scheduled job and notices; a guest-facing balance needs new public endpoint rules). |
| D2 | Contract change? | **Lift "no loyalty" only.** CLAUDE.md Guests line becomes "No marketing consent or marketing messages"; README section 39 marks loyalty as built (Phase 30). The Phase 6 and Phase 21 plans get a note that Phase 30 supersedes their loyalty bans. | Loyalty works without marketing. Keeping the marketing ban means nothing about guest messaging changes. |
| D3 | Which module owns it? | **Reservations**, beside guest profiles (Phase 21 D1). Cross-domain steps run in workflows: earning in `end-table-session`, redemption in a new `redeem-loyalty-reward` workflow, posting in `close-order`. No new module. | The module list in CLAUDE.md stays the same. Orders never imports Reservations (the existing boundary tests). |
| D4 | How are points earned? | **When the visit finishes (session end, party `COMPLETED`), once per party.** Points = floor(sum of `subtotal` of the party's CLOSED checks × `points_per_dollar`) + `points_per_visit` if at least one check is CLOSED. `subtotal` is after discounts and before tax, so tax, tips and the reward itself earn nothing. VOIDED checks earn nothing. Both rates are whole numbers 0 to 100, stored on the earning entry. | The profile link can't change after the party finishes, so earning once at that point needs no rule for late links or unlinks. "Points per visit" covers "free dessert after 10 visits" with the same model. |
| D5 | Program settings? | **`guest_loyalty_programs`, one row per organization: `enabled`, `points_per_dollar`, `points_per_visit`, `enabled_at`.** Off by default. Changes apply to visits finishing after the change; nothing earned before is recalculated (rule 4). Visits that finished before the program was first enabled never earn. | One program across locations fits organization-wide profiles. Rule 4 forbids recalculating history. |
| D6 | Ledger? | **`guest_loyalty_entries`, append-only (trigger refuses UPDATE and DELETE): `EARNED`, `REDEEMED`, `ADJUSTED`, `MERGED_OUT`, `MERGED_IN`, `ERASED`.** Signed whole points (positive adds). Each row carries profile, location and business date (where it applies), order or party reference, user, reason, and the rate snapshot for `EARNED`. A `guest_loyalty_balances` row per profile is updated with each entry in the same transaction under a row lock, and a check constraint keeps it equal to its own running total. | The Inventory pattern (rule 6): the ledger is authoritative, the balance is for locking and fast reads, and corrections are new entries, never edits. |
| D7 | Rewards? | **`guest_loyalty_rewards`: name, points cost (whole, above 0), and a discount definition.** The definition carries the amount and scope as today; a new `discount_definitions.reward_only` flag hides it from the normal discount picker and makes the ordinary apply refuse it (`REWARD_ONLY_DISCOUNT`). Rewards are deactivated, never deleted. Managed under `loyalty.manage`. | Redemption becomes an ordinary discount or comp, so tax, totals, settlement and reports stay unchanged (Phase 28 section 11). |
| D8 | How is a reward redeemed? | **On an OPEN check whose party is linked to an ACTIVE profile, with no OPEN settlement, under `loyalty.redeem`.** The workflow locks the balance row, checks available points (balance minus pending rewards) cover the cost, applies the reward's discount through the discount service (reason "Loyalty: <reward name>"), and writes a `guest_loyalty_redemptions` row linking reward, profile, order, discount and the points cost snapshot. Idempotent (scope `loyalty.redeem`). Refusals: `LOYALTY_NOT_ENABLED`, `NO_LINKED_GUEST`, `INSUFFICIENT_POINTS`, `REWARD_INACTIVE`. | Applying through the existing discount rules keeps one way of changing a check's money. |
| D9 | When do the points leave the balance? | **When the check CLOSES.** `close-order` posts a `REDEEMED` entry for each redemption whose discount is still `APPLIED`. A reward whose discount was removed, or whose check was voided, posts nothing. Until then it is "pending" and counts against available points (worked out on read). | Removing a discount and voiding a check already have their own paths; posting at close means none of them needs a loyalty hook or a reversal entry. |
| D10 | Unlinking, merge and erase? | **Unlink is refused while the party has a redemption (`REWARD_APPLIED`).** Merge moves the duplicate's balance to the survivor with a `MERGED_OUT` / `MERGED_IN` pair, refused while the duplicate has a pending reward. Erase posts an `ERASED` entry that brings the balance to zero, refused while a reward is pending; the ledger rows stay (they hold no personal data). | Merge is never undone and erase keeps history, so both are expressed as entries, not edits. |
| D11 | Refunds? | **A refund changes no points automatically.** The refund screen shows the points the check earned, and a manager may post an `ADJUSTED` entry under `loyalty.adjust`. | Refund amounts include tax and tips, so mapping them back to earned points needs another allocation rule. Refunds are rare. |
| D12 | Manual adjustments? | **`loyalty.adjust`: add or remove points with a required reason (up to 200 characters), audited.** An adjustment may not bring available points below zero (`INSUFFICIENT_POINTS`). | Covers goodwill and mistakes, with a trail. |
| D13 | Permissions and roles? | **Three new: `loyalty.redeem` (servers, bartenders, managers), `loyalty.adjust` and `loyalty.manage` (managers, GM, owner).** Balance and history show to `guests.view` holders. 149 becomes 152. | Seeing a balance is part of seeing a profile; spending, changing and configuring are separate actions (rule 2). |
| D14 | Audit and events? | **Audited (category GUESTS): program changes, reward changes, redemptions, adjustments, and the merge and erase entries (inside the existing merge and erase audit rows).** `EARNED` and `REDEEMED` postings are not separately audited; the ledger is their record. No outbox event. | Matches the audit decision: money and sensitive actions. Nothing on the floor needs to refresh live for points. |
| D15 | Screens? | **Guest profile: balance, available points and history; Adjust button. Order screen: the linked guest's available points and a Rewards button listing rewards the guest can afford. Settings: Loyalty (program and rewards).** | Where hosts, servers and managers already work. |
| D16 | Reports, seeds and leftovers? | **A Loyalty section under Reports, Guests area, needing `reports.sales`: points earned, redeemed and adjusted by business date and location, outstanding points, and rewards redeemed with their discount amounts.** CSV export as usual, with no guest names or contact details. The demo seed enables the program and gives some demo profiles points and a redemption (idempotent, local dev DB only); the validation fixture is unchanged. Leftovers: the manual SMTP/Twilio check stays with the owner. | Outstanding points are a liability the owner will ask about. Guest lists stay out of exports (Phase 21 policy 23). |

## Approved Phase 30 Policies

Approved by the owner on 2026-11-19: D1–D16 as recommended. These are binding.

1. **Scope (D1).** One points program per organization: earning from finished visits, rewards, redemption on a check, manual adjustments, merge and erase rules, a loyalty report. Tiers, expiry, birthday rewards, guest-facing balances, guest messages about points, marketing, gift cards, stored value and earning on takeout or tabs with no party stay out.
2. **Contract (D2).** Only "no loyalty" is lifted. Marketing consent, marketing messages, campaigns and guest list export stay banned. CLAUDE.md, README section 39 and the Phase 6 and Phase 21 plans are updated before any code.
3. **Ownership (D3).** Reservations owns loyalty. Cross-domain steps run in workflows: earning in `end-table-session`, redemption in `redeem-loyalty-reward`, posting in `close-order`. No new module; Orders never imports Reservations.
4. **Earning (D4).** Once per party, when the session ends and the party becomes `COMPLETED`: floor(sum of CLOSED check `subtotal` × `points_per_dollar`) + `points_per_visit` if at least one check is CLOSED. VOIDED checks earn nothing; tax and tips earn nothing. Both rates are stored on the `EARNED` entry.
5. **Program (D5).** `guest_loyalty_programs`, one row per organization: `enabled` (off by default), `points_per_dollar` and `points_per_visit` (whole, 0 to 100), `enabled_at`. Changes apply to visits finishing afterwards; visits finished before the first enable never earn; nothing is recalculated.
6. **Ledger (D6).** `guest_loyalty_entries`, append-only by trigger; kinds `EARNED`, `REDEEMED`, `ADJUSTED`, `MERGED_OUT`, `MERGED_IN`, `ERASED`; signed whole points; profile, location, business date, order or party reference, user, reason, rate snapshot. `guest_loyalty_balances` per profile updated with every entry in one transaction under a row lock.
7. **Rewards (D7).** `guest_loyalty_rewards`: name, points cost (> 0), discount definition; deactivated, never deleted; `loyalty.manage`. `discount_definitions.reward_only` hides a definition from the picker and the ordinary apply refuses it (`REWARD_ONLY_DISCOUNT`).
8. **Redemption (D8).** OPEN check, party linked to an ACTIVE profile, no OPEN settlement, `loyalty.redeem`. Lock the balance, require available points (balance − pending) ≥ cost, apply the discount through the discount service with reason "Loyalty: <reward name>", write a `guest_loyalty_redemptions` row with the cost snapshot. Idempotent (scope `loyalty.redeem`). Refusals `LOYALTY_NOT_ENABLED`, `NO_LINKED_GUEST`, `INSUFFICIENT_POINTS`, `REWARD_INACTIVE` write nothing.
9. **Posting (D9).** `close-order` posts `REDEEMED` for each redemption whose discount is still `APPLIED`. Removed discounts and voided checks post nothing. Pending is worked out on read.
10. **Unlink, merge, erase (D10).** Unlink refused while the party has a redemption (`REWARD_APPLIED`). Merge posts `MERGED_OUT` / `MERGED_IN` for the duplicate's balance, refused while it has a pending reward. Erase posts `ERASED` to zero, refused while a reward is pending; entries stay.
11. **Refunds (D11).** No automatic change; the refund screen shows the points the check earned.
12. **Adjustments (D12).** `loyalty.adjust`, required reason up to 200 characters, audited; never below zero available points.
13. **Permissions (D13).** `loyalty.redeem` (servers, bartenders, managers), `loyalty.adjust` and `loyalty.manage` (managers, GM, owner). Balance and history with `guests.view`. 149 becomes 152.
14. **Audit and events (D14).** Audited in category GUESTS: program and reward changes, redemptions, adjustments; merge and erase entries inside their existing audit rows. `EARNED` and `REDEEMED` postings are not separately audited. No outbox event.
15. **Screens (D15).** Profile: balance, available, history, Adjust. Order screen: linked guest's available points and Rewards. Settings: Loyalty.
16. **Reports and seeds (D16).** Reports, Guests area, Loyalty section under `reports.sales`: earned, redeemed, adjusted by date and location, outstanding points, rewards redeemed with discount amounts; CSV without names or contact details. Demo seed enables the program and gives some profiles points and a redemption; validation fixture unchanged.
17. **Boundaries.** Migrations 0070 (generated) and 0071 (custom); no change to settlement, tax, inventory, kitchen or tip rules.

## Amendments decided at implementation

Approved by the owner on 2026-11-19 with the execution plan.

1. **Report area (policy 16).** There is no Guests report area. The Loyalty section sits in the Sales area under `reports.sales`; no new area or permission.
2. **Settings page (policy 15).** The Loyalty page is `/host/guests/loyalty`, in the Service navigation group after Guests, under `loyalty.manage`.
3. **Redeeming without `orders.discount.apply` (policies 8, 13).** Servers don't hold `orders.discount.apply`. The redemption workflow applies the reward's discount through an internal Orders function that runs every discount rule except the permission check; `loyalty.redeem` is the only permission needed. Removing a reward discount stays on the ordinary remove path (`orders.discount.apply`).
4. **Reward definitions (policy 7).** Creating a reward creates its own `reward_only` discount definition (code `LOYALTY-<reward number>`, scope, type and value from the reward form) in the same transaction; editing the reward updates that definition, and applied discounts keep their snapshots. The Discounts page shows reward-only definitions read-only.
5. **Erased profiles (policies 4, 8).** Only ACTIVE profiles earn or redeem. An ERASED profile's balance stays zero.
6. **Zero-value rewards at close (policy 9).** `REDEEMED` is posted only when the discount is still `APPLIED` with an amount above zero.
7. **Refund screen (policy 11).** Points are earned per visit, not per check, so the refund screen shows the visit's `EARNED` entry (points and rates) and a link to adjust.
8. **Balance guard (policy 6).** Each entry stores `balance_after`. Custom migration `0071` adds triggers: entries are append-only; a new entry's `balance_after` equals the profile's previous `balance_after` plus its points and is never negative; the balance row equals its latest entry.
9. **Correction to policy 3 (found while building).** "Orders never imports Reservations" was wrong: since Phase 21, Orders reads the party's allergies from Reservations. The rule as built is that the Orders module never reaches loyalty data or services; a boundary test checks it.

## 1. Objectives

A guest linked to a visit earns points when the visit finishes, staff redeem rewards as ordinary discounts, and every point is accounted for in an append-only ledger that survives merge and erase.

## 2. Scope Boundary

In: the contract change (D2); program settings; the ledger and balance; rewards and the `reward_only` flag; earning at session end; redemption and posting at close; unlink, merge and erase rules; adjustments; permissions, audit, screens, the report, demo seed and documentation.

Out: tiers, expiry, birthday or anniversary rewards, guest-facing balances, any guest message about points, marketing consent or messages, campaigns, guest list export, gift cards or stored value, earning on takeout or tabs with no party, automatic reversal on refund, any change to settlement, tax, inventory, kitchen or tip rules; cloud deployment.

## 3. Review Existing Foundation Before Changes

- `src/db/schema/guest-parties.ts`, `guest-profile-service.ts` (link, unlink, merge, erase), `guest-visits.ts`.
- `src/db/schema/orders.ts` discounts, `discount-service.ts`, `rules/order-totals.ts` (`isComp`), the discount picker on the order screen.
- `src/workflows/end-table-session/`, `close-order/`, `move-table-session/` (combined sessions and their parties).
- Refund screen and `order_refunds`.
- Permission and role catalogs, the permission seed pattern (`src/db/seeds/*-permissions.ts`), audit categories, idempotency scopes.
- Reports Guests area and the CSV export rules.

## 4. Build Order

1. **Contract change** (D2) in CLAUDE.md and README, so the code that follows matches the contract.
2. **Migration 0070** (generated): programs, entries, balances, rewards, redemptions, `discount_definitions.reward_only`. **Migration 0071** (custom): append-only trigger on `guest_loyalty_entries`, and the balance consistency guard if a check constraint can't express it.
3. **Pure rules** (unit tested): points earned from subtotals and rates; available points; adjustment and redemption checks.
4. **Ledger posting service** in Reservations: one function that locks the balance, writes the entry and updates the balance.
5. **Program and rewards** services and routes (`loyalty.manage`); `reward_only` refusal in the discount service and picker.
6. **Earning** in `end-table-session` (D4, D5).
7. **Redemption** workflow and route (D8); **posting** in `close-order` (D9).
8. **Unlink, merge, erase** rules (D10); **adjustments** (D12).
9. Permissions seed and role grants (D13); audit (D14).
10. Screens (D15), report (D16), demo seed.
11. Tests (sections 5–7), docs (section 8), validation (section 9), completion report.

## 5. Unit Tests

- Points earned: floor of subtotal × rate, decimal strings, zero rates, visit points only with at least one CLOSED check, VOIDED checks ignored.
- Available points: balance minus pending; redemption and adjustment refused below zero.
- Entry signs per kind; merge pair sums to zero.

## 6. Integration Tests

- **Canonical Bacon Cheeseburger** passes unchanged with the program off and with it on (no profile linked). A variant with a linked profile: ending the session posts one `EARNED` entry with the rate snapshot; ending is not repeatable, so no second entry.
- Rate change after a visit leaves its entry unchanged; a visit finished before the program was enabled earns nothing.
- Redemption: applies the reward-only discount, writes a redemption, leaves the balance until close; close posts `REDEEMED`; the retry with the same key applies nothing more; refused with insufficient points, no linked guest, OPEN settlement, inactive reward, program off; a refusal writes nothing.
- Removing the reward discount or voiding the check, then closing or ending, posts no `REDEEMED` entry.
- The ordinary discount apply refuses a reward-only definition.
- Two concurrent redemptions for one profile cannot together exceed available points.
- Unlink refused with a redemption; merge moves the balance and is refused with a pending reward; erase zeroes the balance and keeps the entries.
- Ledger UPDATE and DELETE refused by the trigger; balance equals the sum of entries after every scenario.
- Authorization: each route refuses without its permission; balance hidden without `guests.view`.
- Report totals match the ledger; CSV has no names or contact details.

## 7. E2E Tests (Playwright)

- A manager enables the program (1 point per dollar, 1 per visit) and adds a "Free dessert" reward for 20 points.
- A host links a profile to a party; the server rings and closes the check; the session ends; the profile shows the earned points.
- On a later visit the server redeems the reward; the check shows the discount; after close the profile's balance drops by 20.

## 8. Documentation

- CLAUDE.md: the Guests line (D2), a short Loyalty line, Phase 30 in the phase list.
- README: Reservations domain (loyalty), Orders (reward-only discounts), Reporting (Loyalty section), section 39, and Phase 30 entries in sections 33 and 36.
- Notes in `docs/Phase-6-Reservations-Waitlist.md` and `docs/Phase-21-Guest-Profiles-and-Allergens.md` that Phase 30 supersedes their loyalty bans.
- `docs/User-Guide.md`: earning and redeeming points; it no longer says profiles have no loyalty points.
- `docs/Phase-30-Completion-Report.md`.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first); a dev-server run is advisory
- [ ] `npm run build`, with no new warnings
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] Migrations 0070 (generated) and 0071 (custom) reviewed; `npm run db:generate` then reports no changes; migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants (152); `db:seed:validation` and `db:seed:demo` twice create no duplicates
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] Canonical Bacon Cheeseburger, including the idempotent retry, passes unchanged

## 10. Risks

- **Earning depends on the hand-made link (Phase 21).** A guest whose party isn't linked before the session ends earns nothing, and there is no way to add the visit afterwards except an adjustment. Hosts need to link at seating.
- **Combined sessions.** When tables are combined, checks may belong to more than one party; each party earns only on checks carrying its own `guest_party_id`. To confirm against `move-table-session` while building.
- **Refunds don't reverse points (D11).** A refunded check keeps its points unless a manager adjusts them.
- **Outstanding points are a liability.** The report shows them, but nothing values them in money or posts them to the sales journal; the Phase 28 journal is unchanged.
- **Reward-only discounts** still appear in the voids, comps and discounts report under their own code, which is intended.

## 11. Required Phase 30 Completion Report

Write `docs/Phase-30-Completion-Report.md`:

```text
PHASE 30 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Contract change (what was lifted, what stays banned):
- Program and earning (when, basis, rates, snapshots):
- Ledger and balance (kinds, append-only, locking):
- Rewards and redemption (reward-only discounts, pending, posting at close, idempotency):
- Unlink, merge, erase, refunds, adjustments:
- Permissions, audit and boundaries:

Results
- Points earned once per finished visit from CLOSED check subtotals: PASS / FAIL
- Redemption is an ordinary discount, posted at close, retries apply nothing more: PASS / FAIL
- Balance equals the ledger after every scenario; ledger is append-only: PASS / FAIL
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
