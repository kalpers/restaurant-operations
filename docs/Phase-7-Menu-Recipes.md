# Phase 7: Menu & Recipes Implementation Plan

## Purpose

Phase 7 implements the Menu and Recipe foundation for the Restaurant Operations Management System. It defines what the restaurant sells, how items are organized and priced, which modifiers may be selected, how items route operationally for preparation, and how recipe quantities are represented for future Phase 8 Inventory consumption.

Before starting, read:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/accepted-risks.md`
4. All Phase 0 through Phase 6 implementation plans
5. This document

`README.md` remains the architectural source of truth.

Phase 7 must preserve all completed Phase 0 through Phase 6 architecture. In particular, Menu, Recipe, Inventory, Orders, and Kitchen fulfillment remain separate domains with explicit boundaries.

---

## 1. Phase 7 Objectives

Implement the Menu and Recipe domain:

```text
Menu Category
    |
    +-- Menu Item
                 +-- Menu Item
          |
          +-- Effective Price History
          |
          +-- Modifier Groups
          |      |
          |      +-- Modifiers
          |
          +-- Recipe
                 |
                 +-- Immutable Recipe Revisions
```

Also establish preparation-routing configuration needed by later Order/Kitchen phases without implementing Kitchen tickets.

Phase 7 must deliver:

- Menu categories
- Menu items
- Effective-dated menu pricing
- Modifier groups
- Modifiers
- Menu-item-to-modifier-group assignments
- Modifier selection constraints
- Modifier price adjustments
- Modifier preparation effects
- Unit-of-measure/reference foundation required for recipes
- Recipes
- Immutable Recipe identity and revision/history strategy
- Structured Modifier Recipe-effect contracts for future component deltas
- Preparation stations/routing configuration as approved by the architecture
- Menu and recipe query models
- Menu/recipe administration UI
- Menu/recipe RBAC
- Idempotent Phase 7 reference/configuration seeds
- Unit, PostgreSQL integration, and Playwright E2E coverage

---

## 2. Scope Boundary

Do not implement during Phase 7:

```text
inventory on-hand quantities
inventory transaction ledger
inventory receiving
inventory counts
inventory adjustments
waste transactions
suppliers
purchase orders
supplier pricing
weighted-average inventory costing
orders
order items
order modifier selections
kitchen tickets
bar tickets
settlements
customer pricing/tax calculation engine
full reporting
```

Phase 8 owns Inventory & Purchasing.

Phase 9 owns Orders.

Phase 10 owns Kitchen/Bar fulfillment.

Do not create placeholder Order or Inventory transaction tables.

---

## 3. Critical Boundary: Menu Item vs Recipe

A Menu Item represents what is sold.

A Recipe represents how the item is prepared and what it consumes.

```text
Menu Item
Cheeseburger
$14.99

        !=

Recipe
Cheeseburger preparation
8.0000 oz beef
1.0000 each bun
1.0000 each cheese slice
```

Do not place ingredient quantities directly on `menu_items`.

Do not make Recipe name/description the customer-facing menu presentation model.

Menu presentation may change without rewriting recipe history.

Phase 7 creates Recipe identity and immutable revisions, but does not persist Recipe ingredient/component identities or quantities. The README relationship remains `Recipe Ingredient -> Inventory Item`; Phase 8 adds the revision-to-Inventory-Item relationship after Inventory Items exist.

---

## 4. Critical Boundary: Recipe Requirement vs Inventory

Phase 7 defines Recipe identity, revision history, yield, and preparation metadata. Ingredient identity and exact quantities are deferred to Phase 8, when Recipe revisions can reference Inventory Items directly.

Phase 8 defines actual stock and ledger movements.

```text
Phase 7 Recipe
"Requires 1.5000 oz vodka"

        !=

Phase 8 Inventory
"37.2500 oz vodka currently on hand"
```

Phase 7 must not decrement inventory.

Recipe services must expose data Phase 8 and Phase 9 can consume later without owning inventory state.

---

## 5. Review Existing Foundation Before Changes

Before modifying files, inspect and confirm:

- Phase 0 through Phase 6 validations remain green.
- Organization/Location boundaries are understood.
- Restaurant Areas are understood.
- Existing permission catalog and role mappings are understood.
- Exact `NUMERIC` handling as decimal strings remains understood.
- Migration/transaction/test architecture is understood.
- BusinessDateService remains authoritative where applicable.
- Existing active/inactive and optimistic concurrency conventions are understood.
- Reset/seed/test DB infrastructure remains intact.
- No Inventory/Order/Kitchen domain exists yet.
- `DEV-001` remains tracked.

Before coding, provide a concise Phase 7 execution plan based on the repository's actual state.

---

## 6. Menu Categories
The README Menu model includes `menus`, `menu_locations`, `menu_availability`, `menu_categories`, `menu_items`, and `menu_item_placements`. Menu Items are organization-scoped catalog records and are not assigned a single category directly. A placement links one Menu Item to a Category within a Menu and controls display order and active/visible state. A Menu Item may have multiple placements. Do not add placement-specific price overrides in Phase 7.

Create `menus` (organization-scoped identity/configuration), `menu_locations` (Menu-to-Location availability), `menu_availability` (effective availability windows for a Menu/Location), and `menu_item_placements` (Menu/Category/Menu Item association, display order, active state). Enforce same-Organization relationships with database constraints.


Create:

```text
menu_categories
```

Conceptual fields:

```text
id                UUID PK
organization_id   UUID FK
code              required
name              required
description       nullable
display_order     integer
active            BOOLEAN default TRUE
created_at        TIMESTAMPTZ
updated_at        TIMESTAMPTZ
version           INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (organization_id, code)
```

Examples:

```text
APPETIZERS
ENTREES
BURGERS
SALADS
DESSERTS
BEER
WINE
COCKTAILS
NON_ALCOHOLIC
```

Do not require all categories to apply to every location if the approved architecture supports location-specific menu availability later.

---

## 7. Menu Items

Create:

```text
menu_items
```

Conceptual fields:

```text
id                     UUID PK
organization_id        UUID FK
code                   required
name                   required
description            nullable
short_name             nullable
item_type              required
active                 BOOLEAN default TRUE
available              BOOLEAN default TRUE
display_order          integer
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (organization_id, code)
```

Menu Item Category is determined by placement; do not add a single `menu_category_id` to `menu_items`. Enforce same-Organization ownership across Menu, Category, and Menu Item placement.

Do not hard-delete Menu Items that may later be referenced by Orders/history.

---

## 8. Menu Item Types

Use a small stable set sufficient for initial behavior, such as:

```text
FOOD
BEVERAGE
ALCOHOL
OTHER
```

Do not create a large taxonomy without operational need.

The type may guide UI/preparation behavior but must not substitute for the Category or Recipe.

If README already establishes a different canonical set, README wins.

---

## 9. Active vs Available

Preserve two concepts where useful:

```text
active
= configuration record remains operational in the catalog

available
= may currently be offered for sale
```

For example, a Menu Item may remain active for configuration/history while temporarily unavailable.

Do not implement automated inventory-based menu availability in Phase 7 because inventory state does not exist yet.

---

## 10. Effective Menu Price History

Create:

```text
menu_item_prices
```

Conceptual fields:

```text
id                UUID PK
menu_item_id      UUID FK
location_id       UUID nullable FK
price             NUMERIC(12,2) required
effective_from    TIMESTAMPTZ or DATE according to approved pricing semantics
effective_to      nullable
created_by_user_id UUID FK
created_at        TIMESTAMPTZ
```

Use exact decimal strings in TypeScript.

Do not store authoritative price as JavaScript floating-point `number`.

---

## 11. Price Resolution

Create one authoritative price resolver.

Conceptually:

```text
resolveMenuItemPrice(menuItemId, locationId, atInstant)
```

Rules:

- Use the effective record applicable to the requested time.
- Prefer a location-specific effective price over the organization/default effective price.
- If neither scope has an applicable effective price, the item has no resolvable selling price for that location/time.
- Placement-level price overrides are deferred; do not introduce a third precedence tier in Phase 7.
- Detect missing price before future Order creation.
- Reject unintended overlapping effective price rows.

Do not make Phase 9 Orders query raw price history themselves.

---

## 12. Price Change Workflow

A new price should preserve history.

Conceptually:

```text
$12.99 effective Jan 1
       |
       v
Manager changes price
       |
       v
old price effective_to closed
new $13.99 row inserted
```

Do not rewrite the historical price row to simulate a new price.

Use one transaction and appropriate concurrency safeguards.

---

## 13. Modifier Groups

Create:

```text
modifier_groups
```

Conceptual fields:

```text
id                UUID PK
organization_id   UUID FK
code              required
name              required
description       nullable
selection_type    required
minimum_selections integer default 0
maximum_selections integer nullable
active            BOOLEAN default TRUE
display_order      integer
created_at        TIMESTAMPTZ
updated_at        TIMESTAMPTZ
version           INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (organization_id, code)
```

Examples:

```text
BURGER_CHEESE
BURGER_TEMP
BURGER_ADDONS
SIDE_CHOICE
COCKTAIL_MODIFIERS
```

---

## 14. Modifier Group Selection Rules

Support clear selection semantics.

Examples:

```text
OPTIONAL_SINGLE
REQUIRED_SINGLE
OPTIONAL_MULTIPLE
REQUIRED_MULTIPLE
```

or an equivalent model based on min/max counts.

The database/service layer must validate:

```text
minimum_selections >= 0
maximum_selections >= minimum_selections when present
```

Do not rely only on UI controls to enforce modifier rules.

---

## 15. Modifiers

Create:

```text
modifiers
```

Conceptual fields:

```text
id                  UUID PK
organization_id     UUID FK
code                required
name                required
description         nullable
price_adjustment    NUMERIC(12,2) required default 0.00
active              BOOLEAN default TRUE
preparation_effect_type required structured value
preparation_instruction nullable text
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
version             INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (organization_id, code)
```

Modifier pricing uses exact decimal strings.

---

## 16. Modifier Behavior Categories

Modifiers may affect different things.

Preserve at least these concepts:

```text
Price effect
Preparation/instruction effect
Recipe/quantity effect
```

Examples:

```text
"Well Done"
price effect: 0
preparation effect: instruction
recipe effect: none

"Add Bacon"
price effect: +2.00
preparation effect: add component
recipe effect: future consumption change

"No Onion"
price effect: 0
preparation effect: remove component
recipe effect: future consumption change
```

Do not reduce modifiers to free-form strings.

Do not implement Phase 8 inventory consumption yet.

---

## 17. Menu Item Modifier Groups

Create:

```text
menu_item_modifier_groups
```

Conceptual fields:

```text
id                  UUID PK
menu_item_id        UUID FK
modifier_group_id   UUID FK
display_order       integer
required_override   nullable
minimum_override    nullable
maximum_override    nullable
active              BOOLEAN default TRUE
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
```

Required uniqueness should prevent duplicate active/equivalent attachment of the same group to an item.

Overrides should be used only when needed; otherwise the group defaults remain authoritative.

---

## 18. Modifier Group Membership

If modifiers may belong to multiple groups, create a join table such as:

```text
modifier_group_modifiers
```

Conceptual fields:

```text
modifier_group_id UUID FK
modifier_id       UUID FK
display_order     integer
active            BOOLEAN default TRUE
```

If the existing architecture clearly states a Modifier belongs to only one group, follow README instead.

Prefer reuse where it avoids duplicating the same logical modifier across many groups.

---

## 19. Modifier Selection Validation Service

Create one authoritative prospective-selection validator for future Phase 9 consumption.

It should be able to validate a proposed selection set against:

```text
Menu Item
attached Modifier Groups
active Modifiers
group min/max rules
item overrides
```

Phase 7 tests this service directly.

Do not create Order Item tables to exercise it.

Use plain input DTO/test fixtures.

---

## 20. Price Calculation Helper for Menu + Modifiers

Create a pure/application helper that can calculate a prospective item amount from:

```text
resolved Menu Item base price
+ selected Modifier price adjustments
```

Use exact decimal arithmetic strategy consistent with the architecture.

If no arbitrary-precision arithmetic library has yet been approved, do not silently convert decimal strings to JavaScript numbers. Use an exact strategy and document it.

Do not implement tax, discounts, tips, or final Order totals in Phase 7.

---

## 21. Preparation Stations

If not already modeled, create:

```text
prep_stations
```

Conceptual fields:

```text
id                UUID PK
location_id       UUID FK
code              required
name              required
station_type      required
active            BOOLEAN default TRUE
sort_order        integer
created_at        TIMESTAMPTZ
updated_at        TIMESTAMPTZ
version           INTEGER default 1
```

Examples:

```text
GRILL
FRY
SALAD
BAR
EXPO
```

Required uniqueness:

```text
UNIQUE (location_id, code)
```

This is preparation routing configuration only.

Do not create Kitchen Tickets in Phase 7.

---

## 22. Preparation Routing

A Menu Item is organization-scoped while Prep Stations are location-scoped. Store routing in a location-aware assignment such as `menu_item_prep_routing`, not a direct Menu Item FK. Support one or more configured stations per item/location for future composite fulfillment, without creating tickets or fulfillment records.

A Modifier may carry a structured preparation effect/instruction. Recipe effects use the separate typed ADD/REMOVE/ADJUST contract and are not encoded as kitchen-note text.

Keep the Phase 7 routing model simple enough for Phase 10 to consume later.

Do not implement real-time station screens, ticket claiming, firing, or completion.

---

## 23. Units of Measure

Phase 7 needs a stable quantity-unit vocabulary for Recipes.

Create or establish:

```text
units_of_measure
```

Phase 7 needs a stable quantity-unit vocabulary for future Recipe ingredients.

Create `units_of_measure` with stable unique codes, a name, measurement type (`COUNT`, `WEIGHT`, `VOLUME`), and active state. Seed `EACH`, `OZ_WEIGHT`, `LB`, `G`, `KG`, `FL_OZ`, `ML`, and `L`; never use ambiguous `OZ`.

Store approved conversions explicitly in `unit_conversions` with source/target unit FKs and a positive exact `NUMERIC(14,6)` factor. Convert only within a compatible measurement type. Do not use density assumptions or culinary approximations. Conversion arithmetic must remain exact and reject unsupported precision rather than silently use floating point.

---

## 24. Unit Conversion Scope

Conversions are deterministic and explicit, such as `LB -> OZ_WEIGHT`, `G -> KG`, and `ML -> L`. Weight-to-volume conversion requires a future product-specific density rule and is out of scope.

---

## 25. Recipe Ingredient / Inventory Boundary

README remains authoritative: Recipe Ingredients directly reference Inventory Items. Do not create a separate Phase 7 `recipe_components` catalog and do not create Inventory Items early.

Phase 7 persists Recipe identity, immutable revision metadata, yield, effective dates, and preparation metadata only. Phase 8 adds `recipe_version_ingredients` with `recipe_version_id`, `inventory_item_id`, exact quantity, unit-of-measure ID, and preparation note. There is no Phase 7-to-Phase 8 catalog mapping.

---

## 26. Recipe Identity

Create durable organization-scoped Recipe identities. A Recipe may optionally be associated with a Menu Item, but Menu Items are not required to have Recipes.

```text
id                UUID PK
organization_id   UUID FK
menu_item_id      UUID nullable FK
code              required
name              required
description       nullable
active            BOOLEAN default TRUE
created_at        TIMESTAMPTZ
updated_at        TIMESTAMPTZ
version           INTEGER default 1
```

Required uniqueness: `UNIQUE (organization_id, code)`. Do not hard-delete referenced Recipes.

---

## 27. Immutable Recipe Revisions

Create `recipe_versions` under durable Recipe identity. Revision rows contain a monotonically increasing revision number, lifecycle status (`DRAFT`, `PUBLISHED`, `RETIRED`), exact yield quantity (`NUMERIC(14,4)` decimal string), optional yield UOM, preparation metadata, effective interval, and creation/publication provenance.

Published revisions are immutable. Publishing a new revision transactionally closes the prior published revision's effective interval and activates the new revision. Use half-open intervals `[effective_from, effective_to)`. At most one published revision per Recipe may be effective at any instant. Enforce non-overlap in the database or through serialized transaction-safe publication. Retiring an effective revision closes its interval; drafts have no effective interval.

The invariant is that future Order/Inventory events can identify the revision effective at the relevant instant. Phase 7 does not create historical Order linkage.

---

## 28. Recipe Ingredients Deferred to Phase 8

Do not persist ingredient identities or quantities in Phase 7. This is intentional, not an incomplete deliverable. Phase 8 adds `recipe_version_ingredients` referencing Inventory Items and stores quantities as `NUMERIC(14,4)` decimal strings with unit-of-measure and preparation note. Phase 7 establishes the UOM vocabulary and conversion rules those rows will use.

---

## 29. Recipe Yield

Yield belongs to a Recipe revision, not the durable Recipe identity, so future revisions preserve historical yield semantics. Examples include one cocktail (`1 EACH`) or a sauce batch (`64 FL_OZ`). Do not add nested subrecipes in Phase 7.

---

## 30. Menu Item to Recipe Link

A Menu Item may reference a durable Recipe identity. Resolve its effective published revision separately at the requested instant. Enforce matching Organization ownership. Do not couple Recipe existence to Menu Item active/available state.

---

## 31. Modifier Recipe Effect Contract

Phase 7 establishes typed DTO and Zod contracts for future Menu Item/Recipe-context ingredient deltas. Because persisted Recipe ingredients are deferred to Phase 8, do not persist component-bound Modifier effect rows or invent duplicate ingredient identity in Phase 7.

Approved operations are `ADD`, `REMOVE`, and `ADJUST`. A substitution is represented as REMOVE of the old Inventory Item plus ADD of the replacement. Contracts identify the future Inventory Item and use exact decimal-string positive magnitudes; the operation expresses direction. Preparation-only effects are separate and never imply inventory consumption.

---

## 32. Modifier Recipe Effect Validation

Phase 7 validates effect operation shape, positive exact decimal-string quantities, required Inventory Item identifiers, and substitution as separate REMOVE plus ADD effects. It does not claim Inventory Item existence or validate unit compatibility. Phase 8 owns persistence, same-Organization/existence checks, and unit compatibility when Recipe ingredient/effect relationships are introduced.

---

## 33. Menu Availability Foundation

Phase 7 availability comes from Menu/Location availability, placement visibility, Menu Item `active` and `available`, active Categories, active Modifier Groups/Modifiers, and an applicable effective price. Do not infer stock availability from Recipe definitions; Inventory state does not exist until Phase 8.

---

## 34. Menu Query Model

Create a purpose-built query/DTO suitable for future Order entry. It exposes Menu and Category placement, active/available Menu Items, resolved exact price, active Modifier Groups/options and selection constraints, and preparation routing identifiers. Recipe identity/revision and ingredient data are not included in the operational Menu DTO.

---

## 35. Recipe Detail Query

Create a separate authorized management query exposing Recipe identity, revision status/effective interval, yield/UOM, and preparation metadata. Ingredient identities and quantities are intentionally absent until Phase 8. Do not expose future Inventory cost/on-hand fields.

---
code/name/description
item type
active/available
price history/new price
modifier group attachments
prep station
recipe association
```

Use optimistic concurrency.

Price changes use the effective price workflow, not direct mutation of historical rows.

---

## 38. Modifier Editor

Allow authorized users to manage:

```text
Modifier Group rules
Modifiers
Prices
Display order
Structured preparation/recipe effects where implemented
Active/inactive lifecycle
```

Provide clear min/max selection validation feedback.

---

## 39. Recipe Editor

Allow authorized users to create/edit a draft/new Recipe revision with:

```text
Yield
Components
Quantities
Units
Preparation notes
```

Publishing/activating a new revision should preserve the previous revision according to the chosen recipe-history model.

Do not overwrite historically effective recipe content.

---

## 40. Permissions

Use/extend the centralized permission catalog without synonyms.

Expected concepts:

```text
menu.view
menu.edit
menu.pricing.view
menu.pricing.edit
menu.modifiers.manage
recipes.view
recipes.edit
prep-stations.manage
```

If existing Phase 2 codes already cover some capabilities, reuse them rather than duplicating.

Update role-permission seeds deliberately.

Do not allow Server/Host operational roles to edit prices/recipes by default.

---

## 41. Authorization Boundaries

Representative policy:

```text
menu.view
  -> operational Menu query

menu.edit
  -> menu/category configuration

menu.pricing.edit
  -> price changes

recipes.view
  -> recipe details

recipes.edit
  -> recipe configuration
```

Direct API/server actions enforce permissions independently of UI visibility.

Use location/organization scope consistent with prior phases.

---

## 42. Concurrency

Use optimistic concurrency for mutable configuration entities:

```text
menu_categories
menu_items
modifier_groups
modifiers
prep_stations
recipe catalog/revisions where mutable
```

Effective price/revision publishing must use transaction-safe checks.

Stale administration screens must receive conflict responses rather than overwriting newer changes.

---

## 43. Transactions

Use shared transaction context for operations such as:

```text
price change closes old + creates new
attach/update Menu Item Modifier Groups
publish new Recipe revision
create and publish immutable Recipe revisions
validate Modifier Recipe-effect contracts (no Phase 7 ingredient-row persistence)
```

Avoid partial configuration states on failure.

---

## 44. No Runtime Inventory Coupling

Phase 7 Menu/Recipe pages must work without Inventory tables.

Do not add joins to nonexistent Phase 8 stock data.

Do not mark an item unavailable based upon recipe requirements alone.

A Recipe defines theoretical requirements, not actual stock availability.

---

## 45. Seed Data

Use idempotent seed data to provide a modest demonstration Menu and Recipe configuration.

Recommended categories:

```text
APPETIZERS
ENTREES
BURGERS
SALADS
BEER
COCKTAILS
NON_ALCOHOLIC
```

Recommended prep stations:

```text
GRILL
FRY
SALAD
BAR
EXPO
```

Seed a small number of Menu Items/Modifiers/Recipes only if useful for demonstrating later phases.

Avoid creating a large fictional restaurant menu.

Do not seed Phase 8 inventory quantities/suppliers.

---

## 46. Unit-of-Measure Seed

Seed the approved generic Units idempotently.

At minimum consider:

```text
EACH
OZ_WEIGHT
LB
G
KG
FL_OZ
ML
L
```

Test known conversions exactly where configured.

Do not use ambiguous unit labels internally.

---

## 47. Unit Tests: Effective Price Resolution

Test:

```text
current organization/default price
location-specific precedence over organization/default price
placement-level price override deferred
future price not selected early
past price no longer selected
boundary semantics
missing current price
no unintended overlapping active price intervals
exact decimal value returned
```

Use explicit half-open/effective interval semantics and document them.

---

## 48. Unit Tests: Modifier Selection Rules

Test:

```text
required single: exactly one
optional single: zero or one
required multiple: min/max enforced
optional multiple: max enforced
inactive modifier rejected
modifier not attached to item rejected
group override respected
```

The same validator will be reusable by Phase 9 Order entry.

---

## 49. Unit Tests: Modifier Pricing

Test exact item + modifier price calculations.

Examples:

```text
14.99 + 2.00 = 16.99
14.99 + 1.50 + 2.00 = 18.49
zero-price instruction modifier unchanged
```

Do not rely on normal floating-point money arithmetic.

---

## 50. Unit Tests: UOM Conversion

Test:

```text
1 LB -> 16 OZ_WEIGHT
1000 G -> 1 KG
1000 ML -> 1 L
incompatible measurement conversion rejected
exact decimal preservation
```

Only test conversions actually configured/approved.

---

## 51. Unit Tests: Recipe Validation

Test:

```text
Recipe identity organization consistency
positive exact revision yield
revision numbering and lifecycle transitions
published revision immutability
effective interval boundaries and overlap prevention
prior revision history preserved after publish/retire
```

If subrecipes are implemented, add cycle detection tests.

---

## 52. Unit Tests: Modifier Recipe Effects

When structured Recipe effects are implemented, test representative cases:

```text
ADD/REMOVE/ADJUST payload shape is validated
positive exact decimal-string quantity and required future Inventory Item identity
substitution requires separate REMOVE and ADD operations
preparation-only effect cannot become an ingredient delta
```

These produce future consumption requirements only, not Inventory ledger entries.

---

## 53. Integration Tests: Menu Configuration

Test:

```text
category creation/uniqueness
Menu/Category/Placement organization integrity and many-to-many item placements
active/available behavior
location-aware prep station routing integrity
optimistic concurrency
unauthorized edit denied
```

---

## 54. Integration Tests: Pricing

Test:

```text
initial price
new effective price closes/changes history correctly
current price resolution
location-specific price wins over organization/default price
placement-level price override absent
stale concurrent price update rejected
unauthorized pricing edit denied
exact NUMERIC persistence
```

---

## 55. Integration Tests: Modifiers

Test:

```text
create group/modifiers
attach group to Menu Item
selection constraints
price adjustments
inactive group/modifier behavior
cross-organization assignment denied
structured Recipe effects if implemented
```

---

## 56. Integration Tests: Recipes

Test:

```text
create Recipe identity
create/publish initial revision with yield and effective interval
publish second revision and preserve prior revision
resolve effective/current revision
published revision content cannot be mutated
ingredient rows/quantities intentionally absent until Phase 8
Menu Item association
```

Do not require Inventory state.

---

## 57. Integration Tests: Future Order Query Contract

Without creating Orders, test the Menu query contract Phase 9 will consume.

Verify:

```text
available Menu Item with active placement returned
current exact price returned
attached Modifier Groups returned
selection constraints returned
inactive/unavailable item or inactive placement excluded as designed
inactive/unavailable item or inactive placement excluded as designed
Recipe/internal HR/config data not leaked
```

---

## 58. E2E: Menu Administration

Playwright scenario:

```text
Authorized manager logs in
 -> Menu administration
 -> create/edit category or Menu Item
 -> set price
 -> attach Modifier Group
 -> save
 -> operational Menu view reflects changes
```

Use deterministic isolated fixtures where appropriate.

---

## 59. E2E: Recipe Administration

Scenario:

```text
Authorized user
 -> creates/opens Recipe
 -> creates a revision with yield/UOM and preparation metadata
 -> publishes the revision with effective dates
 -> Recipe detail displays expected revision
```

Verify unauthorized role cannot edit Recipe configuration.

---

## 60. E2E: Modifier Validation

Where useful:

```text
Open Menu Item configuration/preview
 -> required Modifier Group visible
 -> invalid min/max configuration rejected
 -> modifier price adjustment visible
```

Phase 9 will contain the complete order-entry modifier-selection E2E flow.

---

## 61. Migration Requirements

Generate/review Phase 7 migrations.

Verify:

```text
Existing Phase 6 DB
 -> Phase 7 migrations
 -> success
```

and:

```text
Empty test DB
 -> all Phase 1-7 migrations
 -> expected schema
```

Second generation reports no unexplained drift.

Do not rewrite old migration history solely for cosmetic purposes.

---

## 62. Reset/Seed Regression

Verify on a safe disposable database:

```text
npm run db:reset
npm run db:seed
```

Phase 1-7 stable configuration reconstructs idempotently.

No permanent operational Reservation/Waitlist/Table Session data should be required for Menu/Recipe seeds.

---

## 63. Prior-Phase Regression

Phase 7 must preserve:

```text
Phase 2 auth/RBAC
Phase 3 HR privacy
Phase 4 Scheduling
Phase 5 Seating
Phase 6 Reservations/Waitlist
```

Menu/Recipe queries must not interfere with those domains.

Do not expose restricted HR/guest data in Menu APIs.

---

## 64. Production Dependency Audit

Continue requiring:

```text
npm audit --omit=dev
```

Production dependencies must remain clean or new findings require explicit review.

If an exact-decimal arithmetic runtime dependency is introduced, justify it, pin/use it deliberately, and ensure the production audit remains clean.

Do not add Inventory/Order/Kitchen libraries or external menu APIs in Phase 7.

Preserve DEV-001 unless intentionally reviewed.

---

## 65. Documentation Updates

Document:

- Menu Item vs Recipe boundary
- Recipe vs Inventory boundary
- Menu Category model
- active vs available
- effective price semantics
- price precedence if location overrides exist
- Modifier Group selection rules
- Modifier behavior categories
- exact money arithmetic strategy
- prep station/routing foundation
- Units of Measure and compatible conversions
- Phase 8 Recipe-version-to-Inventory-Item ingredient extension point; no Phase 7 component catalog
- Recipe revision/history strategy
- Modifier Recipe effects
- Future Phase 8 Inventory extension point
- Future Phase 9 Order/menu snapshot extension point
- Future Phase 10 Kitchen routing extension point

---

## 66. Phase 7 Validation Checklist

Run:

```text
docker compose up -d
docker compose ps
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
npm run db:seed
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
npm audit --omit=dev
```

Safe reset/reconstruction should be tested in the established disposable environment.

Verify:

```text
PostgreSQL health                 PASS
/api/health                       PASS
migration generation              PASS
migration application             PASS
empty DB reconstruction           PASS
schema drift                      NONE
seed idempotency                  PASS
Menu Category integrity           PASS
Menu Item lifecycle               PASS
effective pricing                 PASS
exact money handling              PASS
Modifier Group validation         PASS
Modifier pricing                  PASS
Prep station routing foundation   PASS
UOM compatibility/conversions     PASS
Recipe creation                   PASS
Recipe revision history           PASS
Recipe ingredient quantities deferred to Phase 8 (expected)
immutable Recipe revision and yield semantics PASS
Modifier Recipe-effect contracts PASS; effect persistence deferred to Phase 8
future Order query contract       PASS
no Inventory state implemented    PASS
prior-phase regressions           PASS
production dependency audit       CLEAN
```

---

## 67. Phase 7 Deliverables

Phase 7 should leave:

```text
✓ menu_categories
✓ menus
✓ menu_locations
✓ menu_availability
✓ menu_items
✓ menu_item_placements
✓ menu_item_prices
✓ modifier_groups
✓ modifiers
✓ menu_item_modifier_groups
✓ modifier_group_modifiers where applicable
✓ prep_stations if not already present
✓ units_of_measure
✓ recipes
✓ Recipe revision/history tables
✓ Recipe identity and immutable revision publishing/resolution
✓ UOM vocabulary/conversion foundation for Phase 8 ingredients
✓ structured Modifier Recipe-effect contracts; persistence deferred to Phase 8

✓ effective price resolver
✓ historical price changes
✓ Modifier selection validator
✓ exact base + Modifier pricing helper
✓ prep routing configuration
✓ UOM conversion/compatibility service
✓ Recipe revision publishing/resolution
✓ future Order Menu query contract

✓ Menu/Modifier/Recipe administration UI
✓ Phase 7 permissions/role grants
✓ idempotent Menu/UOM/prep/reference seeds

✓ unit tests
✓ PostgreSQL integration tests
✓ Playwright tests
✓ Phase 0-6 regressions green
✓ production audit clean
✓ no Inventory ledger/Orders/Kitchen domains prematurely added
```

---

## 68. Phase 7 Definition of Done

Phase 7 is complete when authorized staff can:

```text
Configure Menu Categories
       |
       v
Configure Menus, Categories, Menu Items, and Placements
       +-- current/effective price
       +-- Modifier Groups
       +-- prep routing
       |
       v
Configure Recipes
       +-- version/history
       +-- revision yield and effective history
       +-- units
```

and the application proves:

- Menu Items and Recipes are separate concepts.
- Prices are exact and historically preserved.
- Modifier min/max rules are enforced server-side.
- Modifier price changes use exact monetary arithmetic.
- Recipe revision yield uses exact fixed precision; ingredient quantities are intentionally deferred to Phase 8.
- UOM conversions reject incompatible dimensions.
- Recipe revisions preserve history.
- Recipe definitions do not modify Inventory state.
- Operational Menu query exposes the contract needed by future Order entry without leaking Recipe internals.
- No Inventory transaction or Order records are created.
- Database reconstruction requires no manual SQL.
- Prior phases remain green.

Phase 7 is not complete if price changes overwrite historical prices.

Phase 7 ingredient quantities are intentionally deferred to Phase 8; Phase 7 Recipe revision yields must use exact fixed precision.

Phase 7 is not complete if a Menu Item must own Inventory on-hand values.

---

## 69. Required Phase 7 Completion Report

Provide:

```text
PHASE 7 COMPLETION REPORT

Environment
- Node:
- npm:
- Next.js:
- PostgreSQL:
- Drizzle ORM:
- Drizzle Kit:
- Exact decimal arithmetic approach/library if applicable:

Menu Schema
- menus: PASS / FAIL
- menu_locations: PASS / FAIL
- menu_availability: PASS / FAIL
- menu_categories: PASS / FAIL
- menu_items: PASS / FAIL
- menu_item_placements: PASS / FAIL
- menu_item_prices: PASS / FAIL
- modifier_groups: PASS / FAIL
- modifiers: PASS / FAIL
- menu_item_modifier_groups: PASS / FAIL
- modifier_group_modifiers: PASS / FAIL / N/A
- prep_stations: PASS / FAIL / already existed
- units_of_measure: PASS / FAIL
- Recipe component catalog: NOT CREATED (approved boundary)
- recipes: PASS / FAIL
- Recipe revision/history tables: PASS / FAIL
- Recipe ingredient/component rows: DEFERRED TO PHASE 8 (expected)
- Modifier Recipe-effect contracts: PASS / FAIL
- Persisted Modifier ingredient effects: DEFERRED TO PHASE 8 (expected)

Menu
- Category integrity: PASS / FAIL
- Menu Item lifecycle: PASS / FAIL
- active vs available: PASS / FAIL
- current/effective price resolution: PASS / FAIL
- price history preservation: PASS / FAIL
- price overlap prevention: PASS / FAIL
- location-specific over organization/default precedence: PASS / FAIL
- placement-level price overrides: DEFERRED (expected)
- exact money handling: PASS / FAIL

Modifiers
- Group selection rules: PASS / FAIL
- Menu Item group attachment: PASS / FAIL
- min/max enforcement: PASS / FAIL
- inactive behavior: PASS / FAIL
- price adjustments: PASS / FAIL
- exact prospective item pricing: PASS / FAIL
- structured preparation effects: PASS / FAIL
- structured recipe effects: PASS / FAIL / N/A

Preparation
- Prep stations: PASS / FAIL
- Menu Item routing: PASS / FAIL
- No Kitchen tickets implemented: PASS / FAIL

Units
- Stable unit codes: PASS / FAIL
- Exact conversion factors: PASS / FAIL
- Compatible-dimension conversion: PASS / FAIL
- Incompatible conversion rejected: PASS / FAIL
- No ambiguous OZ usage internally: PASS / FAIL

Recipes
- Menu Item/Recipe separation: PASS / FAIL
- Recipe creation: PASS / FAIL
- Yield: PASS / FAIL
- Recipe ingredient quantities: DEFERRED TO PHASE 8 (expected)
- UOM compatibility/conversions: PASS / FAIL
- Immutable revision/history preservation: PASS / FAIL
- Current/effective revision resolution: PASS / FAIL
- Inventory state absent: PASS / FAIL

Authorization
- menu.view: PASS / FAIL
- menu.edit: PASS / FAIL
- pricing authorization: PASS / FAIL
- modifier administration: PASS / FAIL
- recipes.view/edit: PASS / FAIL
- direct unauthorized API denied: PASS / FAIL

Future Contracts
- Order-facing Menu query: PASS / FAIL
- Recipe/internal details excluded from operational Menu DTO: PASS / FAIL
- Phase 8 Inventory extension point documented: PASS / FAIL
- Phase 10 preparation routing extension documented: PASS / FAIL

Migrations
- Generation: PASS / FAIL
- Application: PASS / FAIL
- Empty DB reconstruction: PASS / FAIL
- Unexplained schema drift: NONE / describe

Regression
- Phase 1 foundation: PASS / FAIL
- Phase 2 auth/RBAC: PASS / FAIL
- Phase 3 Employees/HR: PASS / FAIL
- Phase 4 Scheduling: PASS / FAIL
- Phase 5 Restaurant/Seating: PASS / FAIL
- Phase 6 Reservations/Waitlist: PASS / FAIL
- db:reset safeguards: PASS / FAIL
- /api/health: PASS / FAIL

Validation
- npm ci: PASS / FAIL
- lint: PASS / FAIL
- typecheck: PASS / FAIL
- unit tests: PASS / FAIL
- integration tests: PASS / FAIL
- E2E tests: PASS / FAIL
- production build: PASS / FAIL
- npm audit --omit=dev: PASS / FAIL

Accepted Risks
- DEV-001: unchanged / updated / resolved

Business Domains Created Beyond Phase 7
- NONE expected

Created / Modified
- Summarize schema, migrations, Menu/Recipe modules, permissions, UI, seeds, tests, and documentation.

Architecture Deviations
- None / describe

Outstanding Phase 7 Issues
- None / describe and blocking status

Phase 8 Readiness
- READY / NOT READY
```

---

## 70. Recommended VS Code Copilot Prompt

After placing this file at `docs/Phase-7-Menu-Recipes.md`, start a fresh Copilot chat and use:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/accepted-risks.md`, and all Phase 0 through Phase 7 implementation plans completely. Treat `README.md` as the architectural source of truth. Derive current state from repository source, migrations, tests, and documentation rather than prior chat history.
>
> Review the completed Phase 0 through Phase 6 implementation before modifying files. Implement Phase 7 only: README-aligned Menus, Categories, Menu Items and placements; effective-dated item prices with location-specific precedence over organization/default price; Modifier Groups and Modifiers; menu-item Modifier Group assignments; server-side selection validation; exact prospective pricing; location-aware prep routing; UOM/conversion rules; durable Recipe identities and immutable revisions; and structured ADD/REMOVE/ADJUST Modifier Recipe-effect contracts. Do not create an ingredient catalog or persist ingredient identities/quantities in Phase 7; Phase 8 adds Recipe-version ingredients referencing Inventory Items.
>
> Preserve these boundaries: Menu Item is not Recipe; Recipe Ingredients remain directly related to future Inventory Items; Phase 7 does not create Inventory Items or a substitute component catalog; ingredient rows/quantities are deferred to Phase 8; Orders do not exist yet; Kitchen tickets do not exist yet. Do not decrement inventory or create placeholder Order/Kitchen tables.
>
> Preserve exact money and quantity handling from Phase 1. Do not use JavaScript floating-point arithmetic for authoritative prices or Recipe revision yield. Ingredient quantities are intentionally introduced with the Phase 8 Recipe-version-to-Inventory-Item relationship. Preserve prior-phase RBAC/privacy/workflows, reset safeguards, migration history, and DEV-001 unchanged.
>
> Before modifying files, inspect the repository and provide a concise Phase 7 execution plan. Apply the approved policies: README Menu/Category/Placement; location price before organization/default price with placement overrides deferred; immutable effective-dated Recipe revisions; and structured ADD/REMOVE/ADJUST effect contracts with ingredient persistence deferred to Phase 8.
>
> After implementation, run the complete Phase 7 validation suite and provide the full Phase 7 Completion Report. Stop before changing approved architecture if a material conflict is discovered.

---

## Final Guardrail

Phase 7 defines the restaurant's Menu catalog, placements, prices, modifier choices, prep routing, and Recipe revision identities without pretending that Inventory or Orders already exist. Recipe-version ingredient identities and exact quantities begin in Phase 8.

```text
Menu Item
   + Price history
   + Modifier choices
   + Prep routing
        |
        v
Recipe Identity / Immutable Revision
       + Yield and preparation metadata
        |
       +-- Phase 8 adds Recipe-version ingredients referencing Inventory Items
        |
        +-- Phase 9 Orders snapshot purchased configuration
        |
        +-- Phase 10 Kitchen/Bar uses preparation routing
```

Do not collapse these future domain boundaries for implementation convenience.
