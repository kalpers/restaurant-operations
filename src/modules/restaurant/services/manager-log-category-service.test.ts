import { describe, expect, it } from "vitest";

import { categoryCodeFrom } from "./manager-log-category-service";

// Phase 33 (policy 18): a new category's code, worked out from its name when none is given.
describe("category codes", () => {
  it("upper-cases the name and joins words with underscores", () => {
    expect(categoryCodeFrom("Health inspection")).toBe("HEALTH_INSPECTION");
    expect(categoryCodeFrom("  Café / bar  ")).toBe("CAFE_BAR");
  });

  it("starts with a letter and stays within 30 characters", () => {
    expect(categoryCodeFrom("86 board")).toBe("C_86_BOARD");
    expect(categoryCodeFrom("A very long category name that keeps going").length).toBeLessThanOrEqual(30);
    expect(categoryCodeFrom("A very long category name that keeps going")).toMatch(/^[A-Z][A-Z0-9_]{1,29}$/);
  });
});
