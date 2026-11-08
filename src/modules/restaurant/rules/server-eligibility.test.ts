import { describe, expect, it } from "vitest";

import { serverPositionCodesFor } from "./server-area-policy";
import {
  evaluateServerAssignment,
  isServerQualified,
  type ServerFacts,
} from "./server-eligibility";

const HERE = "location-a";
const TODAY = "2030-06-10";

function factsHolding(...codes: string[]): ServerFacts {
  return {
    employmentStatus: "ACTIVE",
    locations: [{ locationId: HERE, effectiveFrom: "2024-01-01", effectiveTo: null }],
    positions: codes.map((positionCode) => ({
      positionCode,
      locationId: HERE,
      effectiveFrom: "2024-01-01",
      effectiveTo: null,
    })),
  };
}

const base = { locationId: HERE, localDate: TODAY };

describe("the approved position-to-area policy", () => {
  it("matches the approved table exactly", () => {
    expect(serverPositionCodesFor("DINING")).toEqual(["SERVER", "WAIT_STAFF"]);
    expect(serverPositionCodesFor("BAR")).toEqual(["BARTENDER", "SERVER", "WAIT_STAFF"]);
    expect(serverPositionCodesFor("TAKEOUT")).toEqual([]);
  });
});

describe("isServerQualified", () => {
  const dining = { ...base, areaTypes: ["DINING"] as const };

  it("accepts ACTIVE, at the location, holding SERVER", () => {
    expect(isServerQualified({ ...dining, facts: factsHolding("SERVER") })).toBe(true);
  });

  it("accepts WAIT_STAFF in both areas", () => {
    expect(
      isServerQualified({
        ...base,
        areaTypes: ["DINING", "BAR"],
        facts: factsHolding("WAIT_STAFF"),
      }),
    ).toBe(true);
  });

  it("accepts BARTENDER at the bar, and refuses them in the dining room", () => {
    const facts = factsHolding("BARTENDER");

    expect(isServerQualified({ ...base, areaTypes: ["BAR"], facts })).toBe(true);
    expect(isServerQualified({ ...dining, facts })).toBe(false);
  });

  it.each(["HOST", "COOK", "MANAGER", "GENERAL_MANAGER", "INVENTORY_MANAGER"])(
    "refuses %s everywhere",
    (code) => {
      const facts = factsHolding(code);

      expect(isServerQualified({ ...dining, facts })).toBe(false);
      expect(isServerQualified({ ...base, areaTypes: ["BAR"], facts })).toBe(false);
    },
  );

  it("refuses a person holding only a security role: no position, no qualification", () => {
    expect(isServerQualified({ ...dining, facts: factsHolding() })).toBe(false);
  });

  it.each(["TERMINATED", "ON_LEAVE", "SUSPENDED"])("refuses %s", (employmentStatus) => {
    expect(
      isServerQualified({
        ...dining,
        facts: { ...factsHolding("SERVER"), employmentStatus },
      }),
    ).toBe(false);
  });

  it("refuses someone not eligible at this location", () => {
    expect(
      isServerQualified({ ...dining, locationId: "location-b", facts: factsHolding("SERVER") }),
    ).toBe(false);
  });

  it("refuses a position held only at another location", () => {
    const facts = factsHolding("SERVER");

    facts.positions[0]!.locationId = "location-b";
    expect(isServerQualified({ ...dining, facts })).toBe(false);
  });

  it("refuses an expired position and a future one, and accepts its last day", () => {
    const facts = factsHolding("SERVER");

    facts.positions[0]!.effectiveTo = "2030-06-09";
    expect(isServerQualified({ ...dining, facts })).toBe(false);

    facts.positions[0]!.effectiveTo = TODAY;
    expect(isServerQualified({ ...dining, facts })).toBe(true);

    facts.positions[0]!.effectiveTo = null;
    facts.positions[0]!.effectiveFrom = "2030-06-11";
    expect(isServerQualified({ ...dining, facts })).toBe(false);
  });

  it("refuses an ended location", () => {
    const facts = factsHolding("SERVER");

    facts.locations[0]!.effectiveTo = "2030-06-09";
    expect(isServerQualified({ ...dining, facts })).toBe(false);
  });

  it("refuses Takeout and an empty area list", () => {
    const facts = factsHolding("SERVER");

    expect(isServerQualified({ ...base, areaTypes: ["TAKEOUT"], facts })).toBe(false);
    expect(isServerQualified({ ...base, areaTypes: [], facts })).toBe(false);
  });
});

describe("evaluateServerAssignment", () => {
  const dining = {
    ...base,
    areaTypes: ["DINING"] as const,
    activeShiftPositionCodes: [] as string[],
    canOverrideSchedule: false,
  };

  it("allows a qualified server on a matching published shift", () => {
    expect(
      evaluateServerAssignment({
        ...dining,
        facts: factsHolding("SERVER"),
        activeShiftPositionCodes: ["SERVER"],
      }).outcome,
    ).toBe("ON_SHIFT");
  });

  it("denies a qualified server with no shift, or no published schedule at all", () => {
    expect(
      evaluateServerAssignment({ ...dining, facts: factsHolding("SERVER") }).outcome,
    ).toBe("OVERRIDE_DENIED");
  });

  it("requires a reason for the override", () => {
    expect(
      evaluateServerAssignment({
        ...dining,
        facts: factsHolding("SERVER"),
        canOverrideSchedule: true,
        overrideReason: "  ",
      }).outcome,
    ).toBe("REASON_REQUIRED");
  });

  it("allows the override with a reason", () => {
    expect(
      evaluateServerAssignment({
        ...dining,
        facts: factsHolding("SERVER"),
        canOverrideSchedule: true,
        overrideReason: " Covering a sick call ",
      }),
    ).toEqual({ outcome: "OVERRIDDEN", reason: "Covering a sick call" });
  });

  it("never lets the override reach HR qualification", () => {
    expect(
      evaluateServerAssignment({
        ...dining,
        facts: factsHolding("COOK"),
        canOverrideSchedule: true,
        overrideReason: "Short staffed",
      }).outcome,
    ).toBe("NOT_QUALIFIED");
    expect(
      evaluateServerAssignment({
        ...dining,
        facts: { ...factsHolding("SERVER"), employmentStatus: "TERMINATED" },
        canOverrideSchedule: true,
        overrideReason: "Short staffed",
        activeShiftPositionCodes: ["SERVER"],
      }).outcome,
    ).toBe("NOT_QUALIFIED");
  });

  it("doesn't count a shift in a position that doesn't suit the area", () => {
    // Holds both, but is working the bar: the dining room isn't covered by that shift.
    expect(
      evaluateServerAssignment({
        ...dining,
        facts: factsHolding("SERVER", "BARTENDER"),
        activeShiftPositionCodes: ["BARTENDER"],
      }).outcome,
    ).toBe("OVERRIDE_DENIED");
  });

  it("doesn't count a shift in a position the person no longer holds", () => {
    expect(
      evaluateServerAssignment({
        ...dining,
        facts: factsHolding("WAIT_STAFF"),
        activeShiftPositionCodes: ["SERVER"],
      }).outcome,
    ).toBe("OVERRIDE_DENIED");
  });
});
