# Phase 13 Validation Seed Data

The validation fixtures are registered as `phase13.validation-fixtures.v2` in the existing `applicationSeeds` list. `npm run db:seed` and `npm run db:seed:test` therefore load the same fixture through the normal transactional seed runner. The v2 key preserves the previously applied v1 fixture and its 2026 published schedule as historical data.

The fixture requires the existing Phase 2, 3, 5, 7, 8, and 12 seeds. It reuses the Phase 5 dining room tables and sections, and adds four employees with a published `Phase 13 Validation Week 2030` schedule (2030-10-05 through 2030-10-11) and one server-section assignment. The future schedule week avoids overlapping other integration-test schedule fixtures.

It adds the `P13_BACON_CHEESEBURGER` menu item with Medium, No Onion, Extra Pickles, American, and Swiss instead of American modifiers. Recipe and modifier inventory effects support the Swiss substitution and extra pickles. Opening inventory is posted through the Inventory domain; the historical order consumption is posted through the Orders/Inventory transaction API so the ledger and balances agree.

Historical records include a completed dine-in validation party and reservation, a dine-in Bacon Cheeseburger with all four canonical selections, a takeout Bacon Cheeseburger, fulfillment tickets and status history, completed cash settlements, and inventory consumption. A separate confirmed reservation named `Phase 13 Validation Party` is assigned to T02 for check-in/seating tests.

The actor `phase13-validation-actor@seed.invalid` is created only for fixture provenance and receives a random, undisclosed password hash. It is not a demo login account.

Run after migrations:

```text
npm run db:seed
npm run db:seed
```

The runner records the seed key and executes all fixture inserts in one transaction. A second invocation skips the seed. When changing this fixture after it has been applied to a persistent database, add a new versioned seed key rather than deleting the existing `seed_runs` marker or rewriting historical rows.
