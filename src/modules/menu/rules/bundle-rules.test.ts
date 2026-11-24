import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import { assertBundleShape, slotsFillable, validateBundleChoices, type BundleSlotFacts } from "./bundle-rules";

const codeOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as AppError).code;
  }

  return undefined;
};

const slots: BundleSlotFacts[] = [
  { id: "main", name: "Main", minimumChoices: 1, maximumChoices: 1, options: [{ menuItemId: "burger", upcharge: "0.00" }] },
  {
    id: "side",
    name: "Side",
    minimumChoices: 1,
    maximumChoices: 2,
    options: [
      { menuItemId: "fries", upcharge: "0.00" },
      { menuItemId: "rings", upcharge: "1.50" },
    ],
  },
  { id: "extra", name: "Extra", minimumChoices: 0, maximumChoices: 1, options: [{ menuItemId: "pie", upcharge: "3.00" }] },
];

describe("bundle rules (Phase 36 policy 9)", () => {
  it("returns each choice's upcharge, in order", () => {
    expect(
      validateBundleChoices(slots, [
        { slotId: "main", menuItemId: "burger" },
        { slotId: "side", menuItemId: "rings" },
        { slotId: "side", menuItemId: "fries" },
      ]),
    ).toEqual(["0.00", "1.50", "0.00"]);
  });

  it("needs each slot's minimum, allows up to its maximum, and an optional slot may be empty", () => {
    expect(codeOf(() => validateBundleChoices(slots, [{ slotId: "main", menuItemId: "burger" }]))).toBe("BUNDLE_CHOICES_REQUIRED");
    expect(
      codeOf(() =>
        validateBundleChoices(slots, [
          { slotId: "main", menuItemId: "burger" },
          { slotId: "side", menuItemId: "fries" },
          { slotId: "extra", menuItemId: "pie" },
        ]),
      ),
    ).toBeUndefined();
  });

  it("refuses an unknown slot, an option not offered, and a repeated choice", () => {
    expect(codeOf(() => validateBundleChoices(slots, [{ slotId: "dessert", menuItemId: "pie" }]))).toBe("BUNDLE_CHOICE_INVALID");
    expect(codeOf(() => validateBundleChoices(slots, [{ slotId: "side", menuItemId: "salad" }]))).toBe("BUNDLE_OPTION_UNAVAILABLE");
    expect(
      codeOf(() =>
        validateBundleChoices(slots, [
          { slotId: "main", menuItemId: "burger" },
          { slotId: "side", menuItemId: "fries" },
          { slotId: "side", menuItemId: "fries" },
        ]),
      ),
    ).toBe("BUNDLE_CHOICE_REPEATED");
  });

  it("is fillable only while each required slot keeps enough options", () => {
    expect(slotsFillable(slots)).toBe(true);
    expect(slotsFillable([{ ...slots[0]!, options: [] }])).toBe(false);
    expect(slotsFillable([{ ...slots[2]!, options: [] }])).toBe(true);
    expect(slotsFillable([])).toBe(false);
  });

  it("checks a bundle's set-up", () => {
    const slot = { name: "Main", minimumChoices: 1, maximumChoices: 1, defaultCourse: 2, options: [{}] };

    expect(codeOf(() => assertBundleShape([slot]))).toBeUndefined();
    expect(codeOf(() => assertBundleShape([]))).toBe("BUNDLE_SLOTS_INVALID");
    expect(codeOf(() => assertBundleShape([{ ...slot, options: [] }]))).toBe("BUNDLE_SLOTS_INVALID");
    expect(codeOf(() => assertBundleShape([{ ...slot, minimumChoices: 2 }]))).toBe("BUNDLE_SLOTS_INVALID");
    expect(codeOf(() => assertBundleShape([{ ...slot, defaultCourse: 6 }]))).toBe("BUNDLE_SLOTS_INVALID");
  });
});
