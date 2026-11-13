import { describe, expect, it } from "vitest";

import { localToInstant } from "@/shared/time/zoned-time";

import {
  forecastDate,
  hoursTouched,
  selectHistoryDates,
  suggestShiftCount,
  weightedAverage,
  type DateForecast,
  type HistoryCounts,
  type StaffingRatio,
} from "./demand-forecast";

const TZ = "America/Detroit";
const SETTINGS = { timeZone: TZ, businessDayCutoff: "04:00" };
// 2027-03-05 is a Friday.
const TARGET = "2027-03-05";
const TODAY = "2027-03-01";

const fridaysBefore = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const date = new Date(`${TARGET}T00:00:00Z`);

    date.setUTCDate(date.getUTCDate() - 7 * (index + 1));

    return date.toISOString().slice(0, 10);
  });

function counts(diningCovers: number, allChecks = 0): HistoryCounts {
  return { DINING_COVERS: diningCovers, BAR_CHECKS: 0, TAKEOUT_CHECKS: 0, ALL_CHECKS: allChecks };
}

describe("selectHistoryDates", () => {
  const fridays = fridaysBefore(12);

  it("takes the same weekday, newest first, up to the look-back", () => {
    expect(
      selectHistoryDates({
        targetDate: TARGET,
        today: TODAY,
        openDates: new Set(fridays),
        excludedDates: new Set(),
        lookbackWeeks: 6,
      }),
    ).toEqual(fridays.slice(0, 6));
  });

  it("skips closed and excluded dates and goes further back, up to 12 weeks", () => {
    const open = new Set(fridays.filter((date) => date !== fridays[1]));

    expect(
      selectHistoryDates({
        targetDate: TARGET,
        today: TODAY,
        openDates: open,
        excludedDates: new Set([fridays[0]!]),
        lookbackWeeks: 6,
      }),
    ).toEqual([fridays[2], fridays[3], fridays[4], fridays[5], fridays[6], fridays[7]]);
  });

  it("stops at 12 weeks and never uses today or later", () => {
    expect(
      selectHistoryDates({
        targetDate: TARGET,
        today: fridays[1]!,
        openDates: new Set([...fridays, fridays[0]!]),
        excludedDates: new Set(),
        lookbackWeeks: 12,
      }),
    ).toEqual(fridays.slice(2));
  });

  it("ignores other weekdays", () => {
    expect(
      selectHistoryDates({
        targetDate: TARGET,
        today: TODAY,
        openDates: new Set(["2027-02-25", "2027-02-27"]),
        excludedDates: new Set(),
        lookbackWeeks: 6,
      }),
    ).toEqual([]);
  });
});

describe("weightedAverage", () => {
  it("weights the newest highest", () => {
    // (3*30 + 2*20 + 1*10) / 6 = 23.333...
    expect(weightedAverage([30, 20, 10])).toBe("23.33");
  });

  it("rounds half up to two places with no floating error", () => {
    // weights 7..1 over 1,2,3,1,2,3,1: (7+12+15+4+6+6+1)/28 = 51/28 = 1.82142...
    expect(weightedAverage([1, 2, 3, 1, 2, 3, 1])).toBe("1.82");
    // (2*1 + 1*0) / 3 = 0.6666...
    expect(weightedAverage([1, 0])).toBe("0.67");
    expect(weightedAverage([5])).toBe("5.00");
  });
});

describe("forecastDate", () => {
  const dates = fridaysBefore(3);
  const history = new Map(
    dates.map((date, index) => [date, new Map([[19, counts(30 - index * 10, 12)]])]),
  );

  it("averages each hour and measure and fills empty hours with zero", () => {
    const forecast = forecastDate({
      targetDate: TARGET,
      sampleDates: dates,
      settings: { lookbackWeeks: 6, minimumSamples: 3 },
      history,
      booked: new Map(),
    });

    expect(forecast.status).toBe("OK");
    expect(forecast.hours.find((hour) => hour.hour === 19 && hour.measure === "DINING_COVERS")).toEqual({
      hour: 19,
      measure: "DINING_COVERS",
      historyValue: "23.33",
      bookedValue: 0,
      forecastValue: "23.33",
    });
    expect(forecast.hours.find((hour) => hour.hour === 19 && hour.measure === "ALL_CHECKS")?.forecastValue).toBe("12.00");
    expect(forecast.hours.find((hour) => hour.hour === 12 && hour.measure === "DINING_COVERS")?.forecastValue).toBe("0.00");
    expect(forecast.hours).toHaveLength(24 * 4);
  });

  it("raises dining covers, and only dining covers, to the booked covers", () => {
    const forecast = forecastDate({
      targetDate: TARGET,
      sampleDates: dates,
      settings: { lookbackWeeks: 6, minimumSamples: 3 },
      history,
      booked: new Map([[19, 40]]),
    });
    const hour = (measure: string) =>
      forecast.hours.find((entry) => entry.hour === 19 && entry.measure === measure);

    expect(hour("DINING_COVERS")).toMatchObject({ historyValue: "23.33", bookedValue: 40, forecastValue: "40.00" });
    expect(hour("ALL_CHECKS")).toMatchObject({ bookedValue: 0, forecastValue: "12.00" });
  });

  it("has no values with too little history, or bookings only when there are bookings", () => {
    const thin = forecastDate({
      targetDate: TARGET,
      sampleDates: dates.slice(0, 2),
      settings: { lookbackWeeks: 6, minimumSamples: 3 },
      history,
      booked: new Map(),
    });

    expect(thin.status).toBe("NOT_ENOUGH_HISTORY");
    expect(thin.hours.every((hour) => hour.forecastValue === null)).toBe(true);

    const booked = forecastDate({
      targetDate: TARGET,
      sampleDates: [],
      settings: { lookbackWeeks: 6, minimumSamples: 3 },
      history,
      booked: new Map([[19, 8]]),
    });

    expect(booked.status).toBe("BOOKINGS_ONLY");
    expect(booked.hours.find((hour) => hour.hour === 19 && hour.measure === "DINING_COVERS")?.forecastValue).toBe("8.00");
    expect(booked.hours.find((hour) => hour.hour === 19 && hour.measure === "ALL_CHECKS")?.forecastValue).toBeNull();
  });
});

describe("hoursTouched", () => {
  const at = (date: string, time: string) => localToInstant(date, time, TZ)!;

  it("lists each local hour of a window, including a partial last hour", () => {
    expect(hoursTouched(at(TARGET, "17:30"), at(TARGET, "20:15"), SETTINGS)).toEqual([
      { businessDate: TARGET, hour: 17 },
      { businessDate: TARGET, hour: 18 },
      { businessDate: TARGET, hour: 19 },
      { businessDate: TARGET, hour: 20 },
    ]);
  });

  it("keeps hours before the cutoff on the earlier business date", () => {
    expect(hoursTouched(at(TARGET, "23:00"), at("2027-03-06", "02:00"), SETTINGS)).toEqual([
      { businessDate: TARGET, hour: 23 },
      { businessDate: TARGET, hour: 0 },
      { businessDate: TARGET, hour: 1 },
    ]);
  });

  it("puts hours after the cutoff on the next business date", () => {
    expect(hoursTouched(at("2027-03-06", "03:00"), at("2027-03-06", "05:00"), SETTINGS)).toEqual([
      { businessDate: TARGET, hour: 3 },
      { businessDate: "2027-03-06", hour: 4 },
    ]);
  });

  it("skips the missing hour on a spring-forward day", () => {
    // 2027-03-14: 02:00 jumps to 03:00 in Detroit.
    expect(
      hoursTouched(at("2027-03-14", "01:00"), at("2027-03-14", "04:00"), {
        timeZone: TZ,
        businessDayCutoff: "05:00",
      }).map((slot) => slot.hour),
    ).toEqual([1, 3]);
  });
});

describe("suggestShiftCount", () => {
  const forecast = (values: Record<number, string>, booked: Record<number, number> = {}): DateForecast => ({
    businessDate: TARGET,
    status: "OK",
    sampleDates: ["2027-02-26", "2027-02-19", "2027-02-12"],
    hours: Object.entries(values).map(([hour, value]) => ({
      hour: Number(hour),
      measure: "DINING_COVERS" as const,
      historyValue: value,
      bookedValue: booked[Number(hour)] ?? 0,
      forecastValue: value,
    })),
  });
  const servers: StaffingRatio = {
    measure: "DINING_COVERS",
    unitsPerEmployeeHour: "16.00",
    minimumEmployees: 1,
    maximumEmployees: 6,
  };
  const window = [17, 18, 19, 20].map((hour) => ({ businessDate: TARGET, hour }));

  it("uses the busiest hour, rounded up, and explains it", () => {
    const suggestion = suggestShiftCount({
      window,
      ratio: servers,
      forecasts: new Map([[TARGET, forecast({ 17: "10.00", 18: "30.50", 19: "48.00", 20: "20.00" }, { 19: 48 })]]),
      positionName: "Server",
    });

    expect(suggestion).toMatchObject({ suggestedCount: 3, rawCount: 3, reason: "FORECAST", peak: { hour: 19 } });
    expect(suggestion.explanation).toBe(
      "Busiest hour 19:00–19:59: 48 covers (history 48, booked 48) ÷ 16 per server = 3.",
    );

    expect(
      suggestShiftCount({
        window,
        ratio: servers,
        forecasts: new Map([[TARGET, forecast({ 19: "48.01" })]]),
        positionName: "Server",
      }).suggestedCount,
    ).toBe(4);
  });

  it("applies the minimum, at least one, and the maximum", () => {
    const quiet = suggestShiftCount({
      window,
      ratio: { ...servers, minimumEmployees: 2 },
      forecasts: new Map([[TARGET, forecast({ 19: "3.00" })]]),
      positionName: "Server",
    });

    expect(quiet).toMatchObject({ suggestedCount: 2, rawCount: 1, reason: "MINIMUM_APPLIED" });
    expect(quiet.explanation).toContain("raised to the minimum of 2");

    expect(
      suggestShiftCount({
        window,
        ratio: { ...servers, minimumEmployees: 0 },
        forecasts: new Map([[TARGET, forecast({ 19: "0.00" })]]),
        positionName: "Server",
      }),
    ).toMatchObject({ suggestedCount: 1, rawCount: 0, reason: "MINIMUM_APPLIED" });

    const busy = suggestShiftCount({
      window,
      ratio: { ...servers, maximumEmployees: 4 },
      forecasts: new Map([[TARGET, forecast({ 19: "200.00" })]]),
      positionName: "Server",
    });

    expect(busy).toMatchObject({ suggestedCount: 4, rawCount: 13, reason: "MAXIMUM_APPLIED" });
    expect(busy.explanation).toContain("held to the maximum of 4");
  });

  it("keeps the count with no ratio or no forecast", () => {
    expect(
      suggestShiftCount({ window, ratio: null, forecasts: new Map(), positionName: "Host" }),
    ).toMatchObject({ suggestedCount: null, reason: "NO_RATIO" });

    const thin: DateForecast = { ...forecast({}), status: "NOT_ENOUGH_HISTORY" };

    expect(
      suggestShiftCount({ window, ratio: servers, forecasts: new Map([[TARGET, thin]]), positionName: "Server" }),
    ).toMatchObject({ suggestedCount: null, reason: "NOT_ENOUGH_HISTORY" });
  });

  it("uses the next business date's forecast for hours after the cutoff", () => {
    const next = { ...forecast({ 5: "64.00" }), businessDate: "2027-03-06" };

    expect(
      suggestShiftCount({
        window: [
          { businessDate: TARGET, hour: 3 },
          { businessDate: "2027-03-06", hour: 5 },
        ],
        ratio: servers,
        forecasts: new Map([
          [TARGET, forecast({ 3: "16.00" })],
          ["2027-03-06", next],
        ]),
        positionName: "Server",
      }),
    ).toMatchObject({ suggestedCount: 4, peak: { businessDate: "2027-03-06", hour: 5 } });
  });
});
