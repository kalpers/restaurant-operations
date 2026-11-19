import { describe, expect, it } from "vitest";

import { weekStartOf } from "@/modules/scheduling/rules/schedule-rules";

import { buildPayrollRows, wholeWeeks, type PayrollInput } from "./payroll-hours";

// Weeks start on Monday (1). 2026-11-16 is a Monday.
const weekOf = (date: string) => weekStartOf(date, 1);
const H = 3600;

function input(overrides: Partial<PayrollInput> = {}): PayrollInput {
  return {
    entries: [],
    weekStartOf: weekOf,
    employees: new Map([
      ["e1", { number: "E-001", name: "Ana Diaz" }],
      ["e2", { number: "E-002", name: "Ben Ito" }],
    ]),
    positions: new Map([
      ["server", "SERVER"],
      ["bar", "BARTENDER"],
    ]),
    tips: null,
    ...overrides,
  };
}

describe("wholeWeeks", () => {
  it("accepts 1 to 6 whole weeks from a week start only", () => {
    expect(wholeWeeks("2026-11-16", "2026-11-22", weekOf)).toBe(1);
    expect(wholeWeeks("2026-11-16", "2026-12-27", weekOf)).toBe(6);
    expect(wholeWeeks("2026-11-17", "2026-11-23", weekOf)).toBeNull();
    expect(wholeWeeks("2026-11-16", "2026-11-21", weekOf)).toBeNull();
    expect(wholeWeeks("2026-11-16", "2027-01-03", weekOf)).toBeNull();
  });
});

describe("buildPayrollRows", () => {
  it("adds hours per employee, position and week, to two places, with no pay figures", () => {
    const rows = buildPayrollRows(
      input({
        entries: [
          { employeeId: "e1", positionId: "server", businessDate: "2026-11-16", regularSeconds: 8 * H, overtimeSeconds: 0 },
          { employeeId: "e1", positionId: "server", businessDate: "2026-11-21", regularSeconds: 4 * H, overtimeSeconds: 1800 },
          { employeeId: "e1", positionId: "bar", businessDate: "2026-11-18", regularSeconds: 1000, overtimeSeconds: 0 },
          { employeeId: "e2", positionId: "server", businessDate: "2026-11-23", regularSeconds: 6 * H, overtimeSeconds: 0 },
        ],
      }),
    );

    expect(rows).toEqual([
      { weekStart: "2026-11-16", employeeNumber: "E-001", employee: "Ana Diaz", positionCode: "BARTENDER", regularHours: "0.28", overtimeHours: "0.00", totalHours: "0.28" },
      { weekStart: "2026-11-16", employeeNumber: "E-001", employee: "Ana Diaz", positionCode: "SERVER", regularHours: "12.00", overtimeHours: "0.50", totalHours: "12.50" },
      { weekStart: "2026-11-23", employeeNumber: "E-002", employee: "Ben Ito", positionCode: "SERVER", regularHours: "6.00", overtimeHours: "0.00", totalHours: "6.00" },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/rate|wage|pay/i);
  });

  it("adds finalized tip shares, puts declared tips on the row with most hours, and marks unfinalized weeks", () => {
    const rows = buildPayrollRows(
      input({
        entries: [
          { employeeId: "e1", positionId: "server", businessDate: "2026-11-16", regularSeconds: 6 * H, overtimeSeconds: 0 },
          { employeeId: "e1", positionId: "bar", businessDate: "2026-11-17", regularSeconds: 2 * H, overtimeSeconds: 0 },
        ],
        tips: {
          shares: [
            { employeeId: "e1", positionId: "server", businessDate: "2026-11-16", share: "40.25" },
            { employeeId: "e1", positionId: "bar", businessDate: "2026-11-17", share: "10.00" },
          ],
          declarations: [
            { employeeId: "e1", businessDate: "2026-11-16", amount: "12.00" },
            { employeeId: "e1", businessDate: "2026-11-17", amount: "3.50" },
          ],
          finalizedDates: new Set(["2026-11-16"]),
        },
      }),
    );

    expect(rows.find((row) => row.positionCode === "SERVER")).toMatchObject({
      tipShare: "40.25",
      declaredTips: "15.50",
      tipsFinalized: "NO",
    });
    expect(rows.find((row) => row.positionCode === "BARTENDER")).toMatchObject({
      tipShare: "10.00",
      declaredTips: "0.00",
      tipsFinalized: "NO",
    });
  });

  it("leaves out tip columns when tips aren't visible", () => {
    const [row] = buildPayrollRows(
      input({ entries: [{ employeeId: "e1", positionId: "server", businessDate: "2026-11-16", regularSeconds: H, overtimeSeconds: 0 }] }),
    );

    expect(Object.keys(row!)).not.toContain("tipShare");
  });
});
