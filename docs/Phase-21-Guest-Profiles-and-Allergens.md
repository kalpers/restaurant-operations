# Phase 21: Guest Profiles and Allergen Labeling Design and Implementation Plan

## Purpose

Phase 21 adds the first README section 39 capability, by owner decision on 2026-11-12:

- **Guest profiles.** A guest the restaurant knows across visits: name, contact details, VIP flag, preferences, notes and allergies. Profiles link to Guest Parties, and visit history is read from those links.
- **Allergen labeling.** Allergens tagged on inventory items. A menu item's allergens are worked out from its current recipe and the chosen modifiers, plus any the menu item declares by hand. The labels are snapshotted at SEND.
- **Allergy warning.** When an item's allergens match the party's (or check's) recorded allergies, the server is warned while ordering. SEND refuses the item until the server acknowledges the warning. The acknowledgment is recorded and the kitchen ticket shows an allergy alert.

Left out on purpose:

- loyalty, points, marketing consent and any guest messaging (SMS, email) — the next group, which needs its own approval
- online reservations and external integrations
- nutrition facts and calorie counts
- per-seat allergies (allergies apply to the whole party or check)
- multiple active locations, ingredient lots and forecasting
- cloud deployment (on hold)

What exists today (checked against the code on 2026-11-12):

- **Guests.** `guest_parties` (Reservations domain) holds one visit: name, phone, email, special requests, party size and status. The schema comment says the contact fields "aren't a customer profile". Nothing connects two visits by the same guest. `table_sessions.guest_party_id` and `orders.guest_party_id` link a visit to its seating and checks. Takeout orders carry only `customer_name`, a pickup label with no contact data.
- **Allergens.** Nothing. No allergen table, column or text anywhere in the code or docs. Allergies can only go in `special_requests` or an item's `special_instructions`, which are free text that nothing reads.
- **What an item contains.** `recipe_version_ingredients` lists a revision's inventory items. `applyModifierEffects` (`src/modules/recipes/rules/modifier-recipe-effects.ts`) turns those into the final inventory items after modifiers (for example, Swiss instead of American). `order_item_inventory_consumption` snapshots that result at SEND. Menu items without a recipe (a bottled beer) have no ingredient list.
- **Permissions.** 139 codes. Hosts hold `reservations.*` and `waitlist.*`. Servers hold the order codes. Nothing covers guests or allergens.

It changes these written contract points, which the owner approves with this plan:

- **Phase 6 plan, sections 6 and 7:** "Do not turn this into a customer CRM profile" and "Do not build ... customer-history profiling" are superseded for guest profiles and visit history. The bans on marketing consent and loyalty stay.
- **README section 13:** new tables for guest profiles and party allergies; Guest Party may link to a profile.
- **README section 15:** allergens, ingredient allergen tags and declared menu-item allergens join the Recipes domain.
- **README section 17:** submitted items gain an allergen snapshot and an allergy acknowledgment.
- **README section 39:** "Customer CRM/loyalty" becomes "Customer loyalty". The CRM part is built.
- **CLAUDE.md:** the Phase 21 line, and short guest and allergen policies.

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially sections 13, 14, 15, 17, 18, 20, 22 and the Phase 3, 6, 7, 8 and 9 notes in section 33.
2. Read the Phase 3, 6, 7, 8, 9 and 20 plans and completion reports. Phase 3 is the model for tiered personal data.
3. Read `docs/accepted-risks.md`. This phase should add no dependency.

## Decisions for the owner

Approved by the owner on 2026-11-12 as recommended. The policies below follow them.

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | Which module owns guest profiles? | **Reservations.** Guest Party already lives there, and the module list in CLAUDE.md stays the same. | A separate `guests` module would be an architecture change for a small set of tables. It can split later if loyalty arrives. |
| D2 | Is a profile per location or per organization? | **Per organization**, with each visit's location shown in its history. | Regulars eat at any location, and the data model is already multi-location ready. |
| D3 | How do a visit and a profile get linked? | **The host links them by hand** when booking or adding a walk-in. Matching profiles are suggested by exact normalized phone or email, or by name, but nothing links automatically. A link can be changed while the party isn't COMPLETED. | A wrong automatic match would show the wrong guest's allergies. |
| D4 | Can duplicate profiles be merged? | **Yes**, by a manager. The duplicate becomes `MERGED` and points to the kept profile. Its visits and allergies move over, and an append-only merge record is kept. Merges are never undone; a mistaken one is fixed by editing the kept profile. | Duplicates are certain once hosts create profiles at the stand. |
| D5 | What's on a profile? | **Name, phone and email (both optional, normalized), VIP flag with an optional reason, preferences (text, 500 characters), notes (text, 1000 characters) and allergies.** No birthday, address, marketing consent or spend targets. | Covers what hosts and servers use, without building loyalty. |
| D6 | How are allergies recorded? | **Against an allergen list** (seeded with the nine major US allergens: milk, eggs, fish, crustacean shellfish, tree nuts, peanuts, wheat, soybeans and sesame; managers can add more). Each allergy has a severity (`SEVERE` or `ALLERGY`) and an optional note. A free-text "other dietary needs" field is kept for things the list can't match, and it never triggers a warning. | Only listed allergens can be matched against menu items reliably. Severity changes what the server sees. |
| D7 | Whose allergies does the warning check? | **The visit's.** Allergies are recorded on the Guest Party (`guest_party_allergies`) for any party, profile or not. Linking a profile copies its allergies in, and the host or server can add more for this visit (optionally saving them to the profile). Takeout and bar orders without a party record allergies on the order itself (`order_allergies`). | Walk-ins have allergies too, and a party can include guests who have no profile. |
| D8 | Where do menu allergens come from? | **Both sources.** *Derived:* the allergens of the inventory items left after the current recipe and the chosen modifiers are applied. *Declared:* allergens a menu item lists by hand, either `CONTAINS` (for items with no recipe) or `MAY_CONTAIN` (cross-contact, such as the fryer). | Deriving keeps labels in step with recipes. Declaring covers what recipes can't show. |
| D9 | What if an ingredient's allergens were never checked? | **Each inventory item has an allergen review mark** (who and when). Until every ingredient of an item is reviewed, the item's label shows "Allergens incomplete", and the warning counts it as a possible conflict. Changing an item's tags re-stamps the review. | An empty list must never look like "allergen free". |
| D10 | Warn or block? | **Warn while adding, and require an acknowledgment at SEND.** SEND refuses a conflicting item with `ALLERGEN_ACKNOWLEDGMENT_REQUIRED` and lists the items and allergens. A retry naming those items as acknowledged sends them, and records who acknowledged and when. No manager approval is needed. | The server and guest decide (a guest may know the dish is fine). A blocking override for every case would slow service. |
| D11 | What does SEND snapshot? | **`order_item_allergens`**: each allergen's code and name, `CONTAINS` or `MAY_CONTAIN`, and whether it was derived or declared, plus whether the label was incomplete. Kitchen and bar ticket items get an `allergy_alert_snapshot` text ("ALLERGY: Peanuts (severe)") when the item was acknowledged against an allergy. All of it is frozen. | Rule 4: what the guest was told, and what the kitchen saw, must not change when a recipe changes later. |
| D12 | What happens when a guest asks to be forgotten? | **Erase the profile.** A manager action clears its name (to "Erased guest"), contact details, preferences, notes and allergies, and marks it `ERASED`. Contact fields on its past Guest Parties are cleared too. Visits, orders and snapshots stay, so reports still add up. | Lets the restaurant honor a deletion request without deleting history. |
| D13 | Who can see what? | **Four tiers**, following the Phase 3 HR pattern: see the table in policy 19. Allergies a server needs to serve the table are always shown on the order screen to anyone who can view the order, without `guests.view`. | Allergy information is a safety matter at the table. The guest directory isn't. |
| D14 | What is audited? | **Profile create, edit, VIP change, link, merge and erase; allergy changes on a profile; allergen tags and reviews on inventory items; declared menu allergens; and acknowledgments at SEND.** Audit rows record which fields changed, never the values of contact details, notes or allergies. | Health and contact data stay out of the audit log, as Phase 6 required for contact data. |
| D15 | What does visit history show? | **Worked out on read** from linked parties: each visit's date, location, party size, status (seated, cancelled, no-show) and, for seated visits, the checks' item names and `total_due` from their snapshots. A summary line shows visit count, last visit, no-shows and average spend. | Rule 4: from snapshots only. No stored counters to get out of step. |
| D16 | Are guest reports added? | **No new report area.** The seating report gains a "returning guests" count (seated parties linked to a profile with an earlier seated visit). | Enough to see the profiles being used, without guest analytics. |

## Approved Phase 21 Policies

Binding since the owner approved D1–D16 on 2026-11-12.

### A. Guest profiles

1. **Table (D1, D2, D5).**
   - `guest_profiles` (Reservations): organization, `profile_number` (human-readable, per organization), `display_name` (required), `phone`, `phone_normalized` (digits only, with a leading `+` kept), `email`, `email_normalized` (the auth normalization: NFKC, trim, lowercase), `vip`, `vip_reason`, `preferences`, `notes`, `other_dietary_needs`, `status` (`ACTIVE`, `MERGED`, `ERASED`), `merged_into_profile_id`, `version`.
   - Phone and email are not unique (families share them). An index on each normalized value serves lookups.
   - Text limits are CHECK constraints. Phone, email and notes refuse 13 or more consecutive digits other than the phone itself (the card-safety rule).
   - A `MERGED` or `ERASED` profile can't be edited, linked or merged again (guard trigger).
2. **Linking (D3).**
   - `guest_parties.guest_profile_id` is a new nullable foreign key. The reservation and walk-in forms gain a guest picker with search and "new profile".
   - Suggestions: an exact normalized phone or email match first, then name contains, ACTIVE profiles only, at most 10.
   - Linking, changing and unlinking need `guests.manage` and the party's `version`. They're refused once the party is COMPLETED, CANCELLED or NO_SHOW.
   - Linking never copies contact details either way. The party keeps its own fields for this visit.
3. **Merge (D4).**
   - `POST /api/guests/{id}/merge` (`guests.merge`) takes the kept profile, both versions and a reason.
   - In one transaction: the duplicate's parties are relinked, allergies missing on the kept profile are added (the more severe wins on a clash), the duplicate becomes `MERGED` with `merged_into_profile_id`, and a `guest_profile_merges` row (append-only) records both IDs, the counts moved, the reason and who did it.
   - Text fields aren't combined. The manager edits the kept profile if needed.
4. **Erase (D12).**
   - `POST /api/guests/{id}/erase` (`guests.erase`) with the version and a reason.
   - One transaction: profile name becomes "Erased guest", all other personal fields are nulled, its allergies are deleted (the one delete in this phase, allowed by its guard only inside erase), status `ERASED`. Linked Guest Parties get `phone`, `email` and `special_requests` nulled, and `guest_name` set to "Erased guest". Party allergies of linked parties are deleted.
   - Orders, snapshots, sessions, audit and party status history are untouched. Takeout `customer_name` labels aren't linked to profiles, so they aren't touched.
5. **Visit history (D15).** A query in Reservations reads linked parties, their sessions and those sessions' orders, using order snapshots and totals only. Average spend is over CLOSED, non-voided checks. It's location-aware and shows times in each visit's location time zone.

### B. Allergies

6. **Allergen list (D6).**
   - `allergens` (Recipes): organization, `code` (org-unique), `name`, `display_order`, `active`. Configurable, deactivated rather than deleted.
   - An idempotent seed `recipes.allergen-foundation` adds the nine major allergens to each organization.
7. **Profile allergies (D6).** `guest_profile_allergies`: profile, allergen, `severity` (`SEVERE` or `ALLERGY`), `note` (200 characters), unique per profile and allergen. Changed under `guests.manage` with the profile's version.
8. **Visit and check allergies (D7).**
   - `guest_party_allergies`: party, allergen, severity, note, `source` (`PROFILE` or `RECORDED`), who recorded it and when. Unique per party and allergen.
   - Linking a profile copies its allergies in as `PROFILE` rows. Unlinking removes the `PROFILE` rows and keeps `RECORDED` ones.
   - Hosts (`guests.manage`) and servers (`orders.edit`) may add or remove a party allergy while the party isn't finished. The server may tick "save to profile" when the party is linked and the server holds `guests.manage`.
   - `order_allergies`: the same shape, for an OPEN order with no guest party (takeout, a bar tab), under `orders.edit`.
   - Changing an allergy re-evaluates the warning on the order screen. It never changes items already sent.

### C. Allergen labels

9. **Ingredient tags (D9).**
   - `inventory_item_allergens`: inventory item, allergen. Owned by Recipes, like `recipe_version_ingredients`.
   - `inventory_items` gains `allergens_reviewed_at` and `allergens_reviewed_by_user_id`. Saving an item's tags (even an empty set) stamps the review. Inventory still owns stock; the tags don't touch the ledger.
10. **Declared allergens (D8).** `menu_item_allergens`: menu item, allergen, `kind` (`CONTAINS` or `MAY_CONTAIN`), unique per item and allergen.
11. **The label (D8, D9).**
    - One pure rule, `resolveItemAllergens`, in `src/modules/recipes/rules/`: from the final requirements (`applyModifierEffects` output), the ingredient tags and review marks, and the declared allergens, it returns each allergen with `CONTAINS` or `MAY_CONTAIN`, `DERIVED` or `DECLARED`, and `incomplete` (any ingredient not reviewed).
    - `CONTAINS` wins over `MAY_CONTAIN` for the same allergen. An item with no recipe and no declarations is `incomplete`.
    - The order screen and the menu item page both call it through one query, so the label shown is the label SEND snapshots.
    - The menu item page shows the label for the base recipe; the order screen shows it for the chosen modifiers.

### D. Warning and SEND

12. **Conflict rule (D9, D10).** An item conflicts when one of its `CONTAINS` or `MAY_CONTAIN` allergens is in the order's allergies (the party's, or the order's own), or when its label is `incomplete` and the order has any allergy. A pure rule, `findAllergenConflicts`, returns the conflicting items with the matched allergens and the highest severity.
13. **While ordering.** The draft list and the item editor show the conflict next to the item (severe in the danger color). The check header shows the party's allergies. No request is refused while drafting.
14. **At SEND.**
    - The canonical SEND transaction gains a step after recipe resolution: resolve each item's allergens, find conflicts, and refuse with `ALLERGEN_ACKNOWLEDGMENT_REQUIRED` (422, listing items and allergens) when a conflicting item isn't in the request's `acknowledgedAllergenItemIds`.
    - The refusal happens before any write, so nothing is stored for it. The idempotency record isn't stored for a refused request, so the acknowledged retry may reuse the same key. (Confirm from `sendOrderItems` before building; if the key's first outcome is already stored at that point, stop and raise it.)
    - On success, `order_item_allergens` rows are written for every sent item. Acknowledged items also get `allergy_acknowledged_by_user_id`, `allergy_acknowledged_at` and `allergy_conflict_snapshot` (the matched allergens and severity), all added to the `order_items_freeze` trigger.
    - Kitchen and bar ticket items of acknowledged items get `allergy_alert_snapshot`, shown at the top of the ticket item in the danger color.
    - A retry with the same key returns the first outcome, with no second set of allergen rows.
15. **Moves and shares.** Item moves and shared items (Phases 17 and 20) keep the item's allergen snapshot and acknowledgment. A move to a check whose allergies conflict doesn't need a new acknowledgment, because the food was already made; the moved item is flagged on the target check's screen.

### E. Screens

16. **Guests page** (`/host/guests`, under `guests.view`): search, profile view (summary, allergies, preferences, visit history), edit, VIP, merge and erase where permitted. Contact fields appear only with `guests.contact.view`.
17. **Host stand.** The reservation and walk-in forms gain the guest picker and visit allergies. The reservation list, waitlist and floor plan show a VIP mark and an allergy mark (allergen names, no notes) for linked or flagged parties.
18. **Recipes and menu.** The inventory item page gains allergen tags and the review mark (under `recipes.allergens.manage`). The menu item page shows the derived label and edits declared allergens. A new "Allergens" admin list manages the allergen list. A "Needs allergen review" filter lists unreviewed ingredients used by active recipes.

### F. Permissions, audit and boundaries

19. **Permissions (D13).** Six new codes, 145 in all, seeded by an idempotent `security.guest-profiles-permissions` seed:

    | Code | Covers | Granted to |
    |---|---|---|
    | `guests.view` | Search and view profiles, visit history, allergies, preferences, notes | Owner, General Manager, Manager, Host, Server, Bartender, Wait Staff |
    | `guests.contact.view` | Profile phone and email | Owner, General Manager, Manager, Host |
    | `guests.manage` | Create and edit profiles, VIP, profile allergies, link and unlink | Owner, General Manager, Manager, Host |
    | `guests.merge` | Merge duplicates | Owner, General Manager, Manager |
    | `guests.erase` | Erase a profile | Owner, General Manager |
    | `recipes.allergens.manage` | The allergen list, ingredient tags and reviews, declared menu allergens | Owner, General Manager, Manager, Inventory Manager |

    Party and order allergies use `guests.manage` or `orders.edit` as in policy 8. Allergens on the order screen and on tickets need only the permission to view that order or ticket.
20. **Audit (D14).** New actions:
    - `guests.profile-created`, `guests.profile-updated` (field names only), `guests.vip-changed`, `guests.allergies-changed` (allergen codes added and removed, no notes), `guests.party-linked`, `guests.party-unlinked`, `guests.profile-merged`, `guests.profile-erased`;
    - `recipes.ingredient-allergens-changed` (item code, allergen codes before and after), `recipes.menu-item-allergens-changed`, `recipes.allergen-changed`;
    - `orders.allergen-acknowledged` (order, item, allergen codes, severity).
    - A new `GUESTS` audit category. Contact details, notes and preferences never appear in audit rows or logs.
21. **Outbox.** `guest-party.allergies-changed` (so the floor and order screens refresh), and the acknowledgment rides on the existing `order.items-submitted` event. No guest contact data in event payloads.
22. **Rules 4, 6 and 7.** No Phase 21 path writes inventory ledger rows. Allergen snapshots are written once at SEND and frozen. Labels shown later for sent items come from the snapshot, never the current recipe. Visit history reads snapshots.
23. **Not CRM marketing.** No consent, messaging, loyalty or export of guest lists. Reports CSV export doesn't include guest names or contact details.

## Amendments decided at implementation

Recorded on 2026-11-12 while building. None changes a decision; each says how a policy was carried out.

1. **Ingredient review marks live in a Recipes table** (`ingredient_allergen_reviews`), not as columns on `inventory_items` (policy 9), so the Inventory domain's table stays Inventory's.
2. **Menu items have a review mark too** (`menu_item_allergen_reviews`, policy 11). Without it an item with no recipe, such as bottled water, could never be labeled complete. Saving its declarations, even none, is the review.
3. **The outbox event is `guest.allergies-changed`** (policy 21). The event-name format allows one word before the dot, so `guest-party.allergies-changed` was refused.
4. **Erasing reaches merged duplicates** (policy 4). A MERGED profile is otherwise frozen, so it would have kept the guest's data. Erase clears every profile merged into the one erased, through any chain. The guard lets a MERGED profile change once more, only to erased values, and the erase CHECK allows an erase time on a MERGED profile.
5. **The snapshot guard checks the send batch** (policy 14). `order_item_allergens` rows may be inserted only for an item whose send batch was created in the same transaction, because `submitted_at` is set in application time, not the database's `now()`.
6. **Contact details can't be probed or wiped** (policy 19). Search matches phone and email only for `guests.contact.view` holders. An editor without it keeps the stored phone and email when saving the profile form.
7. **Profile allergy edits follow to open visits** (policy 8). Saving a profile's allergies refreshes the `PROFILE` allergies of its unfinished linked visits; `RECORDED` ones stay.
8. **The seat-now walk-in path links a profile too** (policy 2), as well as reservation and waitlist creation.
9. **Moves and shares** (policy 15). Items move only between checks on one table session, which share one party and one set of allergies, so a moved item can't meet new allergies and no extra flag was needed. Snapshots and the acknowledgment are keyed by the item, so they move with it.
10. **Migrations.** Step 1 has its own migration (`0048`); steps 2 to 5 share one generated migration (`0049`) and one custom guards migration (`0050`), so the same tables weren't regenerated several times.
11. **The host tab row wraps**, so the new Guests tab fits at phone width.

## Later amendment (Phase 22, 2026-11-12)

Phase 22 supersedes this plan's exclusion of guest messaging and consent ("Left out on purpose", policy 23): guests may now get email and SMS service messages about their own visit, with consent recorded per visit and channel (`guest_party_message_consents`) and an opt-out list. Erase (policy 4) now also clears consents, message addresses and bodies, and manage links. Loyalty, marketing and guest list export are still out. See `docs/Phase-22-Online-Reservations-and-Guest-Messaging.md`.

## 1. Objectives

Deliver policies 1–23, the migrations, the tests in sections 5–7, README, CLAUDE.md and User Guide updates, and `docs/Phase-21-Completion-Report.md`.

## 2. Scope Boundary

Out of scope (don't build):

- Loyalty, points, marketing consent, guest messaging, guest list export
- Online reservations and external integrations
- Nutrition facts and calories; ingredient lots and expiry
- Per-seat allergies; linking a profile to a takeout order
- Automatic profile matching or merging
- Multiple active locations, forecasting, cloud deployment (on hold)

## 3. Review Existing Foundation Before Changes

Confirm from code before each step:

- `party-repository.ts`, `reservation-service.ts` and `waitlist-service.ts` for where parties are created, edited and finished, and the guest party guard (if any).
- `sendOrderItems` (`src/workflows/submit-order/submit-order.ts`): the order of its steps, and when the idempotency record is written (policy 14).
- `applyModifierEffects` and `resolveCurrentRequirementsForMenuItems`, so the label uses the same requirements SEND consumes.
- `order_items_freeze` and the kitchen ticket item freeze trigger, for the new snapshot columns.
- `moveOrderItems` and the share service, so snapshots move with items (policy 15).
- The audit category and action CHECKs, the outbox event name CHECK and `audit-actions.ts`.
- The seating report query, for the returning guests count.

If any conflicts with the policies, stop and explain before changing it.

## 4. Build Order

Migrations start at 0048. Each step generates its own migration (plus a custom one for triggers and guards), reviewed before applying, and leaves lint, typecheck, unit and integration tests green.

1. **Allergen foundation:** `allergens`, ingredient tags and review mark, declared menu allergens, the seed, `resolveItemAllergens`, and the recipes and menu screens.
2. **Guest profiles:** the table, permissions seed, search, create and edit, the Guests page, audit.
3. **Linking and visits:** party link, guest picker on the host forms, visit history, VIP and allergy marks on the host screens.
4. **Visit and check allergies:** `guest_party_allergies`, `order_allergies`, copy on link, the order screen warnings.
5. **SEND:** the conflict check, acknowledgment, `order_item_allergens`, ticket alert, freeze triggers, moves and shares.
6. **Merge and erase.**
7. **Reports, E2E, validation seed additions, documentation and the completion report.**

## 5. Unit Tests

- *Label:* derived from a recipe; a modifier that removes the only source of an allergen; a substitution that adds one (Swiss instead of American keeps milk); declared `MAY_CONTAIN` with derived `CONTAINS`; an unreviewed ingredient makes it incomplete; no recipe and no declarations is incomplete.
- *Conflicts:* match by allergen; highest severity wins; incomplete label with any allergy; no allergies means no conflicts.
- *Normalization:* phone digits and `+`; email NFKC, trim and lowercase; the card-digit refusal.
- *Merge:* allergy combination keeps the more severe.

## 6. Integration Tests

- **Profiles:** create, edit with a stale version (conflict), contact fields hidden without `guests.contact.view`, search suggestions, `MERGED` and `ERASED` frozen.
- **Linking:** link and unlink with the right permission; refused on a finished party; profile allergies copied and removed on unlink, recorded ones kept.
- **Visit history:** visits across two locations; totals from snapshots unchanged after a price change; no-shows counted.
- **SEND:** a conflicting item without acknowledgment is refused with nothing written (no ledger rows, tickets or snapshots); the acknowledged retry with the same key sends once; allergen snapshot and ticket alert frozen; a later recipe or tag change leaves sent snapshots unchanged; a takeout order's own allergies trigger the check.
- **Moves and shares:** allergen snapshot and acknowledgment travel with the item.
- **Merge and erase:** parties relinked; erase clears profile and linked party contact fields and allergies, leaves orders and totals intact, writes no contact data to audit.
- **Permissions:** every new API refuses without its permission; a server sees party allergies on the order without `guests.view`.
- **Canonical scenario:** the Bacon Cheeseburger test passes unchanged with no allergies recorded, and a variant with a milk allergy needs the acknowledgment (cheese) and records it.
- **Migrations:** reconstruction and the upgrade-from-Phase-20 checks; existing parties have no profile; existing inventory items are unreviewed.
- **Seeds:** the allergen and permission seeds run twice without duplicates.

## 7. E2E Tests (Playwright)

- **New `guest-profiles.spec.ts`:** a host books a reservation for a new profile with a peanut allergy; seats it; the server sees the allergy, adds a dish containing peanuts, is warned, acknowledges and sends; the kitchen ticket shows the alert; the profile's visit history shows the visit after close.
- **Allergen setup:** tag an ingredient, see the menu item's label update, and see "Allergens incomplete" for an unreviewed ingredient.
- **Merge and erase** by a manager.
- **Every existing spec** still passes.

## 8. Documentation

- **README sections 13, 15, 17, 18, 20 and 39:** the policies as built.
- **README section 33:** a "Phase 21 Guest Profiles and Allergens" note. **Section 36 and the CLAUDE.md phase list:** Phase 21, plus short guest and allergen policies in CLAUDE.md.
- **Phase 6 plan:** an amendment noting the superseded CRM lines.
- **`docs/User-Guide.md`:** guest profiles, allergies at the host stand and on the order screen, acknowledgment, allergen setup.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` (stop `npm run dev` first)
- [ ] `npm run build`
- [ ] `npm audit --omit=dev` clean (no dependency added)
- [ ] Migrations generated, reviewed and committed; `npm run db:generate` then reports no changes
- [ ] Migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions, grants or allergens
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] The canonical Bacon Cheeseburger test passes unchanged
- [ ] No inventory ledger row is written by any Phase 21 code path
- [ ] No contact data, notes or allergy notes in audit rows, logs or outbox payloads

## 10. Required Phase 21 Completion Report

Write `docs/Phase-21-Completion-Report.md`:

```text
PHASE 21 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Guest profiles (table, linking, merge, erase, visit history):
- Allergies (list, profile, visit and check):
- Allergen labels (tags, review, declared, label rule):
- Warning and SEND (conflicts, acknowledgment, snapshots, tickets):
- Screens:
- Permissions, audit and boundaries:

Results
- Labels derived from recipe and modifiers; incomplete when unreviewed: PASS / FAIL
- SEND refuses unacknowledged conflicts with nothing written: PASS / FAIL
- Acknowledged retry sends once; snapshots frozen: PASS / FAIL
- Contact data hidden without guests.contact.view: PASS / FAIL
- Erase clears personal data and keeps history: PASS / FAIL
- No contact or health data in audit, logs or outbox: PASS / FAIL
- Canonical Bacon Cheeseburger unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
