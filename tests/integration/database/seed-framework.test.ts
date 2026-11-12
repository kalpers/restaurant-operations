import { count, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { seedRuns } from "@/db/schema";
import { seeds as registeredSeeds } from "@/db/seeds/registry";
import { runSeeds, type Seed } from "@/db/seeds/run-seeds";

import {
  clearFixtureTables,
  createFixtureTables,
  dropFixtureTables,
  fixtureParents,
} from "../../fixtures/convention-fixtures";

function seedCreatingParent(key: string): Seed {
  return {
    key,
    run: async (transaction) => {
      await transaction.insert(fixtureParents).values({ code: key, label: key });
    },
  };
}

async function totals() {
  const database = getDatabase();
  const [markers] = await database.select({ total: count() }).from(seedRuns);
  const [records] = await database.select({ total: count() }).from(fixtureParents);

  return { markers: markers?.total, records: records?.total };
}

describe("runSeeds", () => {
  beforeAll(async () => {
    await createFixtureTables(getDatabase());
  });

  beforeEach(async () => {
    await clearFixtureTables(getDatabase());
  });

  afterAll(async () => {
    await dropFixtureTables(getDatabase());
    await closeDatabase();
  });

  it("runs a seed once however many times it is invoked", async () => {
    const run = vi.fn(seedCreatingParent("fixture.one").run);
    const seeds = [{ key: "fixture.one", run }];

    const results = [
      await runSeeds(getDatabase(), seeds),
      await runSeeds(getDatabase(), seeds),
      await runSeeds(getDatabase(), seeds),
    ];

    expect(run).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.applied)).toEqual([
      ["fixture.one"],
      [],
      [],
    ]);
    expect(results[2]?.skipped).toEqual(["fixture.one"]);
    expect(await totals()).toEqual({ markers: 1, records: 1 });
  });

  it("runs only new seeds when more are added later", async () => {
    await runSeeds(getDatabase(), [seedCreatingParent("fixture.one")]);

    const result = await runSeeds(getDatabase(), [
      seedCreatingParent("fixture.one"),
      seedCreatingParent("fixture.two"),
    ]);

    expect(result).toEqual({
      applied: ["fixture.two"],
      skipped: ["fixture.one"],
    });
    expect(await totals()).toEqual({ markers: 2, records: 2 });
  });

  it("rolls back a failed seed and its key so it can be retried", async () => {
    const failure = new Error("deliberate failure");
    const failing: Seed = {
      key: "fixture.failing",
      run: async (transaction) => {
        await seedCreatingParent("fixture.failing").run(transaction);
        throw failure;
      },
    };

    await expect(runSeeds(getDatabase(), [failing])).rejects.toBe(failure);
    expect(await totals()).toEqual({ markers: 0, records: 0 });

    const retried = await runSeeds(getDatabase(), [
      seedCreatingParent("fixture.failing"),
    ]);

    expect(retried.applied).toEqual(["fixture.failing"]);
    expect(await totals()).toEqual({ markers: 1, records: 1 });
  });

  it("keeps earlier seeds and stops at the first failure", async () => {
    const later = vi.fn(seedCreatingParent("fixture.later").run);

    await expect(
      runSeeds(getDatabase(), [
        seedCreatingParent("fixture.first"),
        {
          key: "fixture.failing",
          run: () => Promise.reject(new Error("deliberate failure")),
        },
        { key: "fixture.later", run: later },
      ]),
    ).rejects.toThrow("deliberate failure");

    expect(later).not.toHaveBeenCalled();

    const rows = await getDatabase()
      .select()
      .from(seedRuns)
      .where(eq(seedRuns.seedKey, "fixture.first"));
    expect(rows).toHaveLength(1);
    expect(await totals()).toEqual({ markers: 1, records: 1 });
  });

  it("allows only one of two simultaneous runs to apply a seed", async () => {
    const run = vi.fn(seedCreatingParent("fixture.one").run);
    const seeds = [{ key: "fixture.one", run }];

    await Promise.all([
      runSeeds(getDatabase(), seeds),
      runSeeds(getDatabase(), seeds),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(await totals()).toEqual({ markers: 1, records: 1 });
  });

  it("rejects duplicate keys before running anything", async () => {
    const run = vi.fn(() => Promise.resolve());

    await expect(
      runSeeds(getDatabase(), [
        { key: "fixture.same", run },
        { key: "fixture.same", run },
      ]),
    ).rejects.toThrow("Duplicate seed key: fixture.same");

    expect(run).not.toHaveBeenCalled();
    expect(await totals()).toEqual({ markers: 0, records: 0 });
  });

  it("registers the foundation seeds, organization first", () => {
    expect(registeredSeeds.map((seed) => seed.key)).toEqual([
      "organization.initial",
      "security.initial",
      "security.hr-permissions-v2",
      "employees.reference-data",
      "security.scheduling-permissions",
      "scheduling.default-rules",
      "security.restaurant-permissions",
      "restaurant.initial-floor",
      "security.reservations-permissions",
      "security.menu-permissions",
      "recipes.units-of-measure",
      "menu.initial-configuration",
      "security.inventory-permissions",
      "inventory.packaging-units",
      "inventory.demo-catalog",
      "security.orders-permissions",
      "security.kitchen-permissions",
      "security.settlement-permissions",
      "security.system-permissions",
      "security.checks-closeout-permissions",
      "security.labor-tips-permissions",
      "security.menu-stock-permissions",
      "security.service-polish-permissions",
    ]);
  });
});
