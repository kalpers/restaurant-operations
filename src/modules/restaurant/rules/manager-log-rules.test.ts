import { describe, expect, it } from "vitest";

import { BusinessRuleError } from "@/shared/errors/app-error";

import {
  assertSearchRange,
  containsPattern,
  daysInRange,
  entryBusinessDate,
  formatLogNumber,
  redactionReason,
} from "./manager-log-rules";
import { assertNoteDate, assertNoteEditable, notesForReader } from "./pre-shift-rules";

describe("entryBusinessDate (policy 4)", () => {
  it("uses the current business date by default", () => {
    expect(entryBusinessDate("CURRENT", "2026-11-19")).toBe("2026-11-19");
  });

  it("allows the previous business date, across a month and year boundary", () => {
    expect(entryBusinessDate("PREVIOUS", "2026-12-01")).toBe("2026-11-30");
    expect(entryBusinessDate("PREVIOUS", "2027-01-01")).toBe("2026-12-31");
  });

  it("isn't shifted by a daylight-saving change", () => {
    expect(entryBusinessDate("PREVIOUS", "2026-11-02")).toBe("2026-11-01");
    expect(entryBusinessDate("PREVIOUS", "2026-03-09")).toBe("2026-03-08");
  });
});

describe("formatLogNumber", () => {
  it("pads to six digits", () => {
    expect(formatLogNumber(1)).toBe("LOG-000001");
    expect(formatLogNumber(412)).toBe("LOG-000412");
    expect(formatLogNumber(1234567)).toBe("LOG-1234567");
  });
});

describe("search range", () => {
  it("counts days inclusively", () => {
    expect(daysInRange("2026-11-01", "2026-11-01")).toBe(1);
    expect(daysInRange("2026-11-01", "2026-12-01")).toBe(31);
  });

  it("allows up to 31 days and refuses more or a reversed range", () => {
    expect(() => assertSearchRange("2026-11-01", "2026-12-01")).not.toThrow();
    expect(() => assertSearchRange("2026-11-01", "2026-12-02")).toThrow(BusinessRuleError);
    expect(() => assertSearchRange("2026-11-02", "2026-11-01")).toThrow(BusinessRuleError);
  });

  it("takes wildcard characters literally", () => {
    expect(containsPattern("50% off_now")).toBe("%50\\% off\\_now%");
    expect(containsPattern("a\\b")).toBe("%a\\\\b%");
  });
});

describe("redactionReason (policy 6)", () => {
  it("trims and requires 1 to 500 characters", () => {
    expect(redactionReason("  guest phone number  ")).toBe("guest phone number");
    expect(() => redactionReason("   ")).toThrow(BusinessRuleError);
    expect(() => redactionReason("x".repeat(501))).toThrow(BusinessRuleError);
    expect(redactionReason("x".repeat(500))).toHaveLength(500);
  });
});

describe("pre-shift note dates (policies 7–8)", () => {
  it("allows today through 14 days ahead", () => {
    expect(() => assertNoteDate("2026-11-19", "2026-11-19")).not.toThrow();
    expect(() => assertNoteDate("2026-12-03", "2026-11-19")).not.toThrow();
    expect(() => assertNoteDate("2026-12-04", "2026-11-19")).toThrow(BusinessRuleError);
    expect(() => assertNoteDate("2026-11-18", "2026-11-19")).toThrow(BusinessRuleError);
  });

  it("is editable until its date has passed", () => {
    expect(() => assertNoteEditable("2026-11-19", "2026-11-19")).not.toThrow();
    expect(() => assertNoteEditable("2026-11-18", "2026-11-19")).toThrow(BusinessRuleError);
  });
});

describe("notesForReader (policy 9)", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 19, 15, minute));
  const note = (id: string, overrides: Partial<Parameters<typeof notesForReader>[0][number]> = {}) => ({
    id,
    active: true,
    businessDate: "2026-11-19",
    pinned: false,
    createdAt: at(0),
    positionIds: [] as string[],
    ...overrides,
  });

  const notes = [
    note("everyone", { createdAt: at(1) }),
    note("servers", { positionIds: ["SERVER"], createdAt: at(2) }),
    note("cooks", { positionIds: ["COOK"], createdAt: at(3) }),
    note("pinned", { pinned: true, createdAt: at(4) }),
    note("withdrawn", { active: false }),
    note("tomorrow", { businessDate: "2026-11-20" }),
    note("both", { positionIds: ["COOK", "SERVER"], createdAt: at(5) }),
  ];

  it("shows everyone notes and the reader's positions, pinned first then oldest first", () => {
    const ids = notesForReader(notes, "2026-11-19", new Set(["SERVER"])).map((entry) => entry.id);

    expect(ids).toEqual(["pinned", "everyone", "servers", "both"]);
  });

  it("shows only everyone notes to a reader with no position", () => {
    const ids = notesForReader(notes, "2026-11-19", new Set()).map((entry) => entry.id);

    expect(ids).toEqual(["pinned", "everyone"]);
  });
});
