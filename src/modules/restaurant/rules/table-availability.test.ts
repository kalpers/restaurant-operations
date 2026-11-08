import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import {
  assertTableSeatable,
  deriveTableAvailability,
  type AvailabilityInput,
} from "./table-availability";

const clean: AvailabilityInput = {
  tableActive: true,
  areaActive: true,
  condition: "CLEAN",
  occupied: false,
};

describe("deriveTableAvailability", () => {
  it.each([
    ["clean and unoccupied", clean, "AVAILABLE"],
    ["dirty and unoccupied", { ...clean, condition: "DIRTY" }, "DIRTY"],
    ["out of service", { ...clean, condition: "OUT_OF_SERVICE" }, "OUT_OF_SERVICE"],
    ["inactive configuration", { ...clean, tableActive: false }, "INACTIVE"],
    ["an inactive area", { ...clean, areaActive: false }, "INACTIVE"],
    ["clean with an active session", { ...clean, occupied: true }, "OCCUPIED"],
    ["inactive beats occupied", { ...clean, tableActive: false, occupied: true }, "INACTIVE"],
  ] as const)("%s", (_label, input, expected) => {
    expect(deriveTableAvailability(input)).toBe(expected);
  });

  it("keeps condition and occupancy independent: clean and occupied is valid", () => {
    const input: AvailabilityInput = { ...clean, occupied: true };

    expect(input.condition).toBe("CLEAN");
    expect(deriveTableAvailability(input)).toBe("OCCUPIED");
  });
});

describe("assertTableSeatable", () => {
  it("allows only an available table", () => {
    expect(() => assertTableSeatable("AVAILABLE", "T1")).not.toThrow();
  });

  it.each([
    ["OCCUPIED", "TABLE_ALREADY_OCCUPIED", 409],
    ["DIRTY", "TABLE_DIRTY", 422],
    ["OUT_OF_SERVICE", "TABLE_OUT_OF_SERVICE", 422],
    ["INACTIVE", "TABLE_INACTIVE", 422],
  ] as const)("refuses %s with %s", (availability, code, status) => {
    try {
      assertTableSeatable(availability, "T1");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
      expect((error as AppError).httpStatus).toBe(status);
    }
  });
});
