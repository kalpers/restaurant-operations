import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { schedulePeriods, timeOffRequests } from "@/db/schema";
import {
  addAvailabilityException,
  addRecurringAvailability,
  getAvailability,
  removeRecurringAvailability,
  savePreferences,
} from "@/modules/scheduling/services/availability-service";
import {
  assignEmployee,
  listCandidates,
  removeAssignment,
} from "@/modules/scheduling/services/schedule-service";
import {
  approveTimeOff,
  cancelTimeOff,
  denyTimeOff,
  listOwnTimeOff,
  listTimeOffForReview,
  requestOwnTimeOff,
  requestTimeOffForEmployee,
} from "@/modules/scheduling/services/time-off-service";
import {
  AuthorizationError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  createDraftPeriod,
  createLinkedEmployee,
  createSchedulableEmployee,
  createSchedulingScenario,
  createShiftFixture,
  MONDAY,
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

const mondayOff = {
  startDate: MONDAY,
  startTime: null,
  endDate: MONDAY,
  endTime: null,
  requestType: "VACATION" as const,
  reason: "Family wedding",
  employeeNote: null,
};

const SELF_SERVICE = [
  "schedule.view",
  "schedule.time-off.request",
  "schedule.availability.self",
] as const;

describe("availability and time off", () => {
  let scenario: SchedulingScenario;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  async function shiftOnMonday() {
    const period = await createDraftPeriod(database(), scenario.owner);
    const shift = await createShiftFixture(
      database(),
      scenario.owner,
      period,
      scenario,
    );

    return { period, shift };
  }

  describe("availability and preferences", () => {
    const window = {
      dayOfWeek: 1,
      startTime: "16:00",
      endTime: "23:00",
      availabilityType: "AVAILABLE" as const,
      effectiveFrom: "2029-01-01",
      effectiveTo: null,
      thisLocationOnly: false,
    };

    it("self-service acts only on the linked employee", async () => {
      const { actor, employeeId } = await createLinkedEmployee(
        database(),
        scenario,
        SELF_SERVICE,
      );

      await addRecurringAvailability(
        database(),
        actor,
        { kind: "self" },
        window,
      );

      const mine = await getAvailability(database(), actor, { kind: "self" });

      expect(mine.employeeId).toBe(employeeId);
      expect(mine.recurring.some((row) => row.startTime === "16:00:00")).toBe(true);
    });

    it("self-service can't target another employee through the manager path", async () => {
      const { actor } = await createLinkedEmployee(
        database(),
        scenario,
        SELF_SERVICE,
      );
      const other = await createSchedulableEmployee(database(), scenario);

      await expect(
        addRecurringAvailability(
          database(),
          actor,
          { kind: "employee", employeeId: other },
          window,
        ),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("a login with no employee record gets a clear refusal", async () => {
      const actor = await actorWith(database(), scenario, [...SELF_SERVICE]);

      await expect(
        getAvailability(database(), actor, { kind: "self" }),
      ).rejects.toMatchObject({ code: "NO_LINKED_EMPLOYEE" });
    });

    it("a manager can't reach an employee from another location", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await expect(
        addRecurringAvailability(
          database(),
          scenario.ownerAtB,
          { kind: "employee", employeeId },
          window,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("changing availability changes the shared evaluator's verdict", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario, {
        available: false,
      });
      const { shift } = await shiftOnMonday();
      const verdict = async () =>
        (await listCandidates(database(), scenario.owner, shift.id)).find(
          (row) => row.employeeId === employeeId,
        )?.violations;
      const target = { kind: "employee" as const, employeeId };

      expect(await verdict()).toEqual(["AVAILABILITY_NOT_CONFIGURED"]);

      const record = await addRecurringAvailability(
        database(),
        scenario.owner,
        target,
        window,
      );

      expect(await verdict()).toEqual([]);

      await addAvailabilityException(database(), scenario.owner, target, {
        exceptionDate: MONDAY,
        startTime: null,
        endTime: null,
        availabilityType: "UNAVAILABLE",
        reason: null,
        thisLocationOnly: false,
      });

      expect(await verdict()).toEqual(["AVAILABILITY_UNAVAILABLE"]);

      const current = await getAvailability(
        database(),
        scenario.owner,
        target,
      );

      await removeRecurringAvailability(
        database(),
        scenario.owner,
        target,
        record.id,
        { expectedVersion: current.recurring[0]!.version },
      );

      expect(
        (await getAvailability(database(), scenario.owner, target)).recurring,
      ).toEqual([]);
    });

    it("keeps preferences separate: they never make anyone ineligible", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const { shift } = await shiftOnMonday();

      await savePreferences(
        database(),
        scenario.owner,
        { kind: "employee", employeeId },
        {
          targetHoursPerWeek: "0.25",
          minimumHoursPerWeek: null,
          maximumHoursPerWeek: "0.50",
          maximumDaysPerWeek: 1,
          maximumConsecutiveDays: 1,
          preferredShiftStart: "06:00",
          preferredShiftEnd: "07:00",
          preferWeekends: true,
          preferOpening: true,
          preferClosing: false,
          expectedVersion: null,
        },
      );

      const candidate = (
        await listCandidates(database(), scenario.owner, shift.id)
      ).find((row) => row.employeeId === employeeId);

      expect(candidate?.eligible).toBe(true);
    });

    it("protects preferences with a version, and keeps hours exact", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const target = { kind: "employee" as const, employeeId };
      const values = {
        targetHoursPerWeek: "37.50",
        minimumHoursPerWeek: null,
        maximumHoursPerWeek: null,
        maximumDaysPerWeek: null,
        maximumConsecutiveDays: null,
        preferredShiftStart: null,
        preferredShiftEnd: null,
        preferWeekends: null,
        preferOpening: null,
        preferClosing: null,
      };

      await savePreferences(database(), scenario.owner, target, {
        ...values,
        expectedVersion: null,
      });

      await expect(
        savePreferences(database(), scenario.owner, target, {
          ...values,
          expectedVersion: null,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
      await expect(
        savePreferences(database(), scenario.owner, target, {
          ...values,
          targetHoursPerWeek: "37.505",
          expectedVersion: 1,
        }),
      ).rejects.toThrow("two decimal places");

      const { preferences } = await getAvailability(
        database(),
        scenario.owner,
        target,
      );

      expect(preferences?.targetHoursPerWeek).toBe("37.50");
    });
  });

  describe("requesting time off", () => {
    it("an employee requests their own, identified by the login", async () => {
      const { actor, employeeId } = await createLinkedEmployee(
        database(),
        scenario,
        SELF_SERVICE,
      );
      const { id } = await requestOwnTimeOff(database(), actor, mondayOff);
      const [row] = await database()
        .select()
        .from(timeOffRequests)
        .where(eq(timeOffRequests.id, id));

      expect(row).toMatchObject({
        employeeId,
        status: "PENDING",
        requestedByUserId: actor.userId,
      });
      expect((await listOwnTimeOff(database(), actor)).map((r) => r.id)).toEqual([id]);
    });

    it("a whole day runs from local midnight to the next local midnight", async () => {
      const { actor } = await createLinkedEmployee(
        database(),
        scenario,
        SELF_SERVICE,
      );
      const { id } = await requestOwnTimeOff(database(), actor, mondayOff);
      const [row] = await database()
        .select()
        .from(timeOffRequests)
        .where(eq(timeOffRequests.id, id));

      expect(row?.startAt.toISOString()).toBe("2030-01-07T05:00:00.000Z");
      expect(row?.endAt.toISOString()).toBe("2030-01-08T05:00:00.000Z");
    });

    it("the self-service path can't name anyone else", async () => {
      const { actor } = await createLinkedEmployee(
        database(),
        scenario,
        SELF_SERVICE,
      );
      const other = await createSchedulableEmployee(database(), scenario);

      await expect(
        requestTimeOffForEmployee(database(), actor, other, mondayOff),
      ).rejects.toBeInstanceOf(AuthorizationError);

      // Extra properties are never read: the employee is still the linked one.
      const { id } = await requestOwnTimeOff(database(), actor, {
        ...mondayOff,
        employeeId: other,
      } as typeof mondayOff);
      const [row] = await database()
        .select({ employeeId: timeOffRequests.employeeId })
        .from(timeOffRequests)
        .where(eq(timeOffRequests.id, id));

      expect(row?.employeeId).not.toBe(other);
    });

    it("needs the permission", async () => {
      const { actor } = await createLinkedEmployee(database(), scenario, [
        "schedule.view",
      ]);

      await expect(
        requestOwnTimeOff(database(), actor, mondayOff),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("a manager can request for someone with no login", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await expect(
        requestTimeOffForEmployee(
          database(),
          scenario.owner,
          employeeId,
          mondayOff,
        ),
      ).resolves.toMatchObject({ status: "PENDING" });
    });

    it("rejects an end before the start", async () => {
      const { actor } = await createLinkedEmployee(
        database(),
        scenario,
        SELF_SERVICE,
      );

      await expect(
        requestOwnTimeOff(database(), actor, {
          ...mondayOff,
          startTime: "12:00",
          endTime: "09:00",
        }),
      ).rejects.toThrow("after its start");
    });
  });

  describe("review", () => {
    async function pendingFor(employeeId: string) {
      const { id } = await requestTimeOffForEmployee(
        database(),
        scenario.owner,
        employeeId,
        mondayOff,
      );

      return id;
    }

    it("approves a request with no conflict, recording the reviewer", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const id = await pendingFor(employeeId);

      await approveTimeOff(database(), scenario.owner, id, {
        managerNote: "Enjoy",
        expectedVersion: 1,
      });

      const [row] = await database()
        .select()
        .from(timeOffRequests)
        .where(eq(timeOffRequests.id, id));

      expect(row).toMatchObject({
        status: "APPROVED",
        managerNote: "Enjoy",
        reviewedByUserId: scenario.owner.userId,
      });
    });

    it("refuses approval while an assignment conflicts, then allows it once resolved", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const { period, shift } = await shiftOnMonday();
      const { id: assignmentId } = await assignEmployee(
        database(),
        scenario.owner,
        shift.id,
        {
          employeeId,
          notes: null,
          expectedPeriodVersion: await periodVersion(period.id),
        },
      );
      const id = await pendingFor(employeeId);

      await expect(
        approveTimeOff(database(), scenario.owner, id, {
          managerNote: null,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "TIME_OFF_ASSIGNMENT_CONFLICT" });

      const [queued] = (
        await listTimeOffForReview(database(), scenario.owner)
      ).filter((row) => row.id === id);

      expect(queued?.conflicts).toHaveLength(1);

      await removeAssignment(database(), scenario.owner, assignmentId, {
        expectedPeriodVersion: await periodVersion(period.id),
      });

      await expect(
        approveTimeOff(database(), scenario.owner, id, {
          managerNote: null,
          expectedVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "APPROVED" });
    });

    it("an approved request blocks a later assignment", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const id = await pendingFor(employeeId);

      await approveTimeOff(database(), scenario.owner, id, {
        managerNote: null,
        expectedVersion: 1,
      });

      const { period, shift } = await shiftOnMonday();

      await expect(
        assignEmployee(database(), scenario.owner, shift.id, {
          employeeId,
          notes: null,
          expectedPeriodVersion: await periodVersion(period.id),
        }),
      ).rejects.toMatchObject({ code: "APPROVED_TIME_OFF" });
    });

    it("pending time off warns but doesn't block", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);

      await pendingFor(employeeId);

      const { period, shift } = await shiftOnMonday();
      const result = await assignEmployee(database(), scenario.owner, shift.id, {
        employeeId,
        notes: null,
        expectedPeriodVersion: await periodVersion(period.id),
      });

      expect(result.warnings.map((warning) => warning.code)).toEqual([
        "PENDING_TIME_OFF",
      ]);
    });

    it("denied and cancelled requests don't block assignment", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const denied = await pendingFor(employeeId);
      const cancelled = await pendingFor(employeeId);

      await denyTimeOff(database(), scenario.owner, denied, {
        managerNote: null,
        expectedVersion: 1,
      });
      await approveTimeOff(database(), scenario.owner, cancelled, {
        managerNote: null,
        expectedVersion: 1,
      });
      await cancelTimeOff(database(), scenario.owner, cancelled, {
        expectedVersion: 2,
      });

      const { period, shift } = await shiftOnMonday();
      const result = await assignEmployee(database(), scenario.owner, shift.id, {
        employeeId,
        notes: null,
        expectedPeriodVersion: await periodVersion(period.id),
      });

      expect(result.warnings).toEqual([]);
    });

    it("only a pending request can be reviewed", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const id = await pendingFor(employeeId);

      await denyTimeOff(database(), scenario.owner, id, {
        managerNote: null,
        expectedVersion: 1,
      });

      await expect(
        approveTimeOff(database(), scenario.owner, id, {
          managerNote: null,
          expectedVersion: 2,
        }),
      ).rejects.toMatchObject({ code: "TIME_OFF_NOT_PENDING" });
    });

    it("rejects a stale version", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const id = await pendingFor(employeeId);

      await expect(
        approveTimeOff(database(), scenario.owner, id, {
          managerNote: null,
          expectedVersion: 9,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("needs the approval permission and the right location", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const id = await pendingFor(employeeId);
      const requesterOnly = await actorWith(database(), scenario, [
        "schedule.time-off.request",
      ]);

      await expect(
        approveTimeOff(database(), requesterOnly, id, {
          managerNote: null,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        approveTimeOff(database(), scenario.ownerAtB, id, {
          managerNote: null,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("another organization can't see or decide a request", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const id = await pendingFor(employeeId);
      const other = await createSchedulingScenario(database());

      await expect(
        denyTimeOff(database(), other.owner, id, {
          managerNote: null,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await listTimeOffForReview(database(), other.owner)).map((r) => r.id),
      ).not.toContain(id);
    });

    it("someone can cancel their own request but not another's", async () => {
      const { actor } = await createLinkedEmployee(
        database(),
        scenario,
        SELF_SERVICE,
      );
      const { id: mine } = await requestOwnTimeOff(database(), actor, mondayOff);
      const other = await createSchedulableEmployee(database(), scenario);
      const theirs = await pendingFor(other);

      await expect(
        cancelTimeOff(database(), actor, theirs, { expectedVersion: 1 }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        cancelTimeOff(database(), actor, mine, { expectedVersion: 1 }),
      ).resolves.toMatchObject({ status: "CANCELLED" });
    });
  });
});
