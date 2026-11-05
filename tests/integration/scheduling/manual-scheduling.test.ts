import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { employees, schedulePeriods, shiftAssignments, shifts, userRoles } from "@/db/schema";
import { changeEmployeeStatus } from "@/modules/employees/services/status-service";
import { terminateEmployee } from "@/workflows/terminate-employee/terminate-employee";
import { getPeriodCoverage } from "@/modules/scheduling/services/coverage-service";
import {
  archivePeriod,
  assignEmployee,
  cancelShift,
  createPeriod,
  getPeriodDetail,
  listCandidates,
  listPeriods,
  publishPeriod,
  removeAssignment,
  updatePeriod,
  updateShift,
} from "@/modules/scheduling/services/schedule-service";
import {
  AuthorizationError,
  BusinessRuleError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { actorAt } from "../../fixtures/auth-fixtures";
import {
  ABSENT_ID,
  actorWith,
  clearEmployeeData,
} from "../../fixtures/employee-fixtures";
import {
  addPosition,
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

describe("manual scheduling", () => {
  let scenario: SchedulingScenario;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
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

    return { period, shift };
  }

  const assign = async (shiftId: string, employeeId: string, periodId: string) =>
    assignEmployee(database(), scenario.owner, shiftId, {
      employeeId,
      notes: null,
      expectedPeriodVersion: await periodVersion(periodId),
    });

  describe("periods", () => {
    it("creates a draft belonging to the actor's location", async () => {
      const period = await createDraftPeriod(database(), scenario.owner);

      expect(period).toMatchObject({
        status: "DRAFT",
        locationId: scenario.locationA,
        createdByUserId: scenario.owner.userId,
        publishedAt: null,
      });
    });

    it("rejects a start date after the end date", async () => {
      await expect(
        createPeriod(database(), scenario.owner, {
          name: "Backward",
          startDate: "2030-01-10",
          endDate: "2030-01-07",
        }),
      ).rejects.toThrow("start date");
    });

    it("rejects a stale edit", async () => {
      const period = await createDraftPeriod(database(), scenario.owner);
      const input = {
        name: "Renamed",
        startDate: period.startDate,
        endDate: period.endDate,
      };

      await updatePeriod(database(), scenario.owner, period.id, {
        ...input,
        expectedVersion: period.version,
      });

      await expect(
        updatePeriod(database(), scenario.owner, period.id, {
          ...input,
          expectedVersion: period.version,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("refuses dates that would leave a shift outside the period", async () => {
      const { period } = await draftWithShift({ shiftDate: TUESDAY });

      await expect(
        updatePeriod(database(), scenario.owner, period.id, {
          name: "Shorter",
          startDate: MONDAY,
          endDate: MONDAY,
          expectedVersion: await periodVersion(period.id),
        }),
      ).rejects.toMatchObject({ code: "SHIFTS_OUTSIDE_PERIOD" });
    });

    it("doesn't show one location's period at another", async () => {
      const period = await createDraftPeriod(database(), scenario.owner);

      await expect(
        getPeriodDetail(database(), scenario.ownerAtB, period.id),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await listPeriods(database(), scenario.ownerAtB)).toEqual([]);
    });
  });

  describe("shifts", () => {
    it("stores real instants for a shift crossing midnight, on its local start date", async () => {
      const { shift } = await draftWithShift({
        shiftDate: MONDAY,
        startTime: "20:00",
        endTime: "02:00",
      });

      expect(shift.shiftDate).toBe(MONDAY);
      expect(shift.startAt.toISOString()).toBe("2030-01-08T01:00:00.000Z");
      expect(shift.endAt.toISOString()).toBe("2030-01-08T07:00:00.000Z");
    });

    it("rejects a local time the clocks skip", async () => {
      const period = await createDraftPeriod(database(), scenario.owner, {
        startDate: "2030-03-10",
        endDate: "2030-03-10",
      });

      await expect(
        createShiftFixture(database(), scenario.owner, period, scenario, {
          shiftDate: "2030-03-10",
          startTime: "02:30",
          endTime: "06:00",
        }),
      ).rejects.toMatchObject({ code: "SHIFT_TIME_DOES_NOT_EXIST" });
    });

    it("rejects a date outside the period", async () => {
      const period = await createDraftPeriod(database(), scenario.owner);

      await expect(
        createShiftFixture(database(), scenario.owner, period, scenario, {
          shiftDate: "2030-02-01",
        }),
      ).rejects.toMatchObject({ code: "SHIFT_OUTSIDE_PERIOD" });
    });

    it("rejects another organization's position and another location's area", async () => {
      const other = await createSchedulingScenario(database());
      const period = await createDraftPeriod(database(), scenario.owner);

      await expect(
        createShiftFixture(database(), scenario.owner, period, {
          server: other.server,
        }),
      ).rejects.toThrow("active position");
      await expect(
        createShiftFixture(database(), scenario.owner, period, scenario, {
          restaurantAreaId: ABSENT_ID,
        }),
      ).rejects.toThrow("active area");
    });

    it("advances the period version, so a stale shift creation is rejected", async () => {
      const { period } = await draftWithShift();

      await expect(
        createShiftFixture(database(), scenario.owner, period, scenario),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("rejects a stale shift version", async () => {
      const { period, shift } = await draftWithShift();
      const input = {
        positionId: scenario.server,
        restaurantAreaId: null,
        shiftDate: MONDAY,
        startTime: "18:00",
        endTime: "22:00",
        requiredEmployeeCount: 1,
        courseOrStationNote: null,
        notes: null,
        priority: 0,
      };

      await updateShift(database(), scenario.owner, shift.id, {
        ...input,
        expectedVersion: shift.version,
        expectedPeriodVersion: await periodVersion(period.id),
      });

      await expect(
        updateShift(database(), scenario.owner, shift.id, {
          ...input,
          expectedVersion: shift.version,
          expectedPeriodVersion: await periodVersion(period.id),
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("keeps a cancelled shift's row and refuses it when it has assignees", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);

      const { id: assignmentId } = await assign(shift.id, employeeId, period.id);

      await expect(
        cancelShift(database(), scenario.owner, shift.id, {
          expectedVersion: shift.version,
          expectedPeriodVersion: await periodVersion(period.id),
        }),
      ).rejects.toMatchObject({ code: "SHIFT_HAS_ASSIGNMENTS" });

      await removeAssignment(database(), scenario.owner, assignmentId, {
        expectedPeriodVersion: await periodVersion(period.id),
      });
      await cancelShift(database(), scenario.owner, shift.id, {
        expectedVersion: shift.version,
        expectedPeriodVersion: await periodVersion(period.id),
      });

      const [row] = await database()
        .select()
        .from(shifts)
        .where(eq(shifts.id, shift.id));
      const detail = await getPeriodDetail(database(), scenario.owner, period.id);

      expect(row?.cancelledAt).not.toBeNull();
      expect(detail.shifts).toEqual([]);
    });
  });

  describe("assignment", () => {
    it("assigns an eligible employee with MANUAL provenance", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const result = await assign(shift.id, employeeId, period.id);
      const [row] = await database()
        .select()
        .from(shiftAssignments)
        .where(eq(shiftAssignments.id, result.id));

      expect(row).toMatchObject({
        assignmentSource: "MANUAL",
        status: "ACTIVE",
        employeeId,
        assignedByUserId: scenario.owner.userId,
      });
    });

    it("rejects the wrong position", async () => {
      const { period, shift } = await draftWithShift({
        positionId: scenario.bartender,
      });
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await expect(
        assign(shift.id, employeeId, period.id),
      ).rejects.toMatchObject({ code: "POSITION_NOT_HELD" });
    });

    it("rejects an employee who isn't at the shift's location", async () => {
      const period = await createDraftPeriod(database(), scenario.ownerAtB);
      const shift = await createShiftFixture(
        database(),
        scenario.ownerAtB,
        period,
        scenario,
      );
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await expect(
        assignEmployee(database(), scenario.ownerAtB, shift.id, {
          employeeId,
          notes: null,
          expectedPeriodVersion: await periodVersion(period.id),
        }),
      ).rejects.toMatchObject({ code: "LOCATION_NOT_ELIGIBLE" });
    });

    it("rejects an employee from another organization as if absent", async () => {
      const other = await createSchedulingScenario(database());
      const stranger = await createSchedulableEmployee(database(), other);
      const { period, shift } = await draftWithShift();

      await expect(
        assign(shift.id, stranger, period.id),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects a terminated employee, with the generic code", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const [row] = await database()
        .select({ version: employees.version })
        .from(employees)
        .where(eq(employees.id, employeeId));

      await terminateEmployee(database(), scenario.owner, {
        employeeId,
        terminationDate: "2026-01-02",
        reason: null,
        expectedVersion: row!.version,
      });

      await expect(
        assign(shift.id, employeeId, period.id),
      ).rejects.toMatchObject({ code: "EMPLOYEE_NOT_SCHEDULABLE" });
    });

    it("rejects an employee on leave", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const [row] = await database()
        .select({ version: employees.version })
        .from(employees)
        .where(eq(employees.id, employeeId));

      await changeEmployeeStatus(database(), scenario.owner, {
        employeeId,
        status: "ON_LEAVE",
        reason: null,
        expectedVersion: row!.version,
      });

      await expect(
        assign(shift.id, employeeId, period.id),
      ).rejects.toMatchObject({ code: "EMPLOYEE_NOT_SCHEDULABLE" });
    });

    it("rejects an overlap in another period, even across dates", async () => {
      const period = await createDraftPeriod(database(), scenario.owner);
      const first = await createShiftFixture(
        database(),
        scenario.owner,
        period,
        scenario,
        { shiftDate: MONDAY, startTime: "20:00", endTime: "02:00" },
      );
      const otherPeriod = await createDraftPeriod(database(), scenario.owner, {
        name: "Another draft",
      });
      const second = await createShiftFixture(
        database(),
        scenario.owner,
        otherPeriod,
        scenario,
        { shiftDate: TUESDAY, startTime: "01:00", endTime: "04:00" },
      );
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await assign(first.id, employeeId, period.id);

      await expect(
        assign(second.id, employeeId, otherPeriod.id),
      ).rejects.toMatchObject({ code: "SHIFT_OVERLAP" });
    });

    it("rejects an employee with no availability, with no way to override", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario, {
        available: false,
      });

      await expect(
        assign(shift.id, employeeId, period.id),
      ).rejects.toMatchObject({ code: "AVAILABILITY_NOT_CONFIGURED" });
    });

    it("rejects a second assignee on a full shift, and the same person twice", async () => {
      const { period, shift } = await draftWithShift();
      const first = await createSchedulableEmployee(database(), scenario);
      const second = await createSchedulableEmployee(database(), scenario);

      await assign(shift.id, first, period.id);

      await expect(assign(shift.id, second, period.id)).rejects.toMatchObject({
        code: "SHIFT_FULL",
      });
      await expect(assign(shift.id, first, period.id)).rejects.toMatchObject({
        code: "ALREADY_ASSIGNED",
      });
    });

    it("rejects past a hard limit, and only warns past a soft one", async () => {
      const period = await createDraftPeriod(database(), scenario.owner);
      const first = await createShiftFixture(
        database(),
        scenario.owner,
        period,
        scenario,
        { shiftDate: MONDAY },
      );
      const second = await createShiftFixture(
        database(),
        scenario.owner,
        { id: period.id, version: await periodVersion(period.id) },
        scenario,
        { shiftDate: TUESDAY },
      );
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await assign(first.id, employeeId, period.id);
      await setRules(database(), scenario.locationA, {
        maximumDaysPerWeek: 1,
        maximumDaysHard: false,
      });

      const warned = await assign(second.id, employeeId, period.id);

      expect(warned.warnings.map((warning) => warning.code)).toEqual([
        "WEEKLY_DAYS_PREFERENCE",
      ]);

      await removeAssignment(database(), scenario.owner, warned.id, {
        expectedPeriodVersion: await periodVersion(period.id),
      });
      await setRules(database(), scenario.locationA, {
        maximumDaysPerWeek: 1,
        maximumDaysHard: true,
      });

      await expect(
        assign(second.id, employeeId, period.id),
      ).rejects.toMatchObject({ code: "HARD_WEEKLY_DAYS" });
    });

    it("keeps a removed assignment as history, and lets the person be reassigned", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const { id } = await assign(shift.id, employeeId, period.id);

      await removeAssignment(database(), scenario.owner, id, {
        expectedPeriodVersion: await periodVersion(period.id),
      });

      const [removed] = await database()
        .select()
        .from(shiftAssignments)
        .where(eq(shiftAssignments.id, id));

      expect(removed).toMatchObject({
        status: "REMOVED",
        endedByUserId: scenario.owner.userId,
      });
      await expect(assign(shift.id, employeeId, period.id)).resolves.toBeDefined();
    });

    it("rejects a stale period version, however the schedule changed", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const stale = await periodVersion(period.id);

      await createShiftFixture(database(), scenario.owner, { id: period.id, version: stale }, scenario, {
        shiftDate: TUESDAY,
      });

      await expect(
        assignEmployee(database(), scenario.owner, shift.id, {
          employeeId,
          notes: null,
          expectedPeriodVersion: stale,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });
  });

  describe("security role versus position", () => {
    it("a security role can't make someone eligible for a position", async () => {
      const { period, shift } = await draftWithShift({
        positionId: scenario.bartender,
      });
      const { employeeId } = await createLinkedEmployee(
        database(),
        scenario,
        ["kitchen.manage", "orders.submit", "schedule.view"],
      );

      // The linked login holds bartender-like permissions; the employee holds only Server.
      await expect(
        assign(shift.id, employeeId, period.id),
      ).rejects.toMatchObject({ code: "POSITION_NOT_HELD" });
    });

    it("a position qualifies someone whose login holds no related role", async () => {
      const { period, shift } = await draftWithShift({
        positionId: scenario.bartender,
      });
      const { actor, employeeId } = await createLinkedEmployee(
        database(),
        scenario,
        ["menu.view"],
      );

      await addPosition(database(), scenario, employeeId, scenario.bartender);

      await expect(
        assign(shift.id, employeeId, period.id),
      ).resolves.toBeDefined();
      expect(
        await database()
          .select({ roleId: userRoles.roleId })
          .from(userRoles)
          .where(eq(userRoles.userId, actor.userId)),
      ).toHaveLength(1);
    });
  });

  describe("candidates", () => {
    it("reports the same verdict the assignment path enforces", async () => {
      const { shift } = await draftWithShift();
      const eligible = await createSchedulableEmployee(database(), scenario);
      const unset = await createSchedulableEmployee(database(), scenario, {
        available: false,
      });
      const candidates = await listCandidates(database(), scenario.owner, shift.id);
      const byId = new Map(candidates.map((row) => [row.employeeId, row]));

      expect(byId.get(eligible)).toMatchObject({ eligible: true, violations: [] });
      expect(byId.get(unset)).toMatchObject({
        eligible: false,
        violations: ["AVAILABILITY_NOT_CONFIGURED"],
      });
    });
  });

  describe("coverage", () => {
    it("reflects manual assignments, by day and position", async () => {
      const { period, shift } = await draftWithShift({
        requiredEmployeeCount: 2,
      });
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await assign(shift.id, employeeId, period.id);

      const coverage = await getPeriodCoverage(
        database(),
        scenario.owner,
        period.id,
      );

      expect(coverage).toMatchObject({ required: 2, filled: 1, open: 1 });
      expect(coverage.byDay[0]).toMatchObject({ label: MONDAY, open: 1 });
      expect(coverage.openShiftIds).toEqual([shift.id]);
      expect(coverage.hardViolations).toEqual([]);
    });
  });

  describe("publishing", () => {
    it("publishes a valid draft, recording who and when", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await assign(shift.id, employeeId, period.id);

      const published = await publishPeriod(database(), scenario.owner, period.id, {
        expectedVersion: await periodVersion(period.id),
      });

      expect(published.status).toBe("PUBLISHED");
      expect(published.publishedByUserId).toBe(scenario.owner.userId);
      expect(published.publishedAt).toBeInstanceOf(Date);
    });

    it("rejects publishing without permission", async () => {
      const period = await createDraftPeriod(database(), scenario.owner);
      const editor = await actorWith(database(), scenario, [
        "schedule.view",
        "schedule.edit",
      ]);

      await expect(
        publishPeriod(database(), editor, period.id, {
          expectedVersion: period.version,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("rejects a stale version", async () => {
      const { period } = await draftWithShift();

      await expect(
        publishPeriod(database(), scenario.owner, period.id, {
          expectedVersion: period.version,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("rejects a schedule with a hard violation, naming it, and stays a draft", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await assign(shift.id, employeeId, period.id);

      const [row] = await database()
        .select({ version: employees.version })
        .from(employees)
        .where(eq(employees.id, employeeId));

      await changeEmployeeStatus(database(), scenario.owner, {
        employeeId,
        status: "SUSPENDED",
        reason: null,
        expectedVersion: row!.version,
      });

      const error = await publishPeriod(database(), scenario.owner, period.id, {
        expectedVersion: await periodVersion(period.id),
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BusinessRuleError);
      expect(error).toMatchObject({ code: "SCHEDULE_HAS_VIOLATIONS" });
      expect((error as Error).message).not.toMatch(/suspended/i);

      const [unchanged] = await database()
        .select({ status: schedulePeriods.status })
        .from(schedulePeriods)
        .where(eq(schedulePeriods.id, period.id));

      expect(unchanged?.status).toBe("DRAFT");
    });

    it("rejects overlapping published periods, using the database constraint", async () => {
      const first = await createDraftPeriod(database(), scenario.owner);
      const second = await createDraftPeriod(database(), scenario.owner, {
        name: "Overlapping",
        startDate: "2030-01-10",
        endDate: "2030-01-20",
      });

      await publishPeriod(database(), scenario.owner, first.id, {
        expectedVersion: first.version,
      });

      await expect(
        publishPeriod(database(), scenario.owner, second.id, {
          expectedVersion: second.version,
        }),
      ).rejects.toMatchObject({ code: "PUBLISHED_PERIOD_OVERLAP" });
    });

    it("allows the same dates again once the earlier period is archived", async () => {
      const first = await createDraftPeriod(database(), scenario.owner);
      const published = await publishPeriod(
        database(),
        scenario.owner,
        first.id,
        { expectedVersion: first.version },
      );
      const archived = await archivePeriod(
        database(),
        scenario.owner,
        first.id,
        { expectedVersion: published.version },
      );
      const second = await createDraftPeriod(database(), scenario.owner, {
        name: "Replacement",
      });

      expect(archived.status).toBe("ARCHIVED");
      await expect(
        publishPeriod(database(), scenario.owner, second.id, {
          expectedVersion: second.version,
        }),
      ).resolves.toMatchObject({ status: "PUBLISHED" });
    });

    it("treats a published schedule as closed to direct edits", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const { id: assignmentId } = await assign(shift.id, employeeId, period.id);
      const published = await publishPeriod(database(), scenario.owner, period.id, {
        expectedVersion: await periodVersion(period.id),
      });
      const other = await createSchedulableEmployee(database(), scenario);
      const closed = { code: "SCHEDULE_NOT_DRAFT" };

      await expect(
        removeAssignment(database(), scenario.owner, assignmentId, {
          expectedPeriodVersion: published.version,
        }),
      ).rejects.toMatchObject(closed);
      await expect(
        assignEmployee(database(), scenario.owner, shift.id, {
          employeeId: other,
          notes: null,
          expectedPeriodVersion: published.version,
        }),
      ).rejects.toMatchObject(closed);
      await expect(
        createShiftFixture(
          database(),
          scenario.owner,
          { id: period.id, version: published.version },
          scenario,
        ),
      ).rejects.toMatchObject(closed);
      await expect(
        updatePeriod(database(), scenario.owner, period.id, {
          name: "Renamed",
          startDate: period.startDate,
          endDate: period.endDate,
          expectedVersion: published.version,
        }),
      ).rejects.toMatchObject(closed);
    });

    it("can't archive a draft", async () => {
      const period = await createDraftPeriod(database(), scenario.owner);

      await expect(
        archivePeriod(database(), scenario.owner, period.id, {
          expectedVersion: period.version,
        }),
      ).rejects.toMatchObject({ code: "SCHEDULE_NOT_PUBLISHED" });
    });
  });

  describe("employees who become ineligible after being scheduled", () => {
    it("keeps the assignment, flags it in coverage, and termination isn't blocked", async () => {
      const { period, shift } = await draftWithShift();
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const { id } = await assign(shift.id, employeeId, period.id);
      const published = await publishPeriod(database(), scenario.owner, period.id, {
        expectedVersion: await periodVersion(period.id),
      });
      const [row] = await database()
        .select({ version: employees.version })
        .from(employees)
        .where(eq(employees.id, employeeId));

      await terminateEmployee(database(), scenario.owner, {
        employeeId,
        terminationDate: "2026-01-02",
        reason: null,
        expectedVersion: row!.version,
      });

      const [kept] = await database()
        .select({ status: shiftAssignments.status })
        .from(shiftAssignments)
        .where(eq(shiftAssignments.id, id));
      const coverage = await getPeriodCoverage(
        database(),
        scenario.owner,
        published.id,
      );

      expect(kept?.status).toBe("ACTIVE");
      expect(coverage.hardViolations).toHaveLength(1);
      expect(coverage.hardViolations[0]?.violations).toContain(
        "EMPLOYEE_NOT_SCHEDULABLE",
      );
    });
  });

  describe("visibility", () => {
    it("hides drafts from someone who can only view schedules", async () => {
      const draft = await createDraftPeriod(database(), scenario.owner);
      const published = await createDraftPeriod(database(), scenario.owner, {
        name: "Published",
        startDate: "2030-03-04",
        endDate: "2030-03-10",
      });

      await publishPeriod(database(), scenario.owner, published.id, {
        expectedVersion: published.version,
      });

      const viewer = await actorWith(database(), scenario, ["schedule.view"]);

      expect(
        (await listPeriods(database(), viewer)).map((row) => row.id),
      ).toEqual([published.id]);
      await expect(
        getPeriodDetail(database(), viewer, draft.id),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        getPeriodDetail(database(), viewer, published.id),
      ).resolves.toBeDefined();
    });

    it("gives a viewer no coverage, candidates or edit access", async () => {
      const { period, shift } = await draftWithShift();
      const viewer = await actorWith(database(), scenario, ["schedule.view"]);

      await expect(
        getPeriodCoverage(database(), viewer, period.id),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        listCandidates(database(), viewer, shift.id),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        createPeriod(database(), viewer, {
          name: "No",
          startDate: MONDAY,
          endDate: MONDAY,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("refuses someone with no scheduling permission at all", async () => {
      const outsider = await actorWith(database(), scenario, ["menu.view"]);

      await expect(listPeriods(database(), outsider)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("permission at one location doesn't carry to another", async () => {
      const period = await createDraftPeriod(database(), scenario.ownerAtB);
      const actorHere = await actorAt(
        database(),
        scenario.ownerUser.id,
        scenario.locationA,
      );

      await expect(
        getPeriodDetail(database(), actorHere, period.id),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
