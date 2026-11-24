import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import { assertRange, checkStatus, correctiveActionFor, describeRange, isInRange, readingValue } from "./temperature-rules";

const codeOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as AppError).code;
  }

  return undefined;
};

describe("temperature rules (Phase 36 policy 6)", () => {
  it("checks a reading against a minimum, a maximum or both, inclusively", () => {
    expect(isInRange("41.0", "33.0", "41.0")).toBe(true);
    expect(isInRange("41.1", "33.0", "41.0")).toBe(false);
    expect(isInRange("32.9", "33.0", "41.0")).toBe(false);
    expect(isInRange("135", "135.0", null)).toBe(true);
    expect(isInRange("-20", null, "-18.0")).toBe(true);
    expect(isInRange("99", null, null)).toBe(true);
  });

  it("accepts plausible readings to one decimal place", () => {
    expect(readingValue(" 38.5 ")).toBe("38.5");
    expect(readingValue("-18")).toBe("-18.0");
    expect(codeOf(() => readingValue("38.55"))).toBe("INVALID_TEMPERATURE");
    expect(codeOf(() => readingValue("601"))).toBe("INVALID_TEMPERATURE");
    expect(codeOf(() => readingValue("warm"))).toBe("INVALID_TEMPERATURE");
  });

  it("needs a corrective action only out of range", () => {
    expect(correctiveActionFor(true, "  ")).toBeNull();
    expect(correctiveActionFor(true, "Logged early")).toBe("Logged early");
    expect(codeOf(() => correctiveActionFor(false, ""))).toBe("CORRECTIVE_ACTION_REQUIRED");
    expect(correctiveActionFor(false, " Discarded ")).toBe("Discarded");
    expect(codeOf(() => correctiveActionFor(false, "x".repeat(501)))).toBe("CORRECTIVE_ACTION_TOO_LONG");
  });

  it("refuses a minimum above the maximum", () => {
    expect(codeOf(() => assertRange("45.0", "41.0"))).toBe("INVALID_RANGE");
    expect(codeOf(() => assertRange("41.0", "41.0"))).toBeUndefined();
    expect(codeOf(() => assertRange(null, "41.0"))).toBeUndefined();
  });

  it("works out when the next check is due", () => {
    const dayStart = new Date("2026-11-23T09:00:00Z");
    const last = new Date("2026-11-23T12:00:00Z");

    expect(checkStatus(null, last, dayStart, last)).toEqual({ state: "NO_SCHEDULE" });
    expect(checkStatus(60, last, dayStart, new Date("2026-11-23T12:59:00Z"))).toEqual({ state: "OK", dueAt: new Date("2026-11-23T13:00:00Z") });
    expect(checkStatus(60, last, dayStart, new Date("2026-11-23T13:00:00Z")).state).toBe("OVERDUE");
    // Nothing yet today (or only yesterday): due one interval after the day starts.
    expect(checkStatus(240, null, dayStart, new Date("2026-11-23T10:00:00Z"))).toEqual({ state: "OK", dueAt: new Date("2026-11-23T13:00:00Z") });
    expect(checkStatus(240, new Date("2026-11-22T23:00:00Z"), dayStart, new Date("2026-11-23T14:00:00Z")).state).toBe("OVERDUE");
  });

  it("describes a range", () => {
    expect(describeRange("33.0", "41.0", "F")).toBe("33.0–41.0 °F");
    expect(describeRange("135.0", null, "F")).toBe("at least 135.0 °F");
    expect(describeRange(null, "-18.0", "C")).toBe("at most -18.0 °C");
    expect(describeRange(null, null, "F")).toBe("no range");
  });
});
