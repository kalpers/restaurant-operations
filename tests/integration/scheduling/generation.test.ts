import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  scheduleGenerationRuns,
  schedulePeriods,
  shiftAssignments,
  shifts,
} from "@/db/schema";
import { saveCompensationForTest } from "../../fixtures/compensation-probe";
import { addAvailabilityException, savePreferences } from "@/modules/scheduling/services/availability-service";
import { getPeriodCoverage } from "@/modules/scheduling/services/coverage-service";
import {
  listGenerationRuns,
  runGeneration,
} from "@/modules/scheduling/services/generation-service";
import {
  assignEmployee,
  getPeriodDetail,
  publishPeriod,
  removeAssignment,
} from "@/modules/scheduling/services/schedule-service";
import {
  approveTimeOff,
  requestTimeOffForEmployee,
} from "@/modules/scheduling/services/time-off-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  createDraftPeriod,
  createLinkedEmployee,
  createSchedulableEmployee,
  createSchedulingScenario,
  createShiftFixture,
  MONDAY,
  setRules,
  TUESDAY,
  type SchedulingScenario,
} from "../../fixtures/scheduling-fixtures";

const database = () => getDatabase();

async function periodVersion(periodId: string): Promise<number> {
  const [row] = await database()
    .select({ version: schedulePeriods.version })
    .from(schedulePeriods)
    .where(eq(schedulePeriods.id, periodId));

  return row!.version;
}

async function activeAssignments(periodId: string) {
  const rows = await database()
    .select({
      id: shiftAssignments.id,
      employeeId: shiftAssignments.employeeId,
      source: shiftAssignments.assignmentSource,
      shiftId: shiftAssignments.shiftId,
      runId: shiftAssignments.generationRunId,
      rationale: shiftAssignments.generationRationale,
      status: shiftAssignments.status,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(eq(shifts.schedulePeriodId, periodId));

  return rows.filter((row) => row.status === "ACTIVE");
}

describe("schedule generation", () => {
  let scenario: SchedulingScenario;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
    await setRules(database(), scenario.locationA, {});
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  async function draftWithShift(
    overrides: Parameters<typeof createShiftFixture>[4] = {},
  ) {
    const period = await createDraftPeriod(database(), scenario.owner);
    const shift = await createShiftFixture(
      database(),
      scenario.owner,
      period,
      scenario,
      overrides,
    );

    return { periodId: period.id, shiftId: shift.id };
  }

  const run = async (
    periodId: string,
    mode: "GENERATE_DRAFT" | "FILL_OPEN_SHIFTS" = "GENERATE_DRAFT",
    hooks: Parameters<typeof runGeneration>[4] = {},
    actor = scenario.owner,
  ) =>
    runGeneration(
      database(),
      actor,
      periodId,
      { mode, expectedVersion: await periodVersion(periodId) },
      hooks,
    );

  const preferTarget = (employeeId: string, targetHoursPerWeek: string) =>
    savePreferences(
      database(),
      scenario.owner,
      { kind: "employee", employeeId },
      {
        targetHoursPerWeek,
        minimumHoursPerWeek: null,
        maximumHoursPerWeek: null,
        maximumDaysPerWeek: null,
        maximumConsecutiveDays: null,
        preferredShiftStart: null,
        preferredShiftEnd: null,
        preferWeekends: null,
        preferOpening: null,
        preferClosing: null,
        expectedVersion: null,
      },
    );

  it("creates ordinary assignments with GENERATED provenance and a rationale", async () => {
    const { periodId, shiftId } = await draftWithShift();
    const employeeId = await createSchedulableEmployee(database(), scenario);
    const result = await run(periodId);
    const [assignment] = await activeAssignments(periodId);

    expect(result.created).toBe(1);
    expect(assignment).toMatchObject({
      employeeId,
      shiftId,
      source: "GENERATED",
      runId: result.runId,
    });
    expect(JSON.stringify(assignment?.rationale)).toContain("Holds the position");
  });

  it("never publishes", async () => {
    const { periodId } = await draftWithShift();

    await createSchedulableEmployee(database(), scenario);

    const result = await run(periodId);
    const [row] = await database()
      .select()
      .from(schedulePeriods)
      .where(eq(schedulePeriods.id, periodId));

    expect(result.status).toBe("DRAFT");
    expect(row).toMatchObject({ status: "DRAFT", publishedAt: null });
  });

  it("selects the candidate under target when other scoring is equal", async () => {
    const { periodId } = await draftWithShift({ shiftDate: TUESDAY });
    const over = await createSchedulableEmployee(database(), scenario, {
      employeeNumber: "A-OVER",
    });
    const under = await createSchedulableEmployee(database(), scenario, {
      employeeNumber: "B-UNDER",
    });

    // Monday hours put the first over target. They're in another draft of the same week.
    const other = await createDraftPeriod(database(), scenario.owner, {
      name: "Other",
    });
    const monday = await createShiftFixture(
      database(),
      scenario.owner,
      other,
      scenario,
      { shiftDate: MONDAY, startTime: "09:00", endTime: "14:00" },
    );

    await assignEmployee(database(), scenario.owner, monday.id, {
      employeeId: over,
      notes: null,
      expectedPeriodVersion: await periodVersion(other.id),
    });
    await preferTarget(over, "4.00");
    await preferTarget(under, "4.00");

    await run(periodId);

    expect((await activeAssignments(periodId)).map((row) => row.employeeId)).toEqual([
      under,
    ]);
  });

  it("never considers someone with approved time off, however strong their score", async () => {
    const { periodId } = await draftWithShift();
    const strong = await createSchedulableEmployee(database(), scenario, {
      employeeNumber: "A-STRONG",
    });
    const weak = await createSchedulableEmployee(database(), scenario, {
      employeeNumber: "B-WEAK",
    });

    await preferTarget(strong, "40.00");

    const { id } = await requestTimeOffForEmployee(
      database(),
      scenario.owner,
      strong,
      {
        startDate: MONDAY,
        startTime: null,
        endDate: MONDAY,
        endTime: null,
        requestType: "VACATION",
        reason: null,
        employeeNote: null,
      },
    );

    await approveTimeOff(database(), scenario.owner, id, {
      managerNote: null,
      expectedVersion: 1,
    });
    await run(periodId);

    expect((await activeAssignments(periodId)).map((row) => row.employeeId)).toEqual([
      weak,
    ]);
  });

  it("never assigns on a security role: the login holds no position", async () => {
    const { periodId, shiftId } = await draftWithShift({
      positionId: scenario.bartender,
    });

    await createLinkedEmployee(
      database(),
      scenario,
      ["kitchen.manage", "orders.submit", "schedule.view"],
      { positionId: scenario.server },
    );

    const result = await run(periodId);

    expect(result.created).toBe(0);
    expect(result.unfilled[0]).toMatchObject({ shiftId, openSlots: 1 });
    expect(result.unfilled[0]?.reasons.map((reason) => reason.code)).toContain(
      "POSITION_NOT_HELD",
    );
  });

  it("prefers the candidate who doesn't cause overtime", async () => {
    const { periodId } = await draftWithShift({ shiftDate: TUESDAY });
    const busy = await createSchedulableEmployee(database(), scenario, {
      employeeNumber: "A-BUSY",
    });
    const free = await createSchedulableEmployee(database(), scenario, {
      employeeNumber: "B-FREE",
    });
    const other = await createDraftPeriod(database(), scenario.owner, {
      name: "Other",
    });
    const monday = await createShiftFixture(
      database(),
      scenario.owner,
      other,
      scenario,
      { shiftDate: MONDAY, startTime: "08:00", endTime: "20:00" },
    );

    await assignEmployee(database(), scenario.owner, monday.id, {
      employeeId: busy,
      notes: null,
      expectedPeriodVersion: await periodVersion(other.id),
    });
    await setRules(database(), scenario.locationA, {
      avoidOvertime: true,
      weeklyOvertimeThreshold: "14.00",
    });

    await run(periodId);

    expect((await activeAssignments(periodId)).map((row) => row.employeeId)).toEqual([
      free,
    ]);
  });

  it("leaves a shift open with an explanation and a coverage shortage", async () => {
    const { periodId, shiftId } = await draftWithShift({
      positionId: scenario.bartender,
    });

    await createSchedulableEmployee(database(), scenario);

    const result = await run(periodId);
    const coverage = await getPeriodCoverage(
      database(),
      scenario.owner,
      periodId,
    );
    const [stored] = await database()
      .select()
      .from(scheduleGenerationRuns)
      .where(eq(scheduleGenerationRuns.id, result.runId));

    expect(result.created).toBe(0);
    expect(coverage).toMatchObject({ open: 1, openShiftIds: [shiftId] });
    expect(stored).toMatchObject({
      status: "COMPLETED",
      createdAssignmentCount: 0,
      unfilledShiftCount: 1,
    });
    expect(JSON.stringify(stored?.unfilledDetails)).toContain(
      "don't hold this position",
    );
  });

  it("Generate Draft refuses a schedule that already has assignments", async () => {
    const { periodId, shiftId } = await draftWithShift({
      requiredEmployeeCount: 2,
    });
    const employeeId = await createSchedulableEmployee(database(), scenario);

    await assignEmployee(database(), scenario.owner, shiftId, {
      employeeId,
      notes: null,
      expectedPeriodVersion: await periodVersion(periodId),
    });

    await expect(run(periodId)).rejects.toMatchObject({
      code: "SCHEDULE_NOT_UNASSIGNED",
    });
    expect(
      await database()
        .select()
        .from(scheduleGenerationRuns)
        .where(eq(scheduleGenerationRuns.schedulePeriodId, periodId)),
    ).toEqual([]);
  });

  it("Generate Draft needs at least one shift", async () => {
    const period = await createDraftPeriod(database(), scenario.owner);

    await expect(run(period.id)).rejects.toMatchObject({
      code: "SCHEDULE_HAS_NO_SHIFTS",
    });
  });

  it("Fill Open Shifts leaves manual assignments untouched and fills only the gaps", async () => {
    const { periodId, shiftId } = await draftWithShift({
      requiredEmployeeCount: 2,
    });
    const manual = await createSchedulableEmployee(database(), scenario, {
      employeeNumber: "A-MANUAL",
    });
    const other = await createSchedulableEmployee(database(), scenario, {
      employeeNumber: "B-OTHER",
    });
    const third = await createSchedulableEmployee(database(), scenario, {
      employeeNumber: "C-THIRD",
    });
    const { id: manualId } = await assignEmployee(
      database(),
      scenario.owner,
      shiftId,
      {
        employeeId: manual,
        notes: "Requested by owner",
        expectedPeriodVersion: await periodVersion(periodId),
      },
    );
    const [before] = await database()
      .select()
      .from(shiftAssignments)
      .where(eq(shiftAssignments.id, manualId));
    const result = await run(periodId, "FILL_OPEN_SHIFTS");
    const [after] = await database()
      .select()
      .from(shiftAssignments)
      .where(eq(shiftAssignments.id, manualId));
    const rows = await activeAssignments(periodId);

    expect(after).toEqual(before);
    expect(result.created).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.source === "GENERATED")?.employeeId).toBe(other);
    expect(rows.map((row) => row.employeeId)).not.toContain(third);
  });

  it("running Fill Open Shifts again creates nothing more", async () => {
    const { periodId } = await draftWithShift();

    await createSchedulableEmployee(database(), scenario);
    await createSchedulableEmployee(database(), scenario);

    await run(periodId, "FILL_OPEN_SHIFTS");
    const second = await run(periodId, "FILL_OPEN_SHIFTS");

    expect(second.created).toBe(0);
    expect(await activeAssignments(periodId)).toHaveLength(1);
  });

  it("gives the same assignments for identical input", async () => {
    const outcomes: string[][] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const isolated = await createSchedulingScenario(database());
      const period = await createDraftPeriod(database(), isolated.owner);
      const first = await createShiftFixture(
        database(),
        isolated.owner,
        period,
        isolated,
        { shiftDate: MONDAY, requiredEmployeeCount: 2 },
      );
      const second = await createShiftFixture(
        database(),
        isolated.owner,
        { id: period.id, version: await periodVersion(period.id) },
        isolated,
        { shiftDate: TUESDAY, requiredEmployeeCount: 2 },
      );

      for (const number of ["N-1", "N-2", "N-3"]) {
        await createSchedulableEmployee(database(), isolated, {
          employeeNumber: `${number}`,
        });
      }

      await runGeneration(database(), isolated.owner, period.id, {
        mode: "GENERATE_DRAFT",
        expectedVersion: await periodVersion(period.id),
      });

      const detail = await getPeriodDetail(database(), isolated.owner, period.id);
      const numbers = new Map([
        [first.id, "first"],
        [second.id, "second"],
      ]);

      outcomes.push(
        detail.shifts.flatMap((shift) =>
          shift.assignments.map(
            (assignment) => `${numbers.get(shift.id)}:${assignment.employeeName}`,
          ),
        ),
      );
    }

    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  describe("stale generation", () => {
    it("rejects a version that's already stale", async () => {
      const { periodId } = await draftWithShift();

      await expect(
        runGeneration(database(), scenario.owner, periodId, {
          mode: "GENERATE_DRAFT",
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("can't overwrite a manager's change made while it computed", async () => {
      const { periodId, shiftId } = await draftWithShift({
        requiredEmployeeCount: 2,
      });
      const manual = await createSchedulableEmployee(database(), scenario, {
        employeeNumber: "A-MANUAL",
      });

      await createSchedulableEmployee(database(), scenario, {
        employeeNumber: "B-OTHER",
      });

      await expect(
        run(periodId, "GENERATE_DRAFT", {
          afterCompute: async () => {
            await assignEmployee(database(), scenario.owner, shiftId, {
              employeeId: manual,
              notes: null,
              expectedPeriodVersion: await periodVersion(periodId),
            });
          },
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      const rows = await activeAssignments(periodId);
      const runs = await listGenerationRuns(database(), scenario.owner, periodId);

      expect(rows.map((row) => row.source)).toEqual(["MANUAL"]);
      expect(runs[0]).toMatchObject({
        status: "FAILED",
        failureCode: "CONCURRENCY_CONFLICT",
        createdAssignmentCount: 0,
      });
    });

    it("rejects a proposal if a hard fact changed while it computed", async () => {
      const { periodId } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await expect(
        run(periodId, "GENERATE_DRAFT", {
          afterCompute: async () => {
            await addAvailabilityException(
              database(),
              scenario.owner,
              { kind: "employee", employeeId },
              {
                exceptionDate: MONDAY,
                startTime: null,
                endTime: null,
                availabilityType: "UNAVAILABLE",
                reason: null,
                thisLocationOnly: false,
              },
            );
          },
        }),
      ).rejects.toMatchObject({ code: "GENERATION_STALE" });
      expect(await activeAssignments(periodId)).toEqual([]);
    });

    it("lets only one of two simultaneous runs write", async () => {
      const { periodId } = await draftWithShift();

      await createSchedulableEmployee(database(), scenario);

      const version = await periodVersion(periodId);
      const results = await Promise.allSettled([
        runGeneration(database(), scenario.owner, periodId, {
          mode: "FILL_OPEN_SHIFTS",
          expectedVersion: version,
        }),
        runGeneration(database(), scenario.owner, periodId, {
          mode: "FILL_OPEN_SHIFTS",
          expectedVersion: version,
        }),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(await activeAssignments(periodId)).toHaveLength(1);
    });
  });

  describe("failure", () => {
    it("writes no assignments, records a safe failure and leaves the draft intact", async () => {
      const { periodId, shiftId } = await draftWithShift({
        requiredEmployeeCount: 2,
      });
      const manual = await createSchedulableEmployee(database(), scenario);

      await assignEmployee(database(), scenario.owner, shiftId, {
        employeeId: manual,
        notes: null,
        expectedPeriodVersion: await periodVersion(periodId),
      });

      const before = await periodVersion(periodId);

      await expect(
        run(periodId, "FILL_OPEN_SHIFTS", {
          generator: () => {
            throw new Error("secret internal detail");
          },
        }),
      ).rejects.toMatchObject({ code: "GENERATION_FAILED" });

      const runs = await listGenerationRuns(database(), scenario.owner, periodId);

      expect(await periodVersion(periodId)).toBe(before);
      expect((await activeAssignments(periodId)).map((row) => row.employeeId)).toEqual(
        [manual],
      );
      expect(runs[0]).toMatchObject({
        status: "FAILED",
        failureCode: "GENERATION_FAILED",
      });
      expect(JSON.stringify(runs[0])).not.toContain("secret internal detail");
    });
  });

  describe("published schedules", () => {
    it("are never regenerated", async () => {
      const { periodId } = await draftWithShift();

      await createSchedulableEmployee(database(), scenario);

      const published = await publishPeriod(
        database(),
        scenario.owner,
        periodId,
        { expectedVersion: await periodVersion(periodId) },
      );

      await expect(
        runGeneration(database(), scenario.owner, periodId, {
          mode: "FILL_OPEN_SHIFTS",
          expectedVersion: published.version,
        }),
      ).rejects.toMatchObject({ code: "SCHEDULE_NOT_DRAFT" });
      expect(await activeAssignments(periodId)).toEqual([]);
    });
  });

  describe("manager override", () => {
    it("a generated assignment can be removed and replaced, through the same validation", async () => {
      const { periodId, shiftId } = await draftWithShift();
      const first = await createSchedulableEmployee(database(), scenario, {
        employeeNumber: "A",
      });
      const second = await createSchedulableEmployee(database(), scenario, {
        employeeNumber: "B",
      });
      const unavailable = await createSchedulableEmployee(database(), scenario, {
        employeeNumber: "C",
        available: false,
      });

      await run(periodId);

      const [generated] = await activeAssignments(periodId);

      expect(generated?.employeeId).toBe(first);

      await removeAssignment(database(), scenario.owner, generated!.id, {
        expectedPeriodVersion: await periodVersion(periodId),
      });

      await expect(
        assignEmployee(database(), scenario.owner, shiftId, {
          employeeId: unavailable,
          notes: null,
          expectedPeriodVersion: await periodVersion(periodId),
        }),
      ).rejects.toMatchObject({ code: "AVAILABILITY_NOT_CONFIGURED" });

      await assignEmployee(database(), scenario.owner, shiftId, {
        employeeId: second,
        notes: null,
        expectedPeriodVersion: await periodVersion(periodId),
      });

      const [replacement] = await activeAssignments(periodId);

      expect(replacement).toMatchObject({ employeeId: second, source: "MANUAL" });
    });
  });

  describe("explainability and HR boundaries", () => {
    it("snapshots rules and weights, and no employee data", async () => {
      const { periodId } = await draftWithShift();

      await createSchedulableEmployee(database(), scenario, {
        firstName: "Distinctive",
      });

      const result = await run(periodId);
      const [stored] = await database()
        .select()
        .from(scheduleGenerationRuns)
        .where(eq(scheduleGenerationRuns.id, result.runId));
      const snapshot = JSON.stringify(stored?.rulesSnapshot);

      expect(snapshot).toContain("crossesOvertimeThreshold");
      expect(snapshot).toContain("weeklyOvertimeThreshold");
      expect(snapshot).not.toContain("Distinctive");
      expect(JSON.stringify(stored)).not.toContain("Distinctive");
    });

    it("compensation changes nothing about who is chosen, and never appears", async () => {
      const { periodId } = await draftWithShift();
      const pricey = await createSchedulableEmployee(database(), scenario, {
        employeeNumber: "A-PRICEY",
      });
      const cheap = await createSchedulableEmployee(database(), scenario, {
        employeeNumber: "B-CHEAP",
      });

      await saveCompensationForTest(database(), scenario, pricey, "98.76");
      await saveCompensationForTest(database(), scenario, cheap, "1.23");

      const result = await run(periodId);
      const [assignment] = await activeAssignments(periodId);
      const detail = await getPeriodDetail(database(), scenario.owner, periodId);
      const coverage = await getPeriodCoverage(
        database(),
        scenario.owner,
        periodId,
      );
      const everything = JSON.stringify({ result, assignment, detail, coverage });

      // The tie goes to the lower employee number, not the lower wage.
      expect(assignment?.employeeId).toBe(pricey);
      expect(everything).not.toContain("98.76");
      expect(everything).not.toContain("1.23");
      expect(everything).not.toMatch(/hourlyRate|annualSalary|compensation/i);
    });

    it("hides the rationale from someone who can only view", async () => {
      const { periodId } = await draftWithShift();

      await createSchedulableEmployee(database(), scenario);
      await run(periodId);

      const published = await publishPeriod(
        database(),
        scenario.owner,
        periodId,
        { expectedVersion: await periodVersion(periodId) },
      );
      const viewer = await actorWith(database(), scenario, ["schedule.view"]);
      const detail = await getPeriodDetail(database(), viewer, published.id);

      expect(detail.shifts[0]?.assignments[0]?.rationale).toBeNull();
    });
  });

  describe("authorization", () => {
    it("needs schedule.generate, even with edit and publish", async () => {
      const { periodId } = await draftWithShift();
      const actor = await actorWith(database(), scenario, [
        "schedule.view",
        "schedule.edit",
        "schedule.publish",
      ]);

      await expect(
        run(periodId, "GENERATE_DRAFT", {}, actor),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("schedule.view alone can't read run history", async () => {
      const { periodId } = await draftWithShift();
      const actor = await actorWith(database(), scenario, ["schedule.view"]);

      await expect(
        listGenerationRuns(database(), actor, periodId),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });
});
