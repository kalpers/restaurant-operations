# Phase 21 Completion Report: Guest Profiles and Allergens

## Summary

Phase 21 builds the CRM part of README section 39 together with allergen labeling, as the owner chose on 2026-11-12 (plan approved with D1–D16 as recommended). Plan: `docs/Phase-21-Guest-Profiles-and-Allergens.md`, with 11 implementation amendments.

- **Guest profiles.** Organization-wide profiles in the Reservations module: name, optional phone and email (normalized for lookup), VIP flag, preferences, notes, other dietary needs and allergies. A host links a visit (Guest Party) to a profile by hand when booking, adding a walk-in or seating one at once, or later from the card's **Guest & allergies** panel. Visit history is read from linked parties and order snapshots. Duplicates are merged by a manager, and a guest can be erased.
- **Allergen labels.** The organization's allergen list (seeded with the nine major US allergens), ingredient tags with a review mark, and allergens declared by hand on a menu item (contains or may contain). One rule builds every label from the ingredients left after the current recipe and the chosen modifiers. An unreviewed ingredient makes the label "Allergens incomplete", never "allergen free".
- **Allergy warning.** The order screen shows the party's allergies (or a takeout or bar check's own), each item's label, and a red warning on a conflicting item. SEND refuses such an item with `ALLERGEN_ACKNOWLEDGMENT_REQUIRED` and writes nothing. The server confirms in a dialog and the retry reuses the same idempotency key. The confirmation is frozen on the item, and the kitchen ticket shows the allergy alert.
- **Contract changes approved with the plan.** README sections 13, 15, 17, 18, 20, 21, 33, 36 and 39, CLAUDE.md, and an amendment to the Phase 6 plan, which had ruled out customer profiles.

## Environment

- Node 26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker), Windows 11
- No dependency added. `npm audit --omit=dev`: 0 vulnerabilities.

## Policies (as built)

- **Guest profiles (table, linking, merge, erase, visit history).**
  - `guest_profiles`: per-organization `profile_number` from `guest_profile_number_counters`; ACTIVE, MERGED or ERASED, guarded by a trigger; length CHECKs; free text refuses 13 or more digits in a row.
  - Linking: `guest_parties.guest_profile_id`, by hand, refused once the party is finished. It replaces an earlier link and copies the profile's allergies onto the visit as `PROFILE` rows. Search tries phone or email first (only for `guests.contact.view`), then names, at most 10 results.
  - Merge (`guests.merge`): moves visits and missing allergies (the more severe one wins), marks the duplicate MERGED and writes an append-only `guest_profile_merges` row. It is never undone.
  - Erase (`guests.erase`, Owner and General Manager):
    - clears the profile, every profile merged into it (through any chain) and its visits' names, contact details, requests and allergies;
    - keeps orders, sessions, snapshots and audit.
  - Visit history (`getGuestVisits`): date, location, party size, status, checks with item names and `total_due` from snapshots, and a summary of visits, last visit, no-shows, cancellations and average spend.
- **Allergies (list, profile, visit and check).**
  - `allergens`, seeded by `recipes.allergen-foundation`.
  - `guest_profile_allergies` (severity `SEVERE` or `ALLERGY`, plus a note).
  - `guest_party_allergies`: the visit's allergies, recorded by hosts under `guests.manage` or servers under `orders.edit`, with "save to profile" for `guests.manage` holders. Profile edits refresh the `PROFILE` rows of open visits.
  - `order_allergies`: the check's own allergies when it has no party; refused on a party's check (`ORDER_HAS_PARTY`).
- **Allergen labels (tags, review, declared, label rule).**
  - Storage: `inventory_item_allergens` with `ingredient_allergen_reviews`, and `menu_item_allergens` with `menu_item_allergen_reviews`. Saving a list, even an empty one, replaces it and stamps the review, version-checked.
  - `resolveItemAllergens`: contains wins over may-contain, and derived wins over declared. A label is incomplete while any ingredient is unreviewed, or, when the item has no ingredients, until its declarations are reviewed.
  - The order screen, the menu item page and SEND all build labels from the same requirements (`applyModifierEffects`).
- **Warning and SEND (conflicts, acknowledgment, snapshots, tickets).**
  - `findAllergenConflicts`: a match of either kind, or an incomplete label while the order has any allergy; the highest severity is reported.
  - SEND checks after recipe and modifier resolution and refuses unacknowledged conflicts before any write. `acknowledgedAllergenItemIds` joins the idempotency fingerprint only when present, so earlier keys still match.
  - Every sent item gets `allergen_label_incomplete_snapshot` and its `order_item_allergens` rows. Confirmed items also get who confirmed, when, and what the conflict was (`allergy_conflict_snapshot`).
  - Ticket items carry `allergy_alert_snapshot`, and remakes keep it.
  - Audit: `orders.allergen-acknowledged`. All of these are frozen by triggers.
- **Screens.**
  - Host stand: a guest picker on reservation and walk-in creation, VIP and allergy marks, and the **Guest & allergies** panel. Host tabs gain **Guests**.
  - Guests pages (`/host/guests` and each profile): search, create, edit, allergies, visits, merge (found by search) and erase.
  - Order screen: an **Allergies** box, item labels, warnings and the confirm-before-send dialog.
  - Kitchen display: the alert on the ticket item.
  - Back of house: allergen tags on the inventory item page, the label and declarations on the menu item page, and an **Allergens** page (the allergen list and ingredients needing review).
  - Seating report: a **Guests** section (seated parties, those with a profile, returning guests).
- **Permissions, audit and boundaries.**
  - Six new codes, 145 in all: `guests.view`, `guests.contact.view`, `guests.manage`, `guests.merge`, `guests.erase` and `recipes.allergens.manage`, seeded by `security.guest-profiles-permissions` with the plan's role grants.
  - Audit adds a new `GUESTS` category and 12 actions; guest rows hold field names and allergen codes only.
  - Outbox: `guest.allergies-changed`.
  - No Phase 21 path writes inventory ledger rows.

## Results

| Check | Result |
|---|---|
| Labels derived from recipe and modifiers; incomplete when unreviewed | PASS |
| SEND refuses unacknowledged conflicts with nothing written | PASS |
| Acknowledged retry sends once; snapshots frozen | PASS |
| Contact data hidden without guests.contact.view | PASS |
| Erase clears personal data and keeps history | PASS |
| No contact or health data in audit, logs or outbox | PASS |
| Canonical Bacon Cheeseburger unchanged | PASS |

The canonical scenario: the existing Bacon Cheeseburger tests pass unchanged. With the burger's ingredients tagged, the canonical selections (Swiss instead of American) snapshot milk, sesame and wheat. A milk allergy on the party requires the confirmation, and the confirmed retry with the same key produces one send.

## Architectural decisions

The 11 amendments are recorded in the plan. The main ones:

1. The review marks are kept in Recipes tables, so `inventory_items` stays the Inventory domain's.
2. Menu items have their own review mark, so an item with no recipe can be labeled complete.
3. The event name is `guest.allergies-changed`, because the event-name format allows one word before the dot.
4. Erase reaches merged duplicates. Without this, a merge would have kept the guest's data forever.
5. The snapshot guard keys on the send batch created in the transaction, because `submitted_at` is set by the application.
6. Search by phone or email needs the contact permission, and an editor without it can't wipe stored contact details.

The Orders module reads the Reservations party facts through `loadPartyGuestFacts`, a query and not a mutation, the same way it already reads the restaurant session.

## Migrations

| Migration | Contents |
|---|---|
| `0048_guest_allergens_foundation.sql` (generated) | `allergens`, `inventory_item_allergens`, `ingredient_allergen_reviews`, `menu_item_allergens`, `menu_item_allergen_reviews` |
| `0049_guest_profiles.sql` (generated) | `guest_profile_number_counters`, `guest_profiles`, `guest_profile_allergies`, `guest_profile_merges`, `guest_party_allergies`, `order_allergies`, `order_item_allergens`; `guest_parties.guest_profile_id`; the four `order_items` allergy columns and their CHECK; `kitchen_ticket_items.allergy_alert_snapshot`; the `GUESTS` audit category |
| `0050_guest_profiles_guards.sql` (custom) | `guest_profiles_guard`, `guest_profile_merges_guard`, `order_item_allergens_guard`; `order_items_freeze` and `kitchen_ticket_items_guard` replaced with the new columns added |

After them, `npm run db:generate` reports no changes. Applied to the local dev database with `npm run db:migrate`.

## Validation results

| Check | Result |
|---|---|
| `npm run lint` | Clean |
| `npm run typecheck` | Clean |
| `npm run test:unit` | 836 passed |
| `npm run test:integration` | 1323 passed across 87 files (final runs) |
| `npm run test:e2e` (CI mode, fresh build) | 152 passed, 0 failed, 0 flaky (4.8 min) |
| `npm run build` | Succeeds |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migration reconstruction and upgrade tests | Pass, including a new "upgrading a Phase 20 database" seed test |
| `npm run db:seed` twice | First run: 2 applied, 23 already applied. Second run: 0 applied, 25 already applied. |
| `db:reset` safeguards | `database-safety.test.ts` passes, unchanged |
| No inventory ledger row from Phase 21 code | Pass (refused SEND leaves the ledger count unchanged; no Phase 21 service posts) |

How the runs went:

- **First full integration run:** 18 tests failed and about 30 files failed in setup or cleanup. The shared test cleanup deleted guest parties before their new allergy rows, and the seed and migration tests had hard-coded permission counts and table lists. The cleanup now clears guest data first (with the guards lifted for its own transaction), and the counts and lists were updated. A generated foreign key name of 65 characters was replaced with a short explicit one.
- **Second run:** only `foundation-seeds.test.ts` failed, on more hard-coded counts. Those were updated, and the file passed (29 of 29) in a run of its own.
- **First full E2E run:** 3 phone-width tests failed, because the new Guests tab made the host tab row overflow. The row now wraps.
- **Build warning:** `node:crypto` loaded in the Edge Runtime, traced from `instrumentation.ts` through the Phase 20 maintenance run. No Phase 21 file is involved and the build succeeds.

## Tests executed

- **Unit (14 new):**
  - `allergen-label.test.ts` (9): derived labels, modifiers, declared versus derived, incomplete, conflicts, severity, ticket text.
  - `guest-contact.test.ts` (5): phone and email normalization, the card-digit rule, phone-like search.
- **Integration (17 new, plus an upgrade test):**
  - `recipes/allergens.test.ts` (5): labels, review marks, stale versions, inactive allergens, permission, audit codes.
  - `orders/allergens.test.ts` (5):
    - the snapshot at SEND, and refusal with nothing written;
    - the confirmed retry with the same key, replayed once;
    - the ticket alert and audit, and frozen snapshots after a tag change;
    - takeout check allergies with an incomplete label, and `ORDER_HAS_PARTY`.
  - `reservations/guest-profiles.test.ts` (7):
    - numbering, normalization and contact hiding;
    - card digits, versions and permissions;
    - link, unlink and visit allergies, and following profile edits;
    - refusing a finished visit, and visit history;
    - merge (severity, frozen duplicate), and erase through a merge with no contact data in audit.
  - `foundation-seeds.test.ts`: "upgrading a Phase 20 database" (codes, grants, nine allergens, run twice).
- **E2E (3 new, in `guest-profiles.spec.ts`):**
  1. A host creates a walk-in with a new profile and a severe peanut allergy saved to the profile. The server sees the warning, confirms in the dialog and sends. The kitchen sees the alert, and the profile shows the visit.
  2. A manager sees "Allergens incomplete" and declares wheat.
  3. A manager merges a duplicate found by search, and the owner erases the guest; the manager can't.

## Files changed

- **Schema and migrations:** `src/db/schema/allergens.ts` (new), `guest-parties.ts`, `orders.ts`, `kitchen.ts`, `auditing.ts`, `index.ts`; `drizzle/migrations/0048`–`0050` with snapshots and journal.
- **Seeds and permissions:** `src/db/seeds/guest-profiles-permissions.ts` (new), `registry.ts`; `permission-catalog.ts`, `role-catalog.ts`, `audit-actions.ts`.
- **Recipes:** `rules/allergen-label.ts` (+ test), `queries/allergen-facts.ts`, `services/allergen-service.ts`, validators.
- **Reservations:** `rules/guest-contact.ts` (+ test), `services/guest-access.ts`, `guest-profile-service.ts`, `party-allergy-service.ts`, `queries/guest-visits.ts`; reservation and waitlist services (profile on creation, guest facts on views); validators.
- **Orders, kitchen and workflows:**
  - Orders: `services/order-allergy-service.ts`, `queries/order-allergens.ts`, `order-queries.ts` (allergy context), validators.
  - Workflows: `submit-order.ts`, `seat-guest-party.ts`, `remake-order-item.ts`.
  - Kitchen: `ticket-generation.ts`, `kitchen-queries.ts`.
  - Reporting: `seating-report.ts`.
- **API routes:** `api/guests/**`, `api/guest-parties/[partyId]/{profile,allergies}`, `api/orders/[orderId]/allergies/**`, `api/recipes/allergens/**`, `api/inventory/items/[itemId]/allergens`, `api/menu/items/[itemId]/allergens`.
- **Pages and components:**
  - Pages: `host/guests/**`, `recipes/allergens`, the inventory item and menu item pages, the order page, and the host and floor pages.
  - Components: `components/allergens/*`, `orders/allergy-panel.tsx`, `order-workspace.tsx`, `reservations/{guest-picker,party-guest-panel,profile-allergies-form,merge-profile-form,reservations-board,waitlist-board,host-tabs}.tsx`, `kitchen/kds-board.tsx`, navigation and icons, `realtime-provider.tsx`.
- **Tests:**
  - New: the files listed above, plus `tests/fixtures/allergen-fixtures.ts`, `tests/helpers/e2e-guests.ts` and `tests/e2e/guest-profiles.spec.ts`.
  - Updated: `order-cleanup.ts`, `employee-fixtures.ts`, `migrations.test.ts`, `foundation-seeds.test.ts`, `seed-framework.test.ts`, `navigation.test.ts`, `auth.test.ts`.
- **Docs:** `README.md`, `CLAUDE.md`, `docs/User-Guide.md`, `docs/Phase-6-Reservations-Waitlist.md` (amendment), the Phase 21 plan (approval and amendments), this report.

## Risks

- **Labels are only as good as the data.** An item is marked incomplete until its ingredients are reviewed, but a wrong tag on a reviewed ingredient gives a wrong label. The Allergens page lists unreviewed ingredients; nothing checks tags against a supplier's spec.
- **Allergies apply to the whole party.** A table of six with one allergic guest warns on every matching item for the table, which errs toward warning.
- **The card-digit rule is the existing one:** 13 or more consecutive digits. A number typed with spaces passes, as in earlier phases.
- **Profiles are organization-wide,** so with more locations every host can find every guest. Contact details are still limited to `guests.contact.view`.
- **Erase is irreversible** and limited to Owner and General Manager. Its free-text reason is kept in the audit row; the screen tells staff not to put the guest's name in it.

## Remaining issues

- The Phase 13 validation fixture (`db:seed:validation`) and the demo seed weren't extended with profiles or allergen tags.
- There is no dedicated test for moving or sharing an acknowledged item. The snapshots are keyed by the item and moves stay within one session's party (amendment 9), but no test proves it.
- The `node:crypto` Edge Runtime build warning from Phase 20's maintenance import chain is unchanged.
- Dev-server E2E runs weren't repeated; the runs above were in CI mode.

## Next-phase readiness

Phase 21 is complete pending owner review of this report. No Phase 22 is scheduled. The remaining README section 39 groups the owner discussed on 2026-11-12 are:

- online reservations with email and SMS, which needs an architecture decision for an outside message provider behind the outbox;
- multiple active locations with ingredient lots and expiry;
- demand forecasting.

Guest profiles now provide the contact details and identity the first of those would need, but no messaging consent has been recorded. Cloud deployment remains on hold.
