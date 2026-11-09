import { describe, expect, it } from "vitest";

import type { ReportResult } from "../types";
import { reportFiltersSchema } from "../validators/report-filters";

import { csvCell, csvFileName, csvLine, reportToCsv } from "./csv";
import { addLabor, emptyLaborTotals, percentOf, secondsToHours, shiftLabor } from "./labor-cost";
import { assertValidRange, daysInRange, MAX_REPORT_DAYS } from "./period";

const report: ReportResult = {
  area: "sales",
  title: "Sales",
  location: { id: "x", code: "MAIN", name: "Main, Downtown" },
  filters: { locationId: "x", from: "2030-01-01", to: "2030-01-07" },
  notes: ["Net sales count CLOSED orders."],
  sections: [],
};

describe("CSV", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell('Say "hi", then\nleave')).toBe('"Say ""hi"", then\nleave"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
  });

  it("neutralizes text a spreadsheet would run as a formula", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+1+2")).toBe("'+1+2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-cmd")).toBe("'-cmd");
  });

  it("leaves negative decimal strings numeric", () => {
    expect(csvCell("-1.50")).toBe("-1.50");
    expect(csvLine(["-3", "2.0000", null])).toBe("-3,2.0000,");
  });

  it("writes a header, then one plain table for one section", () => {
    const csv = reportToCsv(report, [
      {
        key: "daily",
        title: "Daily",
        columns: [
          { key: "date", label: "Business date", kind: "date" },
          { key: "net", label: "Net sales", kind: "money" },
        ],
        rows: [{ date: "2030-01-01", net: "18.50" }],
      },
    ]);

    expect(csv).toBe(
      [
        "Report,Sales",
        'Location,"Main, Downtown"',
        "Business dates,2030-01-01 to 2030-01-07",
        "Note,Net sales count CLOSED orders.",
        "",
        "Business date,Net sales",
        "2030-01-01,18.50",
        "",
      ].join("\r\n"),
    );
  });

  it("titles and separates several sections", () => {
    const section = (key: string) => ({
      key,
      title: key.toUpperCase(),
      columns: [{ key: "a", label: "A", kind: "count" as const }],
      rows: [{ a: 1 }],
    });
    const lines = reportToCsv(report, [section("one"), section("two")]).split("\r\n");

    expect(lines.slice(5)).toEqual(["ONE", "A", "1", "", "TWO", "A", "1", ""]);
  });

  it("builds a safe file name", () => {
    expect(csvFileName(report)).toBe("sales_MAIN_2030-01-01_2030-01-07.csv");
    expect(csvFileName({ ...report, location: { ...report.location, code: "../a b" } }, "daily")).toBe(
      "sales_daily_ab_2030-01-01_2030-01-07.csv",
    );
  });
});

describe("labor cost", () => {
  it("costs hourly work exactly, half-up to cents", () => {
    // 7h 20m at 15.25/h = 111.8333… → 111.83
    expect(shiftLabor(26_400, { compensationType: "HOURLY", hourlyRate: "15.25" })).toEqual({
      hours: "7.3333",
      basis: "HOURLY",
      cost: "111.83",
    });
    // 8h at 12.50 = 100.00
    expect(shiftLabor(28_800, { compensationType: "HOURLY", hourlyRate: "12.50" }).cost).toBe("100.00");
  });

  it("shows salaried and unrated work as hours only", () => {
    expect(shiftLabor(3600, { compensationType: "SALARY" })).toEqual({
      hours: "1.0000",
      basis: "SALARIED",
      cost: null,
    });
    expect(shiftLabor(5400, null)).toEqual({ hours: "1.5000", basis: "NO_RATE", cost: null });
  });

  it("totals each basis separately", () => {
    let totals = emptyLaborTotals();

    totals = addLabor(totals, shiftLabor(3600, { compensationType: "HOURLY", hourlyRate: "10.00" }));
    totals = addLabor(totals, shiftLabor(3600, { compensationType: "HOURLY", hourlyRate: "12.00" }));
    totals = addLabor(totals, shiftLabor(7200, { compensationType: "SALARY" }));
    totals = addLabor(totals, shiftLabor(1800, null));

    expect(totals).toEqual({
      shifts: 4,
      hours: "4.5000",
      cost: "22.00",
      salariedHours: "2.0000",
      noRateHours: "0.5000",
    });
  });

  it("rounds hours half-up to 4 places", () => {
    expect(secondsToHours(1)).toBe("0.0003");
    expect(secondsToHours(0)).toBe("0.0000");
  });

  it("computes a percentage, or null against zero", () => {
    expect(percentOf("25.00", "200.00")).toBe("12.50");
    expect(percentOf("1.00", "3.00")).toBe("33.33");
    expect(percentOf("5.00", "0.00")).toBeNull();
    expect(percentOf("5.00", "0")).toBeNull();
  });
});

describe("report period", () => {
  it("counts inclusive days", () => {
    expect(daysInRange("2030-01-01", "2030-01-01")).toBe(1);
    expect(daysInRange("2030-02-27", "2030-03-01")).toBe(3);
  });

  it("refuses a reversed or over-long range", () => {
    expect(() => assertValidRange("2030-01-02", "2030-01-01")).toThrow(/on or before/);
    // 2030-01-01 through 2030-04-02 is exactly 92 days.
    expect(() => assertValidRange("2030-01-01", "2030-04-02")).not.toThrow();
    expect(() => assertValidRange("2030-01-01", "2030-04-03")).toThrow(`${MAX_REPORT_DAYS} days`);
  });
});

describe("report filters", () => {
  const base = { locationId: "4b9d0d38-8a4f-4b8e-9df6-0f3e8f1b2a11", from: "2030-01-01", to: "2030-01-02" };

  it("accepts the documented filters", () => {
    expect(reportFiltersSchema.parse({ ...base, orderType: "TAKEOUT", tenderType: "CASH" })).toMatchObject({
      orderType: "TAKEOUT",
      tenderType: "CASH",
    });
  });

  it("refuses malformed dates, IDs and enum values", () => {
    expect(reportFiltersSchema.safeParse({ ...base, from: "2030-1-1" }).success).toBe(false);
    expect(reportFiltersSchema.safeParse({ ...base, locationId: "x" }).success).toBe(false);
    expect(reportFiltersSchema.safeParse({ ...base, tenderType: "CARD_NUMBER" }).success).toBe(false);
  });
});
