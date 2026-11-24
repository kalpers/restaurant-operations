import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import { assertNotBundleComponent, bundleComponentColumns, bundleParentColumns, choiceInBundle, componentTicketName } from "./bundle-lines";

const codeOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as AppError).code;
  }

  return undefined;
};

describe("bundle lines (Phase 36 policy 9)", () => {
  it("prices the bundle line from its price and the chosen upcharges", () => {
    expect(bundleParentColumns({ code: "COMBO", name: "Burger Combo", price: "18.00" }, ["0.00", "1.50", "0.00"])).toEqual({
      menuItemCodeSnapshot: "COMBO",
      menuItemNameSnapshot: "Burger Combo",
      basePriceSnapshot: "18.00",
      modifierTotalSnapshot: "1.50",
      unitPriceSnapshot: "19.50",
      lineTotalSnapshot: "19.50",
    });
  });

  it("prices every component at zero", () => {
    expect(bundleComponentColumns({ code: "BURGER", name: "Bacon Cheeseburger" })).toMatchObject({
      basePriceSnapshot: "0.00",
      modifierTotalSnapshot: "0.00",
      unitPriceSnapshot: "0.00",
      lineTotalSnapshot: "0.00",
    });
  });

  it("finds a choice's slot and upcharge in the bundle as offered", () => {
    const bundle = {
      slots: [
        {
          id: "side",
          name: "Side",
          defaultCourse: 1,
          minimumChoices: 1,
          maximumChoices: 1,
          options: [{ optionId: "o1", menuItemId: "rings", name: "Onion rings", upcharge: "1.50", isDefault: false }],
        },
      ],
    };

    expect(choiceInBundle(bundle, "side", "rings")).toEqual({ slotName: "Side", upcharge: "1.50" });
    expect(codeOf(() => choiceInBundle(bundle, "side", "fries"))).toBe("BUNDLE_OPTION_UNAVAILABLE");
  });

  it("names a component with its bundle on the ticket, and refuses acting on a component alone", () => {
    expect(componentTicketName("Bacon Cheeseburger", "Burger Combo")).toBe("Bacon Cheeseburger (Burger Combo)");
    expect(codeOf(() => assertNotBundleComponent({ bundleParentOrderItemId: "p" }, "move"))).toBe("BUNDLE_COMPONENT");
    expect(codeOf(() => assertNotBundleComponent({ bundleParentOrderItemId: null }, "move"))).toBeUndefined();
  });
});
