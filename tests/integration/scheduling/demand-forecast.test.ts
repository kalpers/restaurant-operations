import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  auditEvents,
  demandForecastDates,
  demandForecastHours,
  demandForecasts,
  scheduleGenerationRuns,
  shifts,
} from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { getDemandHistory } from "@/modules/orders/queries/demand-history";
import { getBookedCovers } from "@/modules/reservations/queries/booked-demand";
import { createReservation } from "@/modules/reservations/services/reservation-service";
import { runReport } from "@/modules/reporting/services/report-service";
import {
  addRequirement,
  applyTemplate,
  createTemplate,
} from "@/modules/scheduling/services/config-service";
import {
  addExcludedDate,
  applyForecastSuggestions,
  createRatio,
  getForecastSettings,
  getPeriodForecast,
  removeExcludedDate,
  updateRatio,
} from "@/modules/scheduling/services/forecast-service";
import { runGeneration } from "@/modules/scheduling/services/generation-service";
import { createPeriod, createShift, getPeriodDetail } from "@/modules/scheduling/services/schedule-service";
import { AppError, AuthorizationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { closedCheckAt } from "../../fixtures/forecast-history";
import { clearOrderData } from "../../fixtures/order-fixtures";
import { at, startFakeClock, stopFakeClock } from "../../fixtures/restaurant-day";
import { setRules } from "../../fixtures/scheduling-fixtures";
import { createSettlementScenario, type SettlementScenario } from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();

// Fridays in 2030: 02-08, 02-15, 02-22, 03-01, then the target 03-08. "Today" is Monday
// 2030-03-04 at 10:00 in Detroit, so the history is all in the past.
const TODAY = "2030-03-04";
const FRIDAY = "2030-03-08";
const PERIOD = { startDate: "2030-03-04", endDate: "2030-03-10" };

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    const cause = (error as { cause?: { constraint_name?: string; constraint?: string } }).cause;

    return `DB:${cause?.constraint_name ?? cause?.constraint ?? (error as Error).message}`;
  }

  return undefined;
}

function hourValues(forecast: Awaited<ReturnType<typeof getPeriodForecast>>, date: string, hour: number) {
  return forecast.dates.find((row) => row.businessDate === date)!.hours.find((row) => row.hour === hour)!.values;
}

describe("demand forecast (Phase 24)", () => {
  let scenario: SettlementScenario;
  let owner: Actor;

  beforeAll(async () => {
    startFakeClock();
    scenario = await createSettlementScenario(database());
    owner = scenario.owner;

    // 03-01: tables of 4 and 6 and a takeout at 19:xx; 02-22: a table of 8; 02-15: 6; 02-08: 2.
    await closedCheckAt(database(), scenario, { date: "2030-03-01", time: "19:10", partySize: 4 });
    await closedCheckAt(database(), scenario, { date: "2030-03-01", time: "19:20", partySize: 6 });
    await closedCheckAt(database(), scenario, { date: "2030-03-01", time: "19:30" });
    await closedCheckAt(database(), scenario, { date: "2030-02-22", time: "19:15", partySize: 8 });
    await closedCheckAt(database(), scenario, { date: "2030-02-15", time: "19:05", partySize: 6 });
    await closedCheckAt(database(), scenario, { date: "2030-02-08", time: "19:40", partySize: 2 });

    at(TODAY, "10:00");
  }, 240_000);

  afterAll(async () => {
    stopFakeClock();
    await clearEmployeeData(database());
    await clearOrderData(database());
    await closeDatabase();
  });

  async function friServerTemplate() {
    const template = await createTemplate(database(), owner, { name: `Week ${Math.random()}`, description: null });

    await addRequirement(database(), owner, template.id, {
      dayOfWeek: 5,
      positionId: scenario.waitStaff,
      restaurantAreaId: null,
      startTime: "17:00",
      endTime: "22:00",
      requiredEmployeeCount: 1,
      priority: 0,
    });
    await addRequirement(database(), owner, template.id, {
      dayOfWeek: 5,
      positionId: scenario.hostPosition,
      restaurantAreaId: null,
      startTime: "16:00",
      endTime: "22:00",
      requiredEmployeeCount: 1,
      priority: 0,
    });

    return template;
  }

  async function newPeriod(name: string) {
    return createPeriod(database(), owner, { name, ...PERIOD });
  }

  async function friShifts(periodId: string) {
    return database()
      .select()
      .from(shifts)
      .where(and(eq(shifts.schedulePeriodId, periodId), eq(shifts.shiftDate, FRIDAY)));
  }

  describe("history", () => {
    it("equals the sales-by-hour report for a date", async () => {
      const history = await getDemandHistory(database(), {
        locationId: scenario.locationA,
        timeZone: "America/Detroit",
        fromDate: "2030-03-01",
        toDate: "2030-03-01",
      });
      const sales = await runReport(database(), owner, "sales", {
        locationId: scenario.locationA,
        from: "2030-03-01",
        to: "2030-03-01",
      });
      const byHour = sales.sections.find((section) => section.key === "salesByHour")!;
      const seven = byHour.rows.find((row) => row.hour === "19:00–19:59")!;

      expect(history.hours).toEqual([
        { businessDate: "2030-03-01", hour: 19, diningCovers: 10, barChecks: 0, takeoutChecks: 1, allChecks: 3 },
      ]);
      expect(seven).toMatchObject({ closedOrders: 3, covers: 10 });
      expect(history.openDates).toEqual(["2030-03-01"]);
    });

    it("lists booked covers only for PENDING and CONFIRMED reservations", async () => {
      expect(
        await getBookedCovers(database(), {
          locationId: scenario.locationA,
          timeZone: "America/Detroit",
          fromDate: FRIDAY,
          toDate: FRIDAY,
        }),
      ).toEqual([]);
    });
  });

  describe("preview", () => {
    it("averages the same weekday, newest highest, and stores nothing", async () => {
      const period = await newPeriod("Preview");
      const forecast = await getPeriodForecast(database(), owner, period.id);
      const friday = forecast.dates.find((row) => row.businessDate === FRIDAY)!;

      expect(forecast.today).toBe(TODAY);
      expect(friday).toMatchObject({
        status: "OK",
        sampleDates: ["2030-03-01", "2030-02-22", "2030-02-15", "2030-02-08"],
      });
      // (4*10 + 3*8 + 2*6 + 1*2) / 10, (4*3 + 3 + 2 + 1) / 10, 4*1 / 10.
      expect(hourValues(forecast, FRIDAY, 19)).toMatchObject({
        DINING_COVERS: { history: "7.80", booked: 0, forecast: "7.80" },
        ALL_CHECKS: { forecast: "1.80" },
        TAKEOUT_CHECKS: { forecast: "0.40" },
        BAR_CHECKS: { forecast: "0.00" },
      });
      // Hours are laid out from the 04:00 cutoff.
      expect(friday.hours[0]!.hour).toBe(4);
      // No Monday history at all.
      expect(forecast.dates.find((row) => row.businessDate === TODAY)!.status).toBe("NOT_ENOUGH_HISTORY");
      expect(await database().select().from(demandForecasts)).toEqual([]);
    });

    it("needs the minimum number of history dates", async () => {
      await setRules(database(), scenario.locationA, { forecastLookbackWeeks: 6, forecastMinimumSamples: 5 });

      const period = await newPeriod("Thin");
      const forecast = await getPeriodForecast(database(), owner, period.id);

      expect(forecast.dates.find((row) => row.businessDate === FRIDAY)!.status).toBe("NOT_ENOUGH_HISTORY");

      await setRules(database(), scenario.locationA, { forecastLookbackWeeks: 2, forecastMinimumSamples: 2 });

      const two = await getPeriodForecast(database(), owner, period.id);

      // (2*10 + 1*8) / 3.
      expect(hourValues(two, FRIDAY, 19).DINING_COVERS.forecast).toBe("9.33");

      await setRules(database(), scenario.locationA, { forecastLookbackWeeks: 6, forecastMinimumSamples: 3 });
    });

    it("leaves excluded dates out, and back in when restored", async () => {
      const period = await newPeriod("Excluded");
      const excluded = await addExcludedDate(database(), owner, { excludedDate: "2030-02-22", reason: "Private party" });

      expect(await codeOf(addExcludedDate(database(), owner, { excludedDate: "2030-02-22", reason: "Again" }))).toBe(
        "DATE_ALREADY_EXCLUDED",
      );

      const without = await getPeriodForecast(database(), owner, period.id);

      expect(without.dates.find((row) => row.businessDate === FRIDAY)!.sampleDates).toEqual([
        "2030-03-01",
        "2030-02-15",
        "2030-02-08",
      ]);
      // (3*10 + 2*6 + 1*2) / 6.
      expect(hourValues(without, FRIDAY, 19).DINING_COVERS.forecast).toBe("7.33");

      await removeExcludedDate(database(), owner, excluded.id);

      expect(hourValues(await getPeriodForecast(database(), owner, period.id), FRIDAY, 19).DINING_COVERS.forecast).toBe(
        "7.80",
      );
      expect(
        await database()
          .select({ action: auditEvents.action })
          .from(auditEvents)
          .where(eq(auditEvents.entityId, excluded.id)),
      ).toEqual(
        expect.arrayContaining([{ action: "scheduling.forecast-date-excluded" }, { action: "scheduling.forecast-date-restored" }]),
      );
    });
  });

  describe("ratios", () => {
    it("allows one active ratio per position, version checked and audited", async () => {
      const ratio = await createRatio(database(), owner, {
        positionId: scenario.waitStaff,
        measure: "DINING_COVERS",
        unitsPerEmployeeHour: "4",
        minimumEmployees: 1,
        maximumEmployees: 5,
      });

      expect(
        await codeOf(
          createRatio(database(), owner, {
            positionId: scenario.waitStaff,
            measure: "ALL_CHECKS",
            unitsPerEmployeeHour: "2",
            minimumEmployees: 1,
            maximumEmployees: 5,
          }),
        ),
      ).toBe("STAFFING_RATIO_EXISTS");
      expect(
        await codeOf(
          createRatio(database(), owner, {
            positionId: scenario.cook,
            measure: "ALL_CHECKS",
            unitsPerEmployeeHour: "0",
            minimumEmployees: 1,
            maximumEmployees: 5,
          }),
        ),
      ).toBe("VALIDATION_FAILED");
      await expect(
        updateRatio(database(), owner, ratio.id, {
          measure: "DINING_COVERS",
          unitsPerEmployeeHour: "4",
          minimumEmployees: 1,
          maximumEmployees: 5,
          active: true,
          expectedVersion: 99,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      const settings = await getForecastSettings(database(), owner);

      expect(settings.ratios).toMatchObject([
        { positionId: scenario.waitStaff, measure: "DINING_COVERS", unitsPerEmployeeHour: "4.00", active: true },
      ]);

      const [audit] = await database().select().from(auditEvents).where(eq(auditEvents.entityId, ratio.id));

      expect(audit).toMatchObject({ action: "scheduling.staffing-ratio-saved" });
      expect(audit!.after).toMatchObject({ unitsPerEmployeeHour: "4.00", measure: "DINING_COVERS" });
    });
  });

  describe("apply template with the forecast", () => {
    it("sizes new shifts in one transaction and stores the forecast used", async () => {
      const template = await friServerTemplate();
      const period = await newPeriod("Sized");
      const result = await applyTemplate(database(), owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: period.version,
        useForecast: true,
      });

      expect(result).toMatchObject({ created: 2, sized: 1 });
      expect(result.forecastId).not.toBeNull();

      const friday = await friShifts(period.id);
      const server = friday.find((shift) => shift.positionId === scenario.waitStaff)!;
      const host = friday.find((shift) => shift.positionId === scenario.hostPosition)!;

      // ceil(7.80 / 4) = 2; the host has no ratio and keeps the template's 1.
      expect(server).toMatchObject({
        requiredEmployeeCount: 2,
        demandForecastId: result.forecastId,
        forecastSuggestedCount: 2,
        templateEmployeeCount: 1,
      });
      expect(host).toMatchObject({ requiredEmployeeCount: 1, demandForecastId: null, templateEmployeeCount: null });

      const [stored] = await database().select().from(demandForecasts).where(eq(demandForecasts.id, result.forecastId!));

      expect(stored).toMatchObject({ schedulePeriodId: period.id, lookbackWeeks: 6, minimumSamples: 3 });
      expect((stored!.method as { ratios: { unitsPerEmployeeHour: string }[] }).ratios).toMatchObject([
        { unitsPerEmployeeHour: "4.00" },
      ]);

      const dates = await database()
        .select()
        .from(demandForecastDates)
        .where(eq(demandForecastDates.demandForecastId, result.forecastId!));

      // 03-04 through 03-11 (the day after the end, for shifts past midnight).
      expect(dates).toHaveLength(8);
      expect(dates.find((row) => row.businessDate === FRIDAY)).toMatchObject({
        status: "OK",
        sampleDates: ["2030-03-01", "2030-02-22", "2030-02-15", "2030-02-08"],
      });

      const hours = await database()
        .select()
        .from(demandForecastHours)
        .where(eq(demandForecastHours.demandForecastId, result.forecastId!));

      // Zero hours aren't stored: only 19:00 on Friday has demand.
      expect(hours.map((row) => `${row.businessDate} ${row.hour} ${row.measure} ${row.forecastValue}`).sort()).toEqual([
        `${FRIDAY} 19 ALL_CHECKS 1.80`,
        `${FRIDAY} 19 DINING_COVERS 7.80`,
        `${FRIDAY} 19 TAKEOUT_CHECKS 0.40`,
      ]);

      const [audit] = await database().select().from(auditEvents).where(eq(auditEvents.entityId, result.forecastId!));

      expect(audit).toMatchObject({ action: "scheduling.forecast-applied" });
      expect(audit!.after).toMatchObject({ mode: "APPLY_TEMPLATE", sizedShiftCount: 1 });

      // Applying again adds no shifts and stores no forecast.
      const again = await applyTemplate(database(), owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: result.periodVersion,
        useForecast: true,
      });

      expect(again).toMatchObject({ created: 0, sized: 0, forecastId: null });
    });

    it("behaves as before without useForecast", async () => {
      const template = await friServerTemplate();
      const period = await newPeriod("Plain");
      const result = await applyTemplate(database(), owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: period.version,
      });

      expect(result).toMatchObject({ created: 2, sized: 0, forecastId: null, forecastDates: [] });
      expect((await friShifts(period.id)).map((shift) => shift.requiredEmployeeCount)).toEqual([1, 1]);
    });

    it("records the forecast in the next generation run", async () => {
      const template = await friServerTemplate();
      const period = await newPeriod("Generated");
      const applied = await applyTemplate(database(), owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: period.version,
        useForecast: true,
      });

      await runGeneration(database(), owner, period.id, {
        mode: "GENERATE_DRAFT",
        expectedVersion: applied.periodVersion,
      });

      const [run] = await database()
        .select()
        .from(scheduleGenerationRuns)
        .where(eq(scheduleGenerationRuns.schedulePeriodId, period.id));

      expect(run!.rulesSnapshot).toMatchObject({ demandForecastIds: [applied.forecastId] });
    });
  });

  describe("use suggestions", () => {
    it("sets template shifts to the suggestion and skips the rest", async () => {
      const template = await friServerTemplate();
      const period = await newPeriod("Suggested");
      const applied = await applyTemplate(database(), owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: period.version,
      });
      const manual = await createShift(database(), owner, period.id, {
        positionId: scenario.waitStaff,
        restaurantAreaId: null,
        shiftDate: FRIDAY,
        startTime: "11:00",
        endTime: "15:00",
        requiredEmployeeCount: 1,
        courseOrStationNote: null,
        notes: null,
        priority: 0,
        expectedPeriodVersion: applied.periodVersion,
      });
      const { period: current } = await getPeriodDetail(database(), owner, period.id);

      await expect(
        applyForecastSuggestions(database(), owner, period.id, { expectedPeriodVersion: current.version - 1 }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      const preview = await getPeriodForecast(database(), owner, period.id);
      const line = preview.shifts.find((row) => row.shiftDate === FRIDAY && row.positionName === "WAIT_STAFF" && row.fromTemplate)!;

      expect(line).toMatchObject({ templateCount: 1, currentCount: 1, suggestedCount: 2, applyCount: 2, reason: "FORECAST" });
      expect(line.explanation).toBe("Busiest hour 19:00–19:59: 7.80 covers (history 7.80) ÷ 4 per wait_staff = 2.");
      expect(preview.shifts.find((row) => row.shiftId === manual.id)).toMatchObject({ reason: "NOT_FROM_TEMPLATE", applyCount: null });

      const result = await applyForecastSuggestions(database(), owner, period.id, {
        expectedPeriodVersion: current.version,
      });

      expect(result.updated).toBe(1);
      expect(result.skipped.map((row) => row.reason).sort()).toEqual(["NOT_FROM_TEMPLATE", "NO_RATIO"]);

      const friday = await friShifts(period.id);

      expect(friday.find((shift) => shift.positionId === scenario.waitStaff && shift.sourceRequirementId)).toMatchObject({
        requiredEmployeeCount: 2,
        demandForecastId: result.forecastId,
        templateEmployeeCount: 1,
      });
      expect(friday.find((shift) => shift.id === manual.id)).toMatchObject({ requiredEmployeeCount: 1, demandForecastId: null });
    });

    it("keeps a stored forecast as it was after the ratio changes", async () => {
      const template = await friServerTemplate();
      const period = await newPeriod("Kept");
      const applied = await applyTemplate(database(), owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: period.version,
        useForecast: true,
      });
      const [ratio] = (await getForecastSettings(database(), owner)).ratios;

      await updateRatio(database(), owner, ratio!.id, {
        measure: "DINING_COVERS",
        unitsPerEmployeeHour: "2",
        minimumEmployees: 1,
        maximumEmployees: 5,
        active: true,
        expectedVersion: ratio!.version,
      });

      const [stored] = await database().select().from(demandForecasts).where(eq(demandForecasts.id, applied.forecastId!));

      expect((stored!.method as { ratios: { unitsPerEmployeeHour: string }[] }).ratios[0]!.unitsPerEmployeeHour).toBe("4.00");
      // The preview now suggests ceil(7.80 / 2) = 4; the shift keeps 2 until a manager uses it.
      const preview = await getPeriodForecast(database(), owner, period.id);

      expect(preview.shifts.find((row) => row.positionName === "WAIT_STAFF" && row.shiftDate === FRIDAY)).toMatchObject({
        currentCount: 2,
        suggestedCount: 4,
      });

      const refreshed = await updateRatio(database(), owner, ratio!.id, {
        measure: "DINING_COVERS",
        unitsPerEmployeeHour: "4",
        minimumEmployees: 1,
        maximumEmployees: 5,
        active: true,
        expectedVersion: ratio!.version + 1,
      });

      expect(refreshed.version).toBe(ratio!.version + 2);
    });

    it("refuses stored forecast rows being changed or deleted", async () => {
      const [stored] = await database().select().from(demandForecasts).limit(1);

      expect(
        await codeOf(database().execute(sql`UPDATE demand_forecasts SET lookback_weeks = 1 WHERE id = ${stored!.id}`)),
      ).toBe("DB:demand_forecasts_append_only");
      expect(
        await codeOf(database().execute(sql`DELETE FROM demand_forecast_hours WHERE demand_forecast_id = ${stored!.id}`)),
      ).toBe("DB:demand_forecasts_append_only");
      expect(
        await codeOf(database().execute(sql`DELETE FROM demand_forecast_dates WHERE demand_forecast_id = ${stored!.id}`)),
      ).toBe("DB:demand_forecasts_append_only");
    });
  });

  describe("permissions", () => {
    it("refuses each API without its permission", async () => {
      const period = await newPeriod("Permissions");
      const viewer = await actorWith(database(), scenario, ["schedule.view"]);
      const editor = await actorWith(database(), scenario, ["schedule.view", "schedule.edit"]);

      await expect(getPeriodForecast(database(), viewer, period.id)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        applyForecastSuggestions(database(), viewer, period.id, { expectedPeriodVersion: period.version }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(getPeriodForecast(database(), editor, period.id)).resolves.toBeDefined();
      await expect(getForecastSettings(database(), editor)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        createRatio(database(), editor, {
          positionId: scenario.cook,
          measure: "ALL_CHECKS",
          unitsPerEmployeeHour: "10",
          minimumEmployees: 1,
          maximumEmployees: 3,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        addExcludedDate(database(), editor, { excludedDate: "2030-01-01", reason: "No" }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("never reads another location's history", async () => {
      const atB = await actorWith(database(), scenario, ["schedule.view", "schedule.edit"], scenario.locationB);
      const period = await createPeriod(database(), atB, { name: "B", ...PERIOD });
      const forecast = await getPeriodForecast(database(), atB, period.id);

      expect(forecast.dates.find((row) => row.businessDate === FRIDAY)!.status).toBe("NOT_ENOUGH_HISTORY");
      await expect(getPeriodForecast(database(), atB, (await newPeriod("A only")).id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });

  describe("bookings", () => {
    it("raises dining covers to the covers already booked", async () => {
      await createReservation(database(), owner, {
        guestName: "Large party",
        partySize: 12,
        localDate: FRIDAY,
        localTime: "19:00",
        source: "PHONE",
      });

      expect(
        await getBookedCovers(database(), {
          locationId: scenario.locationA,
          timeZone: "America/Detroit",
          fromDate: FRIDAY,
          toDate: FRIDAY,
        }),
      ).toEqual([{ businessDate: FRIDAY, hour: 19, covers: 12 }]);

      const period = await newPeriod("Booked");
      const forecast = await getPeriodForecast(database(), owner, period.id);

      expect(hourValues(forecast, FRIDAY, 19)).toMatchObject({
        DINING_COVERS: { history: "7.80", booked: 12, forecast: "12.00" },
        ALL_CHECKS: { booked: 0, forecast: "1.80" },
      });
    });
  });

  describe("forecast vs actual", () => {
    it("compares the stored forecast with the closed checks once the date has passed", async () => {
      // Friday turns out busier: a table of 9 at 20:10.
      await closedCheckAt(database(), scenario, { date: FRIDAY, time: "20:10", partySize: 9 });
      at("2030-03-09", "10:00");

      const labor = await runReport(database(), owner, "labor", {
        locationId: scenario.locationA,
        from: FRIDAY,
        to: FRIDAY,
      });
      const section = labor.sections.find((entry) => entry.key === "forecastAccuracy")!;

      expect(section.rows.find((row) => row.measure === "Dining covers")).toEqual({
        businessDate: FRIDAY,
        measure: "Dining covers",
        forecast: "7.80",
        actual: "9.00",
        difference: "1.20",
        differencePercent: "15.4",
        forecastBusiest: "19:00–19:59",
        actualBusiest: "20:00–20:59",
      });
      expect(section.rows.find((row) => row.measure === "Bar checks")).toMatchObject({
        forecast: "0.00",
        actual: "0.00",
        differencePercent: null,
        forecastBusiest: null,
      });

      // A date with no stored forecast has no rows, and today's date isn't compared yet.
      const before = await runReport(database(), owner, "labor", {
        locationId: scenario.locationA,
        from: "2030-03-01",
        to: "2030-03-07",
      });

      expect(before.sections.find((entry) => entry.key === "forecastAccuracy")!.rows).toEqual([]);

      at(TODAY, "10:00");
    });
  });
});
