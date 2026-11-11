import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { employeePositionCompensation, idempotencyRecords, schedulePeriods, timeEntries } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { runReport } from "@/modules/reporting/services/report-service";
import type { ReportResult } from "@/modules/reporting/types";
import { assignEmployee, publishPeriod } from "@/modules/scheduling/services/schedule-service";
import { adjustEntry, voidEntry } from "@/modules/scheduling/services/timeclock-service";

import { actorWith, clearEmployeeData, type HrScenario } from "../../fixtures/employee-fixtures";
import {
  createDraftPeriod,
  createSchedulableEmployee,
  createSchedulingScenario,
  createShiftFixture,
} from "../../fixtures/scheduling-fixtures";
import { insertClosedEntry, key } from "../../fixtures/timeclock-fixtures";

const database = () => getDatabase();

// 2025-02-03 is a Monday; Detroit is UTC-5 in February. The default week starts on Monday and
// the default overtime threshold is 40 hours at 1.50x.
const MON = "2025-02-03";
const TUE = "2025-02-04";
const WED = "2025-02-05";
const THU = "2025-02-06";
const FRI = "2025-02-07";
const local = (date: string, time: string) => new Date(`${date}T${time}:00-05:00`);

function section(report: ReportResult, sectionKey: string) {
  const found = report.sections.find((candidate) => candidate.key === sectionKey);

  expect(found, sectionKey).toBeDefined();

  return found!;
}

function rowOf(report: ReportResult, sectionKey: string, match: Record<string, unknown>) {
  const found = section(report, sectionKey).rows.find((row) =>
    Object.entries(match).every(([column, value]) => row[column] === value),
  );

  expect(found, `${sectionKey} ${JSON.stringify(match)}`).toBeDefined();

  return found!;
}

async function periodVersion(periodId: string) {
  const [row] = await database().select().from(schedulePeriods).where(eq(schedulePeriods.id, periodId));

  return row!.version;
}

describe("actual labor reporting", () => {
  let scenario: HrScenario;
  let withWages: Actor;
  let withoutWages: Actor;
  let hourly: string;
  let other: string;
  let numbers: { hourly: string; other: string };

  const report = (actor: Actor, from: string, to: string) =>
    runReport(database(), actor, "labor", { locationId: scenario.locationA, from, to });

  beforeAll(async () => {
    scenario = await createSchedulingScenario(database());
    withWages = await actorWith(database(), scenario, ["reports.view", "reports.labor", "hr.compensation.view"]);
    withoutWages = await actorWith(database(), scenario, ["reports.view", "reports.labor"]);
    hourly = await createSchedulableEmployee(database(), scenario, { employeeNumber: "AL-1", firstName: "Hourly" });
    other = await createSchedulableEmployee(database(), scenario, { employeeNumber: "AL-2", firstName: "Other" });
    numbers = { hourly: "AL-1", other: "AL-2" };

    // A raise effective Wednesday: Monday and Tuesday at 20.00, then 25.00.
    for (const [rate, from, to] of [
      ["20.00", "2024-01-15", TUE],
      ["25.00", WED, null],
    ] as const) {
      await database().insert(employeePositionCompensation).values({
        organizationId: scenario.organizationId,
        employeeId: hourly,
        positionId: scenario.server,
        compensationType: "HOURLY",
        hourlyRate: rate,
        effectiveFrom: from,
        effectiveTo: to,
        createdByUserId: scenario.owner.userId,
      });
    }

    // Published shifts: Thursday 10:00-20:00 for the hourly employee (they clock in 10 minutes
    // late), and Monday 17:00-22:00 for the other employee, who never comes (a no-show).
    const period = await createDraftPeriod(database(), scenario.owner, { startDate: MON, endDate: "2025-02-09" });
    const thursday = await createShiftFixture(database(), scenario.owner, { id: period.id, version: await periodVersion(period.id) }, scenario, {
      shiftDate: THU,
      startTime: "10:00",
      endTime: "20:00",
    });
    const monday = await createShiftFixture(database(), scenario.owner, { id: period.id, version: await periodVersion(period.id) }, scenario, {
      shiftDate: MON,
      startTime: "17:00",
      endTime: "22:00",
    });
    const thursdayAssignment = await assignEmployee(database(), scenario.owner, thursday.id, {
      employeeId: hourly,
      notes: null,
      expectedPeriodVersion: await periodVersion(period.id),
    });

    await assignEmployee(database(), scenario.owner, monday.id, {
      employeeId: other,
      notes: null,
      expectedPeriodVersion: await periodVersion(period.id),
    });
    await publishPeriod(database(), scenario.owner, period.id, { expectedVersion: await periodVersion(period.id) });

    const entry = (date: string, from: string, to: string, extra: Partial<Parameters<typeof insertClosedEntry>[2]> = {}) =>
      insertClosedEntry(database(), scenario.owner, {
        employeeId: hourly,
        positionId: scenario.server,
        businessDate: date,
        clockInAt: local(date, from),
        clockOutAt: local(date, to),
        ...extra,
      });

    // Monday: 09:00-20:00 with an hour's unpaid break = 10 h. Tuesday to Thursday 10 h each.
    // That makes 40 h by Thursday, so all 5 h on Friday are overtime.
    await entry(MON, "09:00", "20:00", { unpaidBreak: { startedAt: local(MON, "13:00"), endedAt: local(MON, "14:00") } });
    await entry(TUE, "09:00", "19:00");
    await entry(WED, "09:00", "19:00");
    await entry(THU, "10:10", "20:10", { shiftAssignmentId: thursdayAssignment.id });
    await entry(FRI, "09:00", "14:00");

    // The other employee: one unscheduled entry that a manager shortens, and one voided.
    const adjusted = await insertClosedEntry(database(), scenario.owner, {
      employeeId: other,
      positionId: scenario.server,
      businessDate: TUE,
      clockInAt: local(TUE, "12:00"),
      clockOutAt: local(TUE, "16:00"),
    });

    await adjustEntry(database(), scenario.owner, adjusted, {
      expectedVersion: 1,
      reason: "Left early, forgot to punch",
      clockOutAt: local(TUE, "15:00"),
    });

    const voided = await insertClosedEntry(database(), scenario.owner, {
      employeeId: other,
      positionId: scenario.server,
      businessDate: WED,
      clockInAt: local(WED, "12:00"),
      clockOutAt: local(WED, "13:00"),
    });

    await voidEntry(database(), scenario.owner, voided, { expectedVersion: 1, reason: "Punched the wrong person" });

    // A missed clock-out on Thursday: still OPEN.
    const [record] = await database()
      .insert(idempotencyRecords)
      .values({
        organizationId: scenario.organizationId,
        scope: "timeclock.clock-in",
        idempotencyKey: key(),
        actorUserId: scenario.owner.userId,
        requestFingerprint: "fixture",
        response: {},
      })
      .returning({ id: idempotencyRecords.id });

    await database().insert(timeEntries).values({
      organizationId: scenario.organizationId,
      locationId: scenario.locationA,
      employeeId: other,
      positionId: scenario.server,
      businessDate: THU,
      clockInAt: local(THU, "18:00"),
      clockInRecordedAt: local(THU, "18:00"),
      clockInSource: "MANAGER",
      clockInByUserId: scenario.owner.userId,
      clockInIdempotencyRecordId: record!.id,
    });
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  it("keeps the scheduled sections first and unchanged in shape", async () => {
    const result = await report(withWages, MON, FRI);

    expect(result.sections.map((candidate) => candidate.key)).toEqual([
      "summary",
      "positions",
      "daily",
      "employees",
      "coverage",
      "actual",
      "actualEmployees",
      "scheduledVsActual",
      "overtime",
      "exceptions",
    ]);
  });

  it("costs worked hours at the rate in effect each day, with weekly overtime at 1.5x", async () => {
    const result = await report(withWages, MON, FRI);

    expect(rowOf(result, "actualEmployees", { employeeNumber: numbers.hourly })).toMatchObject({
      entries: 5,
      workedHours: "45.0000",
      regularHours: "40.0000",
      overtimeHours: "5.0000",
      // Mon + Tue at 20.00 (400.00), Wed + Thu at 25.00 (500.00); Fri 5 h x 25.00 x 1.5.
      regularCost: "900.00",
      overtimeCost: "187.50",
      totalCost: "1087.50",
    });
    // The other employee's adjusted entry is 3 h with no rate; the voided one counts nowhere.
    expect(rowOf(result, "actualEmployees", { employeeNumber: numbers.other })).toMatchObject({
      entries: 1,
      workedHours: "3.0000",
      noRateHours: "3.0000",
    });
    expect(rowOf(result, "overtime", { employeeNumber: numbers.hourly, weekStart: MON })).toMatchObject({
      workedHours: "45.0000",
      thresholdHours: "40.0000",
      overtimeHours: "5.0000",
    });
  });

  it("gives a date the same overtime whatever range is chosen", async () => {
    const friday = await report(withWages, FRI, FRI);

    expect(rowOf(friday, "actualEmployees", { employeeNumber: numbers.hourly })).toMatchObject({
      workedHours: "5.0000",
      regularHours: "0.0000",
      overtimeHours: "5.0000",
      overtimeCost: "187.50",
    });
  });

  it("hides every cost without the compensation-view permission", async () => {
    const result = await report(withoutWages, MON, FRI);
    const actual = section(result, "actual");

    expect(actual.columns.map((column) => column.key)).not.toContain("totalCost");
    expect(Object.keys(actual.rows[0]!)).not.toContain("regularCost");
    expect(Object.keys(rowOf(result, "actualEmployees", { employeeNumber: numbers.hourly }))).not.toContain(
      "overtimeCost",
    );
  });

  it("compares scheduled and worked time, with late, unscheduled and no-show flags", async () => {
    const result = await report(withWages, MON, FRI);

    expect(rowOf(result, "scheduledVsActual", { businessDate: THU, employeeNumber: numbers.hourly })).toMatchObject({
      scheduledHours: "10.0000",
      workedHours: "10.0000",
      varianceHours: "0.0000",
      late: 1,
      earlyOut: 0,
      unscheduled: 0,
    });
    expect(rowOf(result, "scheduledVsActual", { businessDate: MON, employeeNumber: numbers.other })).toMatchObject({
      scheduledHours: "5.0000",
      workedHours: "0.0000",
      varianceHours: "-5.0000",
      noShow: 1,
    });
    expect(rowOf(result, "scheduledVsActual", { businessDate: TUE, employeeNumber: numbers.other })).toMatchObject({
      unscheduled: 1,
    });
  });

  it("lists missed clock-outs, adjustments and voids as exceptions", async () => {
    const result = await report(withWages, MON, FRI);
    const kinds = section(result, "exceptions").rows.map((row) => [row.businessDate, row.kind, row.detail]);

    expect(kinds).toEqual(
      expect.arrayContaining([
        [TUE, "Adjusted", "Left early, forgot to punch"],
        [WED, "Voided", "Punched the wrong person"],
        [THU, "Missed clock-out", expect.any(String)],
      ]),
    );
  });

  it("uses a later rate change for nothing in the past", async () => {
    await database()
      .insert(employeePositionCompensation)
      .values({
        organizationId: scenario.organizationId,
        employeeId: other,
        positionId: scenario.server,
        compensationType: "HOURLY",
        hourlyRate: "30.00",
        effectiveFrom: "2026-01-01",
        createdByUserId: scenario.owner.userId,
      });

    const result = await report(withWages, MON, FRI);

    expect(rowOf(result, "actualEmployees", { employeeNumber: numbers.other })).toMatchObject({
      noRateHours: "3.0000",
      totalCost: "0.00",
    });
  });
});
