import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { employeePositionCompensation, schedulePeriods, shifts, tableSessions } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { runReport } from "@/modules/reporting/services/report-service";
import type { ReportResult } from "@/modules/reporting/types";
import { assignEmployee, cancelShift, publishPeriod } from "@/modules/scheduling/services/schedule-service";
import { localToInstant } from "@/shared/time/zoned-time";

import { actorWith, clearEmployeeData, type HrScenario } from "../../fixtures/employee-fixtures";
import { seatedSession } from "../../fixtures/order-fixtures";
import { createRestaurantScenario, type RestaurantScenario } from "../../fixtures/restaurant-fixtures";
import {
  createDraftPeriod,
  createSchedulableEmployee,
  createSchedulingScenario,
  createShiftFixture,
  MONDAY,
  TUESDAY,
} from "../../fixtures/scheduling-fixtures";

const database = () => getDatabase();

function row(report: ReportResult, sectionKey: string, column: string, value: unknown) {
  const found = report.sections
    .find((section) => section.key === sectionKey)
    ?.rows.find((candidate) => candidate[column] === value);

  expect(found, `${sectionKey} row ${column}=${String(value)}`).toBeDefined();

  return found!;
}

async function periodVersion(periodId: string): Promise<number> {
  const [period] = await database().select().from(schedulePeriods).where(eq(schedulePeriods.id, periodId));

  return period!.version;
}

async function wage(
  scenario: HrScenario,
  employeeId: string,
  values: { compensationType: "HOURLY" | "SALARY"; hourlyRate?: string; annualSalary?: string; from: string; to?: string },
) {
  await database().insert(employeePositionCompensation).values({
    organizationId: scenario.organizationId,
    employeeId,
    positionId: scenario.server,
    compensationType: values.compensationType,
    hourlyRate: values.hourlyRate ?? null,
    annualSalary: values.annualSalary ?? null,
    effectiveFrom: values.from,
    effectiveTo: values.to ?? null,
    createdByUserId: scenario.owner.userId,
  });
}

describe("labor reporting", () => {
  let scenario: HrScenario;
  let withWages: Actor;
  let withoutWages: Actor;
  let hourlyEmployee: string;

  beforeAll(async () => {
    scenario = await createSchedulingScenario(database());
    withWages = await actorWith(database(), scenario, ["reports.view", "reports.labor", "hr.compensation.view"]);
    withoutWages = await actorWith(database(), scenario, ["reports.view", "reports.labor"]);

    hourlyEmployee = await createSchedulableEmployee(database(), scenario, { firstName: "Hourly" });

    const salaried = await createSchedulableEmployee(database(), scenario, { firstName: "Salaried" });
    const unrated = await createSchedulableEmployee(database(), scenario, { firstName: "Unrated" });

    // A raise effective Tuesday: Monday is paid at 12.00, Tuesday at 15.00.
    await wage(scenario, hourlyEmployee, { compensationType: "HOURLY", hourlyRate: "12.00", from: "2024-01-15", to: MONDAY });
    await wage(scenario, hourlyEmployee, { compensationType: "HOURLY", hourlyRate: "15.00", from: TUESDAY });
    await wage(scenario, salaried, { compensationType: "SALARY", annualSalary: "52000.00", from: "2024-01-15" });

    const period = await createDraftPeriod(database(), scenario.owner);
    const shift = async (shiftDate: string, requiredEmployeeCount: number) =>
      createShiftFixture(
        database(),
        scenario.owner,
        { id: period.id, version: await periodVersion(period.id) },
        scenario,
        { shiftDate, requiredEmployeeCount },
      );
    const assign = async (shiftId: string, employeeId: string) =>
      assignEmployee(database(), scenario.owner, shiftId, {
        employeeId,
        notes: null,
        expectedPeriodVersion: await periodVersion(period.id),
      });

    // Each shift is 17:00 to 22:00, five hours.
    const monday = await shift(MONDAY, 3);
    const tuesday = await shift(TUESDAY, 2);
    const cancelled = await shift(TUESDAY, 1);

    await assign(monday.id, hourlyEmployee);
    await assign(monday.id, salaried);
    await assign(monday.id, unrated);
    await assign(tuesday.id, hourlyEmployee);
    await cancelShift(database(), scenario.owner, cancelled.id, {
      expectedVersion: (await database().select().from(shifts).where(eq(shifts.id, cancelled.id)))[0]!.version,
      expectedPeriodVersion: await periodVersion(period.id),
    });
    await publishPeriod(database(), scenario.owner, period.id, { expectedVersion: await periodVersion(period.id) });
  });

  afterAll(async () => {
    await clearEmployeeData(database());
  });

  const labor = (actor: Actor, extra: object = {}) =>
    runReport(database(), actor, "labor", { locationId: scenario.locationA, from: MONDAY, to: TUESDAY, ...extra });

  it("costs hourly work at the rate in effect on each shift date for the Employee and Position", async () => {
    const report = await labor(withWages);

    expect(report.sections.find((section) => section.key === "summary")!.rows[0]).toMatchObject({
      shifts: 4,
      hours: "20.0000",
      cost: "135.00",
      salariedHours: "5.0000",
      noRateHours: "5.0000",
    });
    expect(row(report, "daily", "businessDate", MONDAY)).toMatchObject({ cost: "60.00", hours: "15.0000" });
    expect(row(report, "daily", "businessDate", TUESDAY)).toMatchObject({ cost: "75.00", hours: "5.0000" });
    expect(row(report, "employees", "employee", "Hourly Smith")).toMatchObject({ shifts: 2, hours: "10.0000", cost: "135.00" });
    expect(row(report, "employees", "employee", "Salaried Smith")).toMatchObject({ cost: "0.00", salariedHours: "5.0000" });
  });

  it("reports coverage against required counts, ignoring cancelled shifts", async () => {
    const report = await labor(withWages);

    expect(row(report, "coverage", "businessDate", MONDAY)).toMatchObject({ shifts: 1, required: 3, assigned: 3, unfilled: 0 });
    expect(row(report, "coverage", "businessDate", TUESDAY)).toMatchObject({ shifts: 1, required: 2, assigned: 1, unfilled: 1 });
  });

  it("hides per-employee cost without hr.compensation.view", async () => {
    const report = await labor(withoutWages);
    const employees = report.sections.find((section) => section.key === "employees")!;

    expect(employees.columns.map((column) => column.key)).not.toContain("cost");
    expect(employees.rows.every((candidate) => !("cost" in candidate))).toBe(true);
    expect(report.notes.join(" ")).toMatch(/compensation/);
    // Without reports.sales there is no labor % either.
    expect(report.sections.find((section) => section.key === "summary")!.rows[0]).not.toHaveProperty("laborPercent");
  });

  it("filters to one employee", async () => {
    const report = await labor(withWages, { employeeId: hourlyEmployee });

    expect(report.sections.find((section) => section.key === "summary")!.rows[0]).toMatchObject({ shifts: 2, cost: "135.00" });
  });

  it("uses the effective-dated history, not the current rate", async () => {
    const before = await labor(withWages);

    await database()
      .update(employeePositionCompensation)
      .set({ effectiveTo: "2030-12-31" })
      .where(sql`${employeePositionCompensation.employeeId} = ${hourlyEmployee} AND ${employeePositionCompensation.hourlyRate} = '15.00'`);
    await wage(scenario, hourlyEmployee, { compensationType: "HOURLY", hourlyRate: "99.00", from: "2031-01-01" });

    expect(await labor(withWages)).toEqual(before);
  });
});

describe("business-date windows for instant-only history", () => {
  let scenario: RestaurantScenario;
  let reporter: Actor;

  beforeAll(async () => {
    scenario = await createRestaurantScenario(database());
    reporter = await actorWith(database(), scenario, ["reports.view", "reports.seating"]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("counts a 1:15 AM seating in the previous business date (4:00 AM cutoff)", async () => {
    const late = await seatedSession(database(), scenario, { partySize: 3 });
    const nextDay = await seatedSession(database(), scenario, { partySize: 4 });
    const at = (date: string, time: string) => localToInstant(date, time, "America/Detroit")!;

    // Saturday 2030-01-12 01:15 belongs to Friday 2030-01-11; 04:00 starts Saturday.
    await database().update(tableSessions).set({ seatedAt: at("2030-01-12", "01:15") }).where(eq(tableSessions.id, late.id));
    await database().update(tableSessions).set({ seatedAt: at("2030-01-12", "04:00") }).where(eq(tableSessions.id, nextDay.id));

    const friday = await runReport(database(), reporter, "seating", {
      locationId: scenario.locationA,
      from: "2030-01-11",
      to: "2030-01-11",
    });
    const saturday = await runReport(database(), reporter, "seating", {
      locationId: scenario.locationA,
      from: "2030-01-12",
      to: "2030-01-12",
    });

    expect(row(friday, "sessions", "area", "All areas")).toMatchObject({ sessions: 1, covers: 3 });
    expect(row(saturday, "sessions", "area", "All areas")).toMatchObject({ sessions: 1, covers: 4 });
  });
});
