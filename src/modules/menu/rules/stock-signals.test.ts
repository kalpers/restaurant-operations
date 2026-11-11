import { describe, expect, it } from "vitest";

import {
  isRunningLow,
  isSellable,
  portionsRemaining,
  sellabilityState,
  type OnHand,
} from "./stock-signals";

const stock = (entries: Record<string, string | OnHand>) =>
  new Map(
    Object.entries(entries).map(([id, value]) => [
      id,
      typeof value === "string" ? { stocked: true, quantityOnHand: value } : value,
    ]),
  );

describe("portionsRemaining (policy A3)", () => {
  it("takes the lowest whole count across ingredients", () => {
    expect(
      portionsRemaining(
        [
          { inventoryItemId: "beef", baseQuantity: "8.0000" },
          { inventoryItemId: "bun", baseQuantity: "1.0000" },
        ],
        stock({ beef: "100.0000", bun: "30.0000" }),
      ),
    ).toEqual({ portions: 12, limitingInventoryItemId: "beef" });
  });

  it("floors fractional quantities and counts exact multiples", () => {
    const requirement = [{ inventoryItemId: "a", baseQuantity: "0.3333" }];

    expect(portionsRemaining(requirement, stock({ a: "0.9999" })).portions).toBe(3);
    expect(portionsRemaining(requirement, stock({ a: "0.9998" })).portions).toBe(2);
  });

  it("counts zero for nothing, negative or not stocked", () => {
    const requirement = [{ inventoryItemId: "a", baseQuantity: "1" }];

    expect(portionsRemaining(requirement, stock({ a: "0.0000" })).portions).toBe(0);
    expect(portionsRemaining(requirement, stock({ a: "-4.0000" })).portions).toBe(0);
    expect(portionsRemaining(requirement, stock({ a: { stocked: false, quantityOnHand: "50" } })).portions).toBe(0);
    expect(portionsRemaining(requirement, new Map()).portions).toBe(0);
  });

  it("gives no figure without a recipe or ingredients", () => {
    expect(portionsRemaining(null, new Map())).toEqual({ portions: null, limitingInventoryItemId: null });
    expect(portionsRemaining([], new Map()).portions).toBeNull();
  });

  it("keeps the first ingredient on a tie", () => {
    expect(
      portionsRemaining(
        [
          { inventoryItemId: "x", baseQuantity: "2" },
          { inventoryItemId: "y", baseQuantity: "1" },
        ],
        stock({ x: "10", y: "5" }),
      ).limitingInventoryItemId,
    ).toBe("x");
  });
});

describe("sellabilityState (policies A4-A6)", () => {
  const base = { available: true, manuallyOut: false, autoEnabled: true, portions: 3, sellAnyway: false };

  it("puts available = false above everything", () => {
    expect(sellabilityState({ ...base, available: false, sellAnyway: true })).toBe("UNAVAILABLE");
  });

  it("puts a manual 86 above sell anyway", () => {
    expect(sellabilityState({ ...base, manuallyOut: true, portions: 0, sellAnyway: true })).toBe("MANUAL_86");
  });

  it("auto-86es at zero portions only when the setting is on", () => {
    expect(sellabilityState({ ...base, portions: 0 })).toBe("AUTO_86");
    expect(sellabilityState({ ...base, portions: 0, autoEnabled: false })).toBe("SELLABLE");
    expect(sellabilityState({ ...base, portions: null })).toBe("SELLABLE");
    expect(sellabilityState({ ...base, portions: 1 })).toBe("SELLABLE");
  });

  it("lets sell anyway lift auto-86", () => {
    const state = sellabilityState({ ...base, portions: 0, sellAnyway: true });

    expect(state).toBe("SELL_ANYWAY");
    expect(isSellable(state)).toBe(true);
    expect(isSellable("AUTO_86")).toBe(false);
  });

  it("marks 1 to 5 portions as running low", () => {
    expect([null, 0, 1, 5, 6].map(isRunningLow)).toEqual([false, false, true, true, false]);
  });
});
