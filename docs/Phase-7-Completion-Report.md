# Phase 7 Completion Report

This report merges the plan §69 template with the sections required by CLAUDE.md. Results are from this repository on 2026-11-08.

## Summary

Phase 7 is implemented and validated locally. Authorized staff can configure categories, menus, items and placements; set effective-dated prices (a location price beats the organization default); define modifier groups and modifiers and attach them to items; route items to prep stations; and create recipes whose revisions are drafted, published with an effective date, and retired. The operational menu query exposes what Phase 9 order entry needs, with no recipe data. Recipe ingredients and quantities are intentionally not built: they arrive in Phase 8, when Inventory Items exist.

**Not yet confirmed:**

- **`db:reset` on your real development database** was deliberately not run, because it would delete your Owner account. The same command was proven on a throwaway PostgreSQL container.

**Please review these decisions:**

1. The README conflicts below (ingredients, placement price override, prep station names) were resolved in favour of the approved plan, and README was amended.
2. Six new permissions, so 93 in all. Owner, General Manager and Manager hold all six. Every other role keeps `menu.view` only.
3. A recipe may link to at most one Menu Item (a partial unique index). The plan was silent.
4. `menu_availability` is effective-dated (a menu is offered only inside a window once it has any). The plan said "effective availability windows" without saying whether those were dates or times of day.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |
| Exact decimal arithmetic | In-repo `BigInt` helper (`src/shared/decimal/`), no dependency added |

## Policies

The plan's approved policies were treated as binding; `README.md` was updated to match (§14, §15, §33, §36).

### Conflicts and gaps found, and how they were resolved

| Conflict or gap | Resolution |
|---|---|
| README §15/§36 put `recipe_ingredients`, `modifier_ingredient_adjustments` and ingredient-adjustment logic in Phase 7; plan §25, §28, §31 defer them to Phase 8. Plan §39 still says "Components/Quantities" | Followed §28. No ingredient tables. Add/remove/adjust exist only as typed contracts. README amended |
| README §14 lets a placement carry an optional price override; plan §6/§11 defers it | Plan wins. No override column. README amended |
| Prep station seeds: README lists `GRILL, FRY, COLD, KITCHEN, BAR`; plan §45 lists `GRILL, FRY, SALAD, BAR, EXPO` | Plan's list seeded |
| Plan §36 and the start of §37 are missing from the file | UI inferred from §37 (fragment), §38, §39 and §58–60 |
| Recipe-to-Menu-Item cardinality unspecified | One recipe per menu item (partial unique index) |
| `prep-stations.manage` has a hyphen in its domain; the catalog test pattern allowed only lowercase letters | Test pattern widened to allow hyphenated words |

### Applied beyond the plan text

| Topic | Applied |
|---|---|
| Price start | Blank means now. A given start can't be in the past, can't be at or before the price it replaces, and can't jump ahead of a scheduled price |
| Stale price editor | Optional `expectedCurrentPriceId`; a mismatch is a concurrency conflict |
| Recipe publish | Start can't be in the past or at or before an earlier revision. Earlier revision in force is closed where the new one begins. A revision retired before it took effect gets an empty interval |
| Selection overrides | `required_override` true means at least 1, false means 0; explicit min/max overrides win; a single-choice group never exceeds 1 |
| Selection input | Names the group and the modifier, so a modifier in two groups is unambiguous |
| Units | Only exact conversions seeded: `LB`/`OZ_WEIGHT`, `G`/`KG`, `ML`/`L` (both directions). Fluid ounce to milliliter is not approved |
| Menu items and prices in seeds | None. Seeds create units, conversions, categories, stations and an empty Main Menu offered at MAIN. A price needs a user to attribute it to and no users exist at seed time |

## Architectural decisions

- **Same-organization integrity in the database.** Children carry `organization_id` and use composite foreign keys onto `(id, organization_id)`. A test inserts a cross-organization placement and a cross-organization recipe link directly and the database refuses both.
- **Exclusion constraints** (`btree_gist`, as in Phases 3 and 5) stop two prices in force in one scope, two availability windows overlapping, and two recipe revisions in effect at once. The services also lock and check first, so users get a clear message and the database is the backstop.
- **Immutable revisions twice over.** The service refuses edits to a non-draft, and a trigger refuses changes to yield, unit, notes and numbering, a return to draft, and deletion once published.
- **Pure rules.** Price resolution, price-change planning, modifier selection, item pricing, unit conversion, revision lifecycle and effect contracts have no database access.
- **One door for pricing and recipes.** `resolveMenuItemPrice`, `resolveEffectiveRevision` and `loadSelectionGroups` are what Phases 8 and 9 call. They check the organization themselves and leave permission checks to the caller.
- **Modules stay apart.** Menu and Recipes import neither each other nor Restaurant, Reservations, Employees or Scheduling; a test scans the source for this and for restricted HR and guest tables.
- **`updateVersioned`** (`src/db/helpers/versioned-update.ts`) is the shared optimistic-concurrency update: not found and stale version are told apart with one follow-up read.

### Architecture deviations

| Deviation | Reason |
|---|---|
| `0009_menu_recipes.sql` hand-reordered once, before any database applied it | Drizzle emitted the `locations` unique constraint after the foreign keys that depend on it. The line was moved to the top. The snapshot is unaffected and a further `db:generate` reports no changes |
| Tables beyond README §14/§15's lists (`menu_item_prices`, `modifier_group_modifiers`, `menu_item_prep_routing`, `unit_conversions`, `recipe_versions`) | Named in the plan. README amended |
| `src/components/forms/entity-form.tsx` gained a `datetime-local` field type | Effective dates need an instant; the browser's local time is converted to ISO |
| `.github/copilot-instructions.md` not used | `CLAUDE.md` replaces it, per the `/phase` instruction |

## Migrations

| Migration | Contents |
|---|---|
| `0009_menu_recipes.sql` | Generated. 17 tables, `locations_id_organization_id_unique`, composite foreign keys (all `RESTRICT`), check constraints |
| `0010_menu_recipes_constraints.sql` | Custom. Three exclusion constraints and two triggers |

| Check | Result |
|---|---|
| Generation | PASS |
| Application | PASS |
| Existing Phase 6 database to Phase 7 | PASS: your real development database upgraded with `db:migrate` and `db:seed`, keeping its 1 user. Automated tests also upgrade a populated Phase 5 and a Phase 6 database in place |
| Empty DB reconstruction | PASS: automated test, plus `db:reset` on a new empty PostgreSQL 17 container |
| Unexplained schema drift | NONE: a further `db:generate` reports "No schema changes" |

**What changed in your development database:** 87 permissions became 93 and role grants 299 became 317. It now holds 7 categories, 5 prep stations, 8 units, 6 conversions and 1 empty Main Menu, and no items. Its 1 user, floor and settings are untouched.

## Validation results

### Menu schema

| Table | Result |
|---|---|
| menus | PASS |
| menu_locations | PASS |
| menu_availability | PASS |
| menu_categories | PASS |
| menu_items | PASS |
| menu_item_placements | PASS |
| menu_item_prices | PASS |
| modifier_groups | PASS |
| modifiers | PASS |
| menu_item_modifier_groups | PASS |
| modifier_group_modifiers | PASS |
| prep_stations | PASS (new table) |
| menu_item_prep_routing | PASS |
| units_of_measure | PASS |
| unit_conversions | PASS |
| Recipe component catalog | NOT CREATED (approved boundary) |
| recipes | PASS |
| recipe_versions | PASS |
| Recipe ingredient/component rows | DEFERRED TO PHASE 8 (expected) |
| Modifier Recipe-effect contracts | PASS |
| Persisted Modifier ingredient effects | DEFERRED TO PHASE 8 (expected) |

### Menu

| Check | Result |
|---|---|
| Category integrity | PASS: unique code per organization, cross-organization placements refused by service and database |
| Menu Item lifecycle | PASS: deactivated, never deleted; delete is refused while placements exist |
| active vs available | PASS: an unavailable or inactive item drops out of the operational menu |
| Current/effective price resolution | PASS: half-open boundaries, future price not selected early |
| Price history preservation | PASS: old row closed, never rewritten |
| Price overlap prevention | PASS: service and database exclusion constraint |
| Location over organization precedence | PASS |
| Placement-level price overrides | DEFERRED (expected); a test asserts no price column on placements |
| Exact money handling | PASS: decimal strings throughout; extra precision refused |

### Modifiers

| Check | Result |
|---|---|
| Group selection rules | PASS: service and check constraint |
| Menu Item group attachment | PASS |
| min/max enforcement | PASS: all four selection types, overrides, inactive choices |
| Inactive behavior | PASS: inactive group not required, inactive modifier refused |
| Price adjustments | PASS |
| Exact prospective item pricing | PASS: 14.99+2.00=16.99, 14.99+1.50+2.00=18.49, zero adjustment unchanged |
| Structured preparation effects | PASS: an instruction modifier requires its text |
| Structured recipe effects | PASS (contracts only) |

### Preparation

| Check | Result |
|---|---|
| Prep stations | PASS: unique per location, stale update refused |
| Menu Item routing | PASS: several stations per item per location, another location's station refused |
| No Kitchen tickets implemented | PASS: a test asserts no ticket, fulfillment, order or inventory table exists |

### Units

| Check | Result |
|---|---|
| Stable unit codes | PASS |
| Exact conversion factors | PASS: 1 LB = 16 OZ_WEIGHT, 1000 G = 1 KG, 1000 ML = 1 L |
| Compatible-dimension conversion | PASS |
| Incompatible conversion rejected | PASS: service, and a composite foreign key in the database |
| No ambiguous OZ usage internally | PASS: a check constraint refuses the code `OZ` |

### Recipes

| Check | Result |
|---|---|
| Menu Item/Recipe separation | PASS: the menu item row carries no recipe or yield data |
| Recipe creation | PASS |
| Yield | PASS: positive, four decimal places |
| Recipe ingredient quantities | DEFERRED TO PHASE 8 (expected) |
| UOM compatibility/conversions | PASS |
| Immutable revision/history preservation | PASS: service, and a trigger on yield, notes, numbering, status and delete |
| Current/effective revision resolution | PASS: half-open boundary, future start, retired history |
| Inventory state absent | PASS |

### Authorization

| Check | Result |
|---|---|
| menu.view | PASS |
| menu.edit | PASS |
| Pricing authorization | PASS: viewing history and changing prices are separate permissions |
| Modifier administration | PASS |
| recipes.view/edit | PASS |
| Direct unauthorized API denied | PASS: E2E, 401 signed out and 403 without the permission |
| Cross-organization access | PASS: another organization's records look absent |

### Future contracts

| Check | Result |
|---|---|
| Order-facing Menu query | PASS |
| Recipe/internal details excluded from operational Menu DTO | PASS: the output is scanned for recipe, cost, version, creator and HR terms |
| Phase 8 Inventory extension point documented | PASS (README §33) |
| Phase 10 preparation routing extension documented | PASS (README §33) |

### Seeds

| Check | Result |
|---|---|
| Phase 6 to 7 permission upgrade | PASS: adds the six codes, restores no grant an administrator removed |
| Seed idempotency | PASS: `12 applied`, then `0 applied, 12 already applied`, with identical counts (93 permissions, 317 role grants) |
| No seeded menu items, prices or recipes | PASS: a test asserts none |

### Regression

| Check | Result |
|---|---|
| Phase 1 foundation | PASS |
| Phase 2 auth/RBAC | PASS |
| Phase 3 Employees/HR | PASS |
| Phase 4 Scheduling | PASS |
| Phase 5 Restaurant/Seating | PASS |
| Phase 6 Reservations/Waitlist | PASS |
| `db:reset` safeguards | PASS |
| `/api/health` | PASS: through the E2E suite |

Real `npm run db:reset` refusals on the throwaway container, with a probe row intact afterward: `NODE_ENV=production`, `NODE_ENV=test`, database `postgres`, database `restaurant_ops_test`, a fake RDS host, and `?host=` on a local URL. The successful reset then seed reproduced the same counts: 93 permissions, 317 role grants, 7 categories, 5 stations, 8 units, 6 conversions, 1 menu, 0 items.

### Validation

| Check | Result |
|---|---|
| PostgreSQL health | PASS |
| `npm ci` | Not re-run; no dependency changed |
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 494 of 494 (baseline 417) |
| Integration tests | PASS: 792 of 792 (baseline 674) |
| E2E tests | PASS: 90 of 90 (baseline 79), one full run |
| Production build | PASS |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | Advisories remain; no dependency changed |
| GitHub Actions | PASS: reported by the project owner after the work was pushed; I did not see the run |

### Problems found during validation

- **Two E2E specs deleted each other's users.** Both used one email-domain marker for cleanup, so whichever finished first removed the other's accounts mid-run, which showed up as pages redirecting to login. Each spec now has its own markers via `createMenuE2e(scope)`.
- **Wrapped selects have long accessible names.** A `<select>` inside a label includes its option text in the name, so label lookups were ambiguous. The specs target those selects by field name.
- **The permission-format test rejected `prep-stations.manage`.** The pattern was widened to allow hyphenated words.
- **The wait on the full E2E run was stopped for low system memory.** The run itself finished: 90 of 90.

## Tests executed

- **Unit (new, 77):** decimal arithmetic; unit conversion and conversion-row validation; price resolution, interval overlap and price-change planning; modifier selection, overrides and group definitions; item pricing; recipe revision numbering, yield, publish, retire and resolution; modifier recipe-effect contracts; navigation.
- **Integration (new, 118):**
  - `menu-config`: categories, items, placements, menus, availability windows, prep stations and routing, authorization.
  - `pricing`: initial price, history, scheduled prices, location precedence, exact `NUMERIC`, stale editor, two simultaneous changes, overlap in the database, tenancy.
  - `modifiers`: groups, rules, attachments and overrides, server-side selection validation, prospective pricing, authorization.
  - `operational-menu`: the Phase 9 contract and what it excludes.
  - `recipes`: identity, revisions, immutability in service and database, publish and resolve, concurrent publish, units, authorization.
  - `authorization`: role matrix and module boundaries.
- **Integration (updated):** migrations (new tables, exclusion constraints, Phase 5 and Phase 6 in-place upgrades), foundation seeds (Phase 6 upgrade, units, categories, stations), seed registry.
- **E2E (`menu.spec.ts` 7, `recipes.spec.ts` 4):** configure an item end to end and see it on the operational menu, mark an item unavailable, Server denied by page and API, signed-out refused, editor without pricing sees no pricing, impossible min/max rejected, modifier price shown, station routing, recipe draft then publish then replace then retire, published revision refused by API, recipe viewer read-only.

**Partly covered:**

- The E2E specs cover the main paths of each editor; every field of every form is not exercised.
- Concurrency is tested for price changes and recipe publishing; the other optimistic-version updates are tested with one stale-update case each.
- Phone-width layout of the new pages was not tested.

## Files changed

**Created**

- Schema and migrations: `src/db/schema/menu.ts`, `src/db/schema/recipes.ts`, `drizzle/migrations/0009_menu_recipes.sql`, `0010_menu_recipes_constraints.sql` and their snapshots
- Helpers: `src/db/helpers/versioned-update.ts`, `src/shared/decimal/`
- Seed: `src/db/seeds/menu-foundation.ts`
- Menu module: `src/modules/menu/` (`rules`, `services`, `queries`, `validators`, `types.ts`)
- Recipes module: `src/modules/recipes/` (`rules`, `services`, `validators`)
- API: 33 Route Handlers under `src/app/api/menu/`, `src/app/api/prep-stations/`, `src/app/api/recipes/`
- UI: `src/app/(app)/menu/` (menu, manage, item editor, modifiers, stations), `src/app/(app)/recipes/` (list, detail), `src/components/menu/`
- Tests: `tests/integration/menu/`, `tests/integration/recipes/`, `tests/e2e/menu.spec.ts`, `tests/e2e/recipes.spec.ts`, `tests/fixtures/menu-fixtures.ts`, `tests/helpers/e2e-menu.ts`, unit tests beside the rules
- Docs: this report

**Modified**

- Schema: `src/db/schema/index.ts`, `organization.ts`, `drizzle/migrations/meta/_journal.json`
- Auth: `permission-catalog.ts` (93 codes), `role-catalog.ts`
- Seeds: `src/db/seeds/registry.ts`
- UI: `navigation.ts`, `entity-form.tsx`
- Tests: `navigation.test.ts`, `auth.test.ts`, `tests/e2e/auth.spec.ts`, `foundation-seeds.test.ts`, `migrations.test.ts`, `seed-framework.test.ts`
- Docs: `README.md` §14, §15, §33, §36

## Risks

- **Price and recipe starts are entered in the browser's local time and shown in UTC.** The UI labels both, but a host working across time zones could misread them.
- **A scheduled price blocks a nearer one.** To change course, an administrator has to wait or deal with the scheduled price first; there is no "cancel scheduled price" action yet.
- **No audit trail beyond provenance columns.** Prices record who created them and revisions record who published and retired them. Other edits (renames, deactivations) record nothing. This follows the audit-domain question carried since Phase 3.
- **`menu_availability` windows are dates, not times of day.** A lunch-only menu needs a different design.
- **The E2E cleanup disables a trigger** inside its own transaction to delete published test revisions. It affects only the test database.
- **`btree_gist` on RDS** remains untested, as noted in Phases 3, 5 and 6. This phase adds three more exclusion constraints that rely on it.

## Remaining issues

None of these block Phase 8.

1. **Where does the audit domain get built? Still your decision,** carried from Phases 3 to 6.
2. **Edit forms are not offered for every field** (for example, a menu item's code is fixed after creation, deliberately).
3. **Carried over, all optional:** the Phase 6 held-table move gap, the old `restaurant-ops-postgres-1` container and volume, the stray `C:\Users\kneal\package-lock.json`, and the unanchored `out/` and `uploads/` rules in `.gitignore`.

## Accepted risks

DEV-001, DEV-002 and DEV-003: unchanged. No dependencies were added.

## Business domains created beyond Phase 7

NONE. A migration test asserts the exact table list, and another asserts no ingredient, inventory, order, ticket, supplier or purchase table exists. No stock, order, fulfillment, settlement, reporting or audit code was added.

## Next-phase readiness

**Phase 8 readiness: READY,** subject to review of this report. Phase 8 adds `recipe_version_ingredients` against `recipe_versions`, persists the modifier effect contract in `src/modules/recipes/rules/modifier-recipe-effects.ts`, and uses `units_of_measure` and `unit_conversions` for quantity conversion. Phase 9 reads `getOperationalMenu`, `validateSelection` and `resolveMenuItemPrice`.
