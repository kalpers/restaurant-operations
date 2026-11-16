import { describe, expect, it } from "vitest";

import {
  averagePortionRequirements,
  forecastItems,
  modifierCount,
  prepPortions,
  remainingPortions,
  sumRequirements,
  usageFor,
} from "./item-forecast-rules";

const BURGER = "00000000-0000-4000-8000-000000000001";
const SALAD = "00000000-0000-4000-8000-000000000002";
const PICKLES_EXTRA = "00000000-0000-4000-8000-0000000000a1";
const NO_ONION = "00000000-0000-4000-8000-0000000000a2";
const SWISS = "00000000-0000-4000-8000-0000000000a3";
const BEEF = "10000000-0000-4000-8000-000000000001";
const ONION = "10000000-0000-4000-8000-000000000002";
const PICKLES = "10000000-0000-4000-8000-000000000003";
const AMERICAN = "10000000-0000-4000-8000-000000000004";
const SWISS_CHEESE = "10000000-0000-4000-8000-000000000005";

const map = <V>(entries: [string, V][]) => new Map(entries);

describe("forecastItems (policies 3 and 6)", () => {
  const sampleDates = ["2026-11-09", "2026-11-02", "2026-10-26"];
  const portions = map([
    ["2026-11-09", map([[BURGER, 30]])],
    ["2026-11-02", map([[BURGER, 20], [SALAD, 4]])],
    ["2026-10-26", map([[BURGER, 10]])],
  ]);
  const modifiers = map([
    ["2026-11-09", map([[BURGER, map([[PICKLES_EXTRA, 15]])]])],
    ["2026-11-02", map([[BURGER, map([[PICKLES_EXTRA, 5]])]])],
  ]);

  it("weights newest first and counts an unsold usable date as zero", () => {
    const result = forecastItems({
      sampleDates,
      minimumSamples: 3,
      menuItemIds: [BURGER, SALAD],
      portions,
      modifiers,
      firstSaleDates: map([[BURGER, "2026-01-01"], [SALAD, "2026-01-01"]]),
    });

    expect(result.status).toBe("OK");
    // (3 × 30 + 2 × 20 + 1 × 10) / 6 = 23.33
    expect(result.items[0]).toMatchObject({ menuItemId: BURGER, portions: "23.33", newItem: false });
    // (3 × 0 + 2 × 4 + 0) / 6 = 1.33
    expect(result.items[1]).toMatchObject({ menuItemId: SALAD, portions: "1.33", modifierShares: [] });
  });

  it("works out modifier shares over the dates the item sold, weighted", () => {
    const [burger] = forecastItems({
      sampleDates,
      minimumSamples: 3,
      menuItemIds: [BURGER],
      portions,
      modifiers,
      firstSaleDates: map([[BURGER, "2026-01-01"]]),
    }).items;

    // Shares 0.5, 0.25, 0: (3 × 0.5 + 2 × 0.25 + 0) / 6 = 0.3333
    expect(burger!.modifierShares).toEqual([{ modifierId: PICKLES_EXTRA, share: "0.3333" }]);
  });

  it("has no forecast below the minimum, and flags new items", () => {
    const result = forecastItems({
      sampleDates: sampleDates.slice(0, 2),
      minimumSamples: 3,
      menuItemIds: [BURGER, SALAD],
      portions,
      modifiers,
      firstSaleDates: map([[BURGER, "2026-11-02"]]),
    });

    expect(result.status).toBe("NOT_ENOUGH_HISTORY");
    expect(result.items).toEqual([
      { menuItemId: BURGER, portions: null, newItem: false, modifierShares: [] },
      { menuItemId: SALAD, portions: null, newItem: true, modifierShares: [] },
    ]);
    expect(
      forecastItems({ sampleDates, minimumSamples: 3, menuItemIds: [BURGER], portions, modifiers, firstSaleDates: map([[BURGER, "2026-11-02"]]) })
        .items[0]!.newItem,
    ).toBe(true);
  });
});

describe("remainingPortions (policy 8)", () => {
  it("subtracts what was sent today and never goes below zero", () => {
    expect(remainingPortions("23.33", 10)).toBe("13.33");
    expect(remainingPortions("5.00", 9)).toBe("0.00");
  });
});

describe("averagePortionRequirements (policy 7)", () => {
  const requirements = [
    { inventoryItemId: BEEF, baseQuantity: "0.2500" },
    { inventoryItemId: ONION, baseQuantity: "0.0300" },
    { inventoryItemId: PICKLES, baseQuantity: "0.0200" },
    { inventoryItemId: AMERICAN, baseQuantity: "1.0000" },
  ];
  const effects = [
    { modifierId: PICKLES_EXTRA, operation: "ADJUST" as const, inventoryItemId: PICKLES, baseQuantity: "0.0200" },
    { modifierId: NO_ONION, operation: "REMOVE" as const, inventoryItemId: ONION },
    { modifierId: SWISS, operation: "REMOVE" as const, inventoryItemId: AMERICAN },
    { modifierId: SWISS, operation: "ADD" as const, inventoryItemId: SWISS_CHEESE, baseQuantity: "1.0000" },
  ];

  it("adds each modifier's share of its own change: ADJUST, REMOVE and a substitution", () => {
    expect(
      averagePortionRequirements({
        requirements,
        effects,
        shares: [
          { modifierId: PICKLES_EXTRA, share: "0.5000" },
          { modifierId: NO_ONION, share: "0.2500" },
          { modifierId: SWISS, share: "0.1000" },
        ],
      }),
    ).toEqual([
      { inventoryItemId: BEEF, baseQuantity: "0.2500" },
      // 0.03 − 0.25 × 0.03
      { inventoryItemId: ONION, baseQuantity: "0.02250000" },
      // 0.02 + 0.5 × 0.02
      { inventoryItemId: PICKLES, baseQuantity: "0.03000000" },
      // 1 − 0.1 × 1
      { inventoryItemId: AMERICAN, baseQuantity: "0.90000000" },
      { inventoryItemId: SWISS_CHEESE, baseQuantity: "0.10000000" },
    ].sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId)));
  });

  it("keeps the recipe as it is without modifiers, and gives nothing for no recipe and no effects", () => {
    expect(averagePortionRequirements({ requirements, effects, shares: [] })).toEqual(requirements);
    expect(averagePortionRequirements({ requirements: [], effects: [], shares: [{ modifierId: NO_ONION, share: "1.0000" }] })).toEqual([]);
  });

  it("drops an ingredient every portion removes", () => {
    const result = averagePortionRequirements({ requirements, effects, shares: [{ modifierId: NO_ONION, share: "1.0000" }] });

    expect(result.find((entry) => entry.inventoryItemId === ONION)).toBeUndefined();
  });
});

describe("usage and sums (policy 7)", () => {
  it("multiplies portions by the average portion to four places, and sums by item", () => {
    const usage = usageFor("23.33", [{ inventoryItemId: BEEF, baseQuantity: "0.2500" }, { inventoryItemId: ONION, baseQuantity: "0.02250000" }]);

    expect(usage).toEqual([
      { inventoryItemId: BEEF, baseQuantity: "5.8325" },
      // 23.33 × 0.0225 = 0.524925
      { inventoryItemId: ONION, baseQuantity: "0.5249" },
    ]);
    expect(sumRequirements([usage, [{ inventoryItemId: BEEF, baseQuantity: "1.0000" }]])).toEqual([
      { inventoryItemId: BEEF, baseQuantity: "6.8325" },
      { inventoryItemId: ONION, baseQuantity: "0.5249" },
    ]);
  });
});

describe("prep rounding (policy 9)", () => {
  it("rounds portions up and modifier counts half up", () => {
    expect(prepPortions("23.33")).toBe(24);
    expect(prepPortions("23.00")).toBe(23);
    expect(prepPortions("0.00")).toBe(0);
    expect(modifierCount(24, "0.3333")).toBe(8);
    expect(modifierCount(3, "0.1000")).toBe(0);
  });
});
