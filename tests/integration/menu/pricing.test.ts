import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { menuItemPrices } from "@/db/schema";
import {
  changePrice,
  listPriceHistory,
  resolveMenuItemPrice,
} from "@/modules/menu/services/pricing-service";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  createMenuScenario,
  itemFixture,
  LONG_AGO,
  priceFixture,
  type MenuScenario,
} from "../../fixtures/menu-fixtures";

const database = () => getDatabase();
const at = (iso: string) => new Date(iso);

describe("menu item pricing", () => {
  let scenario: MenuScenario;

  beforeEach(async () => {
    scenario = await createMenuScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const resolve = (menuItemId: string, instant: Date, locationId = scenario.locationA) =>
    resolveMenuItemPrice(database(), scenario.organizationId, menuItemId, locationId, instant);

  it("sets an initial price and resolves it", async () => {
    const item = await itemFixture(database(), scenario.admin);

    await priceFixture(database(), scenario.admin, item.id, "12.99");

    expect(await resolve(item.id, at("2026-01-01T00:00:00Z"))).toEqual({
      price: "12.99",
      scope: "ORGANIZATION",
    });
  });

  it("has no price before one is set", async () => {
    const item = await itemFixture(database(), scenario.admin);

    expect(await resolve(item.id, new Date())).toBeNull();
  });

  it("closes the old price and inserts a new one, preserving history", async () => {
    const item = await itemFixture(database(), scenario.admin);
    const first = await priceFixture(database(), scenario.admin, item.id, "12.99", {
      from: at("2026-01-01T00:00:00Z"),
    });

    const second = await changePrice(
      database(),
      scenario.admin,
      item.id,
      { locationId: null, price: "13.99", effectiveFrom: null },
      at("2026-06-01T00:00:00Z"),
    );

    expect(second.effectiveFrom).toEqual(at("2026-06-01T00:00:00Z"));

    const history = await listPriceHistory(
      database(),
      scenario.admin,
      item.id,
      at("2026-07-01T00:00:00Z"),
    );

    expect(history.map((row) => [row.price, row.effectiveTo?.toISOString() ?? null])).toEqual([
      ["12.99", "2026-06-01T00:00:00.000Z"],
      ["13.99", null],
    ]);
    // The original row was closed, never rewritten.
    const [stored] = await database()
      .select()
      .from(menuItemPrices)
      .where(eq(menuItemPrices.id, first.id));

    expect(stored?.price).toBe("12.99");
    expect(history.find((row) => row.current)?.price).toBe("13.99");
    expect((await resolve(item.id, at("2026-03-01T00:00:00Z")))?.price).toBe("12.99");
    expect((await resolve(item.id, at("2026-06-01T00:00:00Z")))?.price).toBe("13.99");
  });

  it("does not select a scheduled price early", async () => {
    const item = await itemFixture(database(), scenario.admin);
    const now = at("2026-01-01T00:00:00Z");

    await priceFixture(database(), scenario.admin, item.id, "10.00", { from: LONG_AGO });
    await changePrice(
      database(),
      scenario.admin,
      item.id,
      { locationId: null, price: "11.00", effectiveFrom: at("2026-06-01T00:00:00Z") },
      now,
    );

    expect((await resolve(item.id, at("2026-05-31T23:59:59.999Z")))?.price).toBe("10.00");
    expect((await resolve(item.id, at("2026-06-01T00:00:00Z")))?.price).toBe("11.00");
  });

  it("prefers a location price over the organization default", async () => {
    const item = await itemFixture(database(), scenario.admin);

    await priceFixture(database(), scenario.admin, item.id, "10.00");
    await priceFixture(database(), scenario.admin, item.id, "12.50", {
      locationId: scenario.locationA,
    });

    expect(await resolve(item.id, at("2026-01-01T00:00:00Z"))).toEqual({
      price: "12.50",
      scope: "LOCATION",
    });
    // Another location still sees the default.
    expect(await resolve(item.id, at("2026-01-01T00:00:00Z"), scenario.locationB)).toEqual({
      price: "10.00",
      scope: "ORGANIZATION",
    });
  });

  it("changes a location price without disturbing the default", async () => {
    const item = await itemFixture(database(), scenario.admin);

    await priceFixture(database(), scenario.admin, item.id, "10.00");
    await priceFixture(database(), scenario.admin, item.id, "12.50", {
      locationId: scenario.locationA,
      from: at("2026-01-01T00:00:00Z"),
    });
    await changePrice(
      database(),
      scenario.admin,
      item.id,
      { locationId: scenario.locationA, price: "13.00", effectiveFrom: null },
      at("2026-03-01T00:00:00Z"),
    );

    expect((await resolve(item.id, at("2026-04-01T00:00:00Z")))?.price).toBe("13.00");
    expect(
      (await resolve(item.id, at("2026-04-01T00:00:00Z"), scenario.locationB))?.price,
    ).toBe("10.00");
  });

  it("stores exact NUMERIC values, with no floating-point drift", async () => {
    const item = await itemFixture(database(), scenario.admin);

    await priceFixture(database(), scenario.admin, item.id, "0.10");

    const [row] = await database()
      .select()
      .from(menuItemPrices)
      .where(eq(menuItemPrices.menuItemId, item.id));

    expect(row?.price).toBe("0.10");
    expect(typeof row?.price).toBe("string");
  });

  it("rejects prices with extra decimal places, negatives and non-numbers", async () => {
    const item = await itemFixture(database(), scenario.admin);

    for (const price of ["1.005", "-1.00", "abc"]) {
      await expect(
        changePrice(database(), scenario.admin, item.id, {
          locationId: null,
          price,
          effectiveFrom: null,
        }),
      ).rejects.toMatchObject({ code: "INVALID_PRICE" });
    }
  });

  it("allows a free item", async () => {
    const item = await itemFixture(database(), scenario.admin);

    await priceFixture(database(), scenario.admin, item.id, "0");

    expect((await resolve(item.id, new Date()))?.price).toBe("0.00");
  });

  it("refuses a start in the past, and a start that is not after the current price", async () => {
    const item = await itemFixture(database(), scenario.admin);
    const now = at("2026-06-01T00:00:00Z");

    await expect(
      changePrice(
        database(),
        scenario.admin,
        item.id,
        { locationId: null, price: "5.00", effectiveFrom: at("2026-05-01T00:00:00Z") },
        now,
      ),
    ).rejects.toMatchObject({ code: "EFFECTIVE_DATE_IN_PAST" });

    await changePrice(
      database(),
      scenario.admin,
      item.id,
      { locationId: null, price: "5.00", effectiveFrom: null },
      now,
    );
    await expect(
      changePrice(
        database(),
        scenario.admin,
        item.id,
        { locationId: null, price: "6.00", effectiveFrom: null },
        now,
      ),
    ).rejects.toMatchObject({ code: "NOT_AFTER_CURRENT" });
  });

  it("refuses to jump ahead of a price already scheduled", async () => {
    const item = await itemFixture(database(), scenario.admin);
    const now = at("2026-01-01T00:00:00Z");

    await changePrice(
      database(),
      scenario.admin,
      item.id,
      { locationId: null, price: "5.00", effectiveFrom: null },
      now,
    );
    await changePrice(
      database(),
      scenario.admin,
      item.id,
      { locationId: null, price: "7.00", effectiveFrom: at("2026-09-01T00:00:00Z") },
      now,
    );
    await expect(
      changePrice(
        database(),
        scenario.admin,
        item.id,
        { locationId: null, price: "6.00", effectiveFrom: at("2026-05-01T00:00:00Z") },
        now,
      ),
    ).rejects.toMatchObject({ code: "FUTURE_PRICE_EXISTS" });
  });

  it("rejects a stale editor whose view of the current price is out of date", async () => {
    const item = await itemFixture(database(), scenario.admin);
    const now = at("2026-06-01T00:00:00Z");
    const shown = await priceFixture(database(), scenario.admin, item.id, "10.00", {
      from: at("2026-01-01T00:00:00Z"),
    });
    const change = (price: string) =>
      changePrice(
        database(),
        scenario.admin,
        item.id,
        { locationId: null, price, effectiveFrom: null, expectedCurrentPriceId: shown.id },
        now,
      );

    await change("11.00");
    await expect(change("12.00")).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("serializes two simultaneous changes: one wins, the other is refused", async () => {
    const item = await itemFixture(database(), scenario.admin);
    const now = at("2026-06-01T00:00:00Z");

    await priceFixture(database(), scenario.admin, item.id, "10.00", {
      from: at("2026-01-01T00:00:00Z"),
    });

    const results = await Promise.allSettled(
      ["11.00", "12.00"].map((price) =>
        changePrice(
          database(),
          scenario.admin,
          item.id,
          { locationId: null, price, effectiveFrom: null },
          now,
        ),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const history = await listPriceHistory(database(), scenario.admin, item.id, now);

    expect(history.filter((row) => row.effectiveTo === null)).toHaveLength(1);
  });

  it("prevents overlapping prices in the database itself", async () => {
    const item = await itemFixture(database(), scenario.admin);

    await priceFixture(database(), scenario.admin, item.id, "10.00");

    await expect(
      database().insert(menuItemPrices).values({
        organizationId: scenario.organizationId,
        menuItemId: item.id,
        locationId: null,
        price: "11.00",
        effectiveFrom: at("2026-01-01T00:00:00Z"),
        createdByUserId: scenario.ownerUser.id,
      }),
    ).rejects.toThrow();
  });

  it("has no placement-level price override", async () => {
    const columns = await database().execute(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'menu_item_placements'` as never,
    );
    const names = (columns as unknown as { column_name: string }[]).map((row) => row.column_name);

    expect(names.filter((name) => name.includes("price"))).toEqual([]);
  });

  describe("authorization and tenancy", () => {
    it("requires menu.pricing.edit to change a price", async () => {
      const item = await itemFixture(database(), scenario.admin);

      await expect(
        changePrice(database(), scenario.viewer, item.id, {
          locationId: null,
          price: "5.00",
          effectiveFrom: null,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("requires menu.pricing.view to read history", async () => {
      const item = await itemFixture(database(), scenario.admin);

      await expect(
        listPriceHistory(database(), scenario.viewer, item.id),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("treats another organization's item as absent", async () => {
      const item = await itemFixture(database(), scenario.admin);

      await expect(
        changePrice(database(), scenario.other, item.id, {
          locationId: null,
          price: "5.00",
          effectiveFrom: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        await resolveMenuItemPrice(
          database(),
          scenario.otherScenario.organizationId,
          item.id,
          scenario.otherScenario.locationA,
          new Date(),
        ),
      ).toBeNull();
    });

    it("refuses a location price for another organization's location", async () => {
      const item = await itemFixture(database(), scenario.admin);

      await expect(
        changePrice(database(), scenario.admin, item.id, {
          locationId: scenario.otherScenario.locationA,
          price: "5.00",
          effectiveFrom: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
