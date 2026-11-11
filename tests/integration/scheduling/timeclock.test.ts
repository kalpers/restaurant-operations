import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, employees, timeEntries, timeEntryAdjustments, timeEntryBreaks } from "@/db/schema";
import { findWorkedEntries } from "@/modules/scheduling/queries/worked-time";
import {
  adjustEntry,
  clockIn,
  clockOut,
  getMyTime,
  getTimeClockBoard,
  recordBreak,
  voidEntry,
} from "@/modules/scheduling/services/timeclock-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { terminateEmployee } from "@/workflows/terminate-employee/terminate-employee";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  addPosition,
  createLinkedEmployee,
  createSchedulableEmployee,
  createSchedulingScenario,
  type SchedulingScenario,
} from "../../fixtures/scheduling-fixtures";
import { key, publishShiftNearNow } from "../../fixtures/timeclock-fixtures";

const database = () => getDatabase();
const PUNCH = ["timeclock.punch"] as const;
const HOUR = 3_600_000;

async function entryRow(id: string) {
  const [row] = await database().select().from(timeEntries).where(eq(timeEntries.id, id));

  return row!;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("time clock", () => {
  let scenario: SchedulingScenario;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  describe("clocking in", () => {
    it("links the matching published shift, and a retry returns the first entry", async () => {
      const { actor, employeeId } = await createLinkedEmployee(database(), scenario, PUNCH);
      const shift = await publishShiftNearNow(database(), scenario.owner, {
        employeeId,
        positionId: scenario.server,
        offsetMinutes: -10,
      });
      const idempotencyKey = key();
      const first = await clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey });
      const retry = await clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey });

      expect(first.shiftAssignmentId).toBe(shift.assignmentId);
      expect(first.warnings.unscheduled).toBe(false);
      expect(retry.entryId).toBe(first.entryId);

      const rows = await database().select().from(timeEntries).where(eq(timeEntries.employeeId, employeeId));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "OPEN", clockInSource: "SELF", positionId: scenario.server });
      expect(rows[0]!.clockInAt.getTime()).toBe(rows[0]!.clockInRecordedAt.getTime());
    });

    it("allows an unscheduled clock-in and flags it", async () => {
      const { actor } = await createLinkedEmployee(database(), scenario, PUNCH);
      const result = await clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey: key() });

      expect(result.shiftAssignmentId).toBeNull();
      expect(result.warnings).toEqual({ unscheduled: true, overtime: "NONE" });
    });

    it("refuses a second clock-in while on the clock", async () => {
      const { actor } = await createLinkedEmployee(database(), scenario, PUNCH);

      await clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey: key() });
      await expectCode(
        clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey: key() }),
        "ALREADY_CLOCKED_IN",
      );
    });

    it("refuses a login with no employee, a position not held, and an ambiguous position", async () => {
      const unlinked = await actorWith(database(), scenario, PUNCH);

      await expectCode(
        clockIn(database(), unlinked, { employeeId: null, positionId: null, idempotencyKey: key() }),
        "NO_LINKED_EMPLOYEE",
      );

      const { actor, employeeId } = await createLinkedEmployee(database(), scenario, PUNCH);

      await expectCode(
        clockIn(database(), actor, { employeeId: null, positionId: scenario.bartender, idempotencyKey: key() }),
        "TIMECLOCK_NOT_ELIGIBLE",
      );

      await addPosition(database(), scenario, employeeId, scenario.bartender);
      await expectCode(
        clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey: key() }),
        "POSITION_REQUIRED",
      );

      const chosen = await clockIn(database(), actor, {
        employeeId: null,
        positionId: scenario.bartender,
        idempotencyKey: key(),
      });

      expect(chosen.positionId).toBe(scenario.bartender);
    });

    it("refuses an employee who isn't active", async () => {
      const { actor, employeeId } = await createLinkedEmployee(database(), scenario, PUNCH);

      await database().update(employees).set({ employmentStatus: "SUSPENDED" }).where(eq(employees.id, employeeId));
      await expectCode(
        clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey: key() }),
        "TIMECLOCK_NOT_ELIGIBLE",
      );
    });
  });

  describe("breaks and clocking out", () => {
    it("records a break, and clocking out ends an open one", async () => {
      const { actor } = await createLinkedEmployee(database(), scenario, PUNCH);
      const { entryId } = await clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey: key() });

      await recordBreak(database(), actor, { action: "START", paid: false, idempotencyKey: key() });
      await expectCode(
        recordBreak(database(), actor, { action: "START", paid: false, idempotencyKey: key() }),
        "ALREADY_ON_BREAK",
      );

      await new Promise((resolve) => setTimeout(resolve, 20));

      const out = await clockOut(database(), actor, { entryId: null, expectedVersion: null, idempotencyKey: key() });
      const [span] = await database().select().from(timeEntryBreaks).where(eq(timeEntryBreaks.timeEntryId, entryId));
      const row = await entryRow(entryId);

      expect(row).toMatchObject({ status: "CLOSED", clockOutSource: "SELF" });
      expect(span!.endedAt!.getTime()).toBe(row.clockOutAt!.getTime());
      expect(out.workedSeconds).toBe(0);
      await expectCode(
        clockOut(database(), actor, { entryId: null, expectedVersion: null, idempotencyKey: key() }),
        "NOT_CLOCKED_IN",
      );
    });
  });

  describe("manager punches", () => {
    it("clocks in and out an employee with no login, and audits both", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const result = await clockIn(database(), scenario.owner, {
        employeeId,
        positionId: null,
        idempotencyKey: key(),
      });

      await new Promise((resolve) => setTimeout(resolve, 5));
      await clockOut(database(), scenario.owner, {
        entryId: result.entryId,
        expectedVersion: 1,
        idempotencyKey: key(),
      });

      const audit = await database()
        .select({ action: auditEvents.action, details: auditEvents.details })
        .from(auditEvents)
        .where(eq(auditEvents.entityId, result.entryId));

      expect(audit.map((row) => row.action).sort()).toEqual([
        "timeclock.manager-clock-in",
        "timeclock.manager-clock-out",
      ]);
      expect((await entryRow(result.entryId)).clockInSource).toBe("MANAGER");
    });

    it("needs timeclock.manage, and the board needs timeclock.view", async () => {
      const { actor } = await createLinkedEmployee(database(), scenario, PUNCH);
      const other = await createSchedulableEmployee(database(), scenario);

      await expect(
        clockIn(database(), actor, { employeeId: other, positionId: null, idempotencyKey: key() }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(getTimeClockBoard(database(), actor, {})).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("adjustments", () => {
    it("keeps the recorded punch instants and writes the before and after values", async () => {
      const { actor, employeeId } = await createLinkedEmployee(database(), scenario, PUNCH);
      const { entryId } = await clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey: key() });
      const before = await entryRow(entryId);
      const clockInAt = new Date(before.clockInAt.getTime() - 2 * HOUR);
      const clockOutAt = new Date(before.clockInAt.getTime() - HOUR);

      await adjustEntry(database(), scenario.owner, entryId, {
        expectedVersion: before.version,
        reason: "Forgot to clock in and out",
        clockInAt,
        clockOutAt,
      });

      const after = await entryRow(entryId);
      const [adjustment] = await database()
        .select()
        .from(timeEntryAdjustments)
        .where(eq(timeEntryAdjustments.timeEntryId, entryId));

      expect(after).toMatchObject({ status: "CLOSED", clockOutSource: "ADJUSTMENT", clockOutRecordedAt: null });
      expect(after.clockInRecordedAt.getTime()).toBe(before.clockInRecordedAt.getTime());
      expect(after.clockInAt.getTime()).toBe(clockInAt.getTime());
      expect(adjustment!.changes).toMatchObject({
        clockInAt: { before: before.clockInAt.toISOString(), after: clockInAt.toISOString() },
        clockOutAt: { before: null, after: clockOutAt.toISOString() },
      });

      const [entry] = await findWorkedEntries(database(), {
        locationId: actor.locationId,
        from: after.businessDate,
        to: after.businessDate,
        employeeIds: [employeeId],
      });

      expect(entry).toMatchObject({ workedSeconds: 3600, adjusted: true });
    });

    it("moves the business date when the clock-in crosses the cutoff", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const { entryId } = await clockIn(database(), scenario.owner, {
        employeeId,
        positionId: null,
        idempotencyKey: key(),
      });
      // 03:30 local on 2026-01-15 (EST, UTC-5) is before the 04:00 cutoff: business date the 14th.
      const early = new Date("2026-01-15T08:30:00Z");

      await adjustEntry(database(), scenario.owner, entryId, {
        expectedVersion: 1,
        reason: "Wrong day",
        clockInAt: early,
        clockOutAt: new Date("2026-01-15T09:30:00Z"),
      });

      expect((await entryRow(entryId)).businessDate).toBe("2026-01-14");
    });

    it("refuses an overlap, a stale version, a future time and a missing reason", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const first = await clockIn(database(), scenario.owner, { employeeId, positionId: null, idempotencyKey: key() });
      const firstRow = await entryRow(first.entryId);

      await expect(
        adjustEntry(database(), scenario.owner, first.entryId, {
          expectedVersion: 2,
          reason: "Stale",
          clockInAt: new Date(firstRow.clockInAt.getTime() - 4 * HOUR),
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      await adjustEntry(database(), scenario.owner, first.entryId, {
        expectedVersion: 1,
        reason: "Earlier shift",
        clockInAt: new Date(firstRow.clockInAt.getTime() - 4 * HOUR),
        clockOutAt: new Date(firstRow.clockInAt.getTime() - 3 * HOUR),
      });

      const second = await clockIn(database(), scenario.owner, { employeeId, positionId: null, idempotencyKey: key() });

      await expect(
        adjustEntry(database(), scenario.owner, second.entryId, {
          expectedVersion: 1,
          reason: "Overlap",
          clockInAt: new Date(firstRow.clockInAt.getTime() - 3.5 * HOUR),
        }),
      ).rejects.toMatchObject({ code: "TIME_ENTRY_OVERLAP" });
      await expectCode(
        adjustEntry(database(), scenario.owner, second.entryId, {
          expectedVersion: 1,
          reason: "Future",
          clockOutAt: new Date(Date.now() + HOUR),
        }),
        "TIME_IN_FUTURE",
      );
      await expect(
        adjustEntry(database(), scenario.owner, second.entryId, { expectedVersion: 1, reason: "   " }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("needs timeclock.manage", async () => {
      const { actor } = await createLinkedEmployee(database(), scenario, PUNCH);
      const { entryId } = await clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey: key() });

      await expect(
        adjustEntry(database(), actor, entryId, { expectedVersion: 1, reason: "Mine", clockInAt: new Date(Date.now() - HOUR) }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("void", () => {
    it("keeps the row as VOIDED and excludes it everywhere", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const { entryId, businessDate } = await clockIn(database(), scenario.owner, {
        employeeId,
        positionId: null,
        idempotencyKey: key(),
      });

      await voidEntry(database(), scenario.owner, entryId, { expectedVersion: 1, reason: "Wrong person" });

      expect((await entryRow(entryId)).status).toBe("VOIDED");
      expect(
        await findWorkedEntries(database(), {
          locationId: scenario.owner.locationId,
          from: businessDate,
          to: businessDate,
          employeeIds: [employeeId],
        }),
      ).toEqual([]);
      await expectCode(
        adjustEntry(database(), scenario.owner, entryId, { expectedVersion: 2, reason: "Again", clockInAt: new Date() }),
        "TIME_ENTRY_VOIDED",
      );

      // The employee can clock in again: a voided entry isn't OPEN and doesn't overlap.
      await clockIn(database(), scenario.owner, { employeeId, positionId: null, idempotencyKey: key() });
    });
  });

  describe("database guards", () => {
    it("refuses changes to recorded instants, deletes, and reopening", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const { entryId } = await clockIn(database(), scenario.owner, { employeeId, positionId: null, idempotencyKey: key() });

      await expect(
        database()
          .update(timeEntries)
          .set({ clockInRecordedAt: new Date(Date.now() - HOUR) })
          .where(eq(timeEntries.id, entryId)),
      ).rejects.toThrow();
      await expect(database().delete(timeEntries).where(eq(timeEntries.id, entryId))).rejects.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 5));
      await clockOut(database(), scenario.owner, { entryId, expectedVersion: 1, idempotencyKey: key() });
      await expect(
        database()
          .update(timeEntries)
          .set({ status: "OPEN", clockOutAt: null, clockOutRecordedAt: null, clockOutSource: null, clockOutByUserId: null })
          .where(eq(timeEntries.id, entryId)),
      ).rejects.toThrow();
    });

    it("refuses a break outside its entry at commit", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const { entryId } = await clockIn(database(), scenario.owner, { employeeId, positionId: null, idempotencyKey: key() });

      await expect(
        database()
          .insert(timeEntryBreaks)
          .values({
            timeEntryId: entryId,
            startedAt: new Date(Date.now() - 5 * HOUR),
            endedAt: new Date(Date.now() - 4 * HOUR),
            paid: false,
            recordedByUserId: scenario.owner.userId,
          }),
      ).rejects.toThrow();
    });
  });

  describe("termination and views", () => {
    it("refuses to terminate an employee on the clock", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const [row] = await database().select({ version: employees.version }).from(employees).where(eq(employees.id, employeeId));

      await clockIn(database(), scenario.owner, { employeeId, positionId: null, idempotencyKey: key() });
      await expectCode(
        terminateEmployee(database(), scenario.owner, {
          employeeId,
          terminationDate: "2026-01-01",
          reason: null,
          expectedVersion: row!.version,
        }),
        "EMPLOYEE_ON_CLOCK",
      );
    });

    it("shows a linked employee their own open entry and week", async () => {
      const { actor } = await createLinkedEmployee(database(), scenario, PUNCH);
      const { entryId } = await clockIn(database(), actor, { employeeId: null, positionId: null, idempotencyKey: key() });
      const mine = await getMyTime(database(), actor);

      expect(mine).toMatchObject({ linked: true, openEntry: { id: entryId, status: "OPEN" } });
      expect(mine.linked && mine.week.state).toBe("NONE");
    });

    it("lists who is on the clock and missed clock-outs on the board", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const { entryId } = await clockIn(database(), scenario.owner, { employeeId, positionId: null, idempotencyKey: key() });
      const board = await getTimeClockBoard(database(), scenario.owner, {});

      expect(board.onClock.map((entry) => entry.id)).toContain(entryId);
      expect(board.staff.map((member) => member.id)).toContain(employeeId);

      // An OPEN entry from an earlier business date is a missed clock-out.
      await database().execute(
        sql`UPDATE time_entries SET business_date = business_date - 2 WHERE id = ${entryId}`,
      );

      const later = await getTimeClockBoard(database(), scenario.owner, {});

      expect(later.missedClockOuts.map((entry) => entry.id)).toContain(entryId);
      expect(later.onClock.map((entry) => entry.id)).not.toContain(entryId);
    });
  });
});
