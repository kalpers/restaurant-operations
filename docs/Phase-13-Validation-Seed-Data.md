# Phase 13 Validation Seed Data

An opt-in fixture for validating the full restaurant chain in a local development database. It is **not** part of `npm run db:seed`. By the owner's decision (2026-11-09), fake staff and order history must never reach a shared database or the Phase 14 AWS database.

## Running it

```text
npm run db:migrate
npm run db:seed
npm run bootstrap:owner
npm run db:seed:validation
npm run db:seed:validation    # second run: "already applied; nothing to do"
```

The script (`scripts/seed-validation.ts`) refuses to run unless `DATABASE_URL` points at this machine (`localhost`, `127.0.0.1` or `[::1]`) and `NODE_ENV` is not `production`. This is the same guard `db:seed:demo` uses, now shared in `scripts/local-seed-guard.ts`.

## How it is built

It acts as the bootstrapped MAIN **Owner**, through the same services and workflows a person would use. It writes no table directly, except the `seed_runs` marker at the end. Every ledger row, balance, snapshot, kitchen ticket, settlement and audit event is the one the real workflow writes.

No separate fixture account is created. An account that can do all of this would need Owner-level permissions, and a dormant account like that is a risk with no benefit.

The services commit their own transactions, so the fixture is not one transaction. Instead, each step first checks whether an earlier run already did it:

- employees, by employee number;
- the schedule, by period name, then its shifts and assignments;
- the visits, by guest or customer name.

An interrupted run therefore resumes without duplicates. If an earlier run stopped partway through a visit, the script stops and says which record to finish or cancel in the app. A completed run is recorded as `phase13.validation-fixtures` in `seed_runs` and skipped from then on.

The records are dated when the script runs, because the services use the real clock. The schedule week has its own explicit dates.

## What it adds

The fixture definitions are in `src/db/demo/validation-fixture.ts`.

- **Menu and stock.** The demo kitchen (`seedDemoKitchen`, the same as `db:seed:demo`, and itself idempotent) supplies these, all through services:
  - the Bacon Cheeseburger, with Medium, No Onion, Extra Pickles and Swiss instead of American;
  - its recipe, modifier inventory effects and stations;
  - its suppliers, and purchase-order receipts that build the stock.
- **Four employees** (`P13-SERVER`, `P13-HOST`, `P13-COOK`, `P13-BAR`), each with an hourly wage for their position and availability every day.
- **A published schedule**, "Phase 13 Validation Week 2030" (2030-10-05 to 2030-10-11), with one filled shift per employee on 2030-10-05.
- **A section assignment.** The validation server is assigned to the seeded `DINING_A` section, with a recorded schedule-override reason, because the 2030 shift isn't running now.
- **A completed dine-in visit** ("Phase 13 Validation Diner"):
  1. a reservation is checked in;
  2. the party is seated at a clean dining table;
  3. the canonical burger is sent, and the kitchen runs it through Start, Ready and Complete;
  4. a cash settlement closes the order;
  5. the session completes, the table goes DIRTY, then it is cleaned.
- **A takeout check** ("Phase 13 Validation Takeout") for the same burger: sent, fulfilled, settled in cash and closed.
- **An upcoming reservation**, "Phase 13 Validation Party", for 4 at 19:00 tomorrow. It is CONFIRMED and planned on T02, for check-in and seating tests.

## Changing it

Once the fixture has been applied to a database, don't edit it in place. Add a new versioned key and fixture instead. Don't delete the `seed_runs` marker or rewrite the historical rows it created.

## Tested by

`tests/integration/validation/validation-seed.test.ts` builds a separate database: migrate, seed, bootstrap the Owner, then run the fixture twice. It checks:

- the second run adds no row to any of 19 tables;
- the schedule is published with four filled shifts;
- both checks are closed with settlements equal to the order amount;
- every inventory balance equals its ledger;
- the upcoming party is CONFIRMED on T02 with no session;
- no table is left dirty and no session is left open;
- the guard refuses a non-local database.
