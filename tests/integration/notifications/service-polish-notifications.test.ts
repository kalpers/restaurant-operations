import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { certificationTypes, employeeCertifications, notifications, outboxEvents, schedulePeriods } from "@/db/schema";
import { listNotifications } from "@/modules/notifications/notification-service";
import { assignEmployee, publishPeriod } from "@/modules/scheduling/services/schedule-service";
import { approveSwap, openSwapForEmployee, recordSwapAcceptance } from "@/modules/scheduling/services/swap-service";
import {
  approveTimeOff,
  denyTimeOff,
  requestTimeOffForEmployee,
} from "@/modules/scheduling/services/time-off-service";
import { addDays, localDateOf } from "@/shared/time/zoned-time";
import { notifyTimeBasedSignals } from "@/workflows/notify-time-based-signals/notify-time-based-signals";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  createDraftPeriod,
  createLinkedEmployee,
  createShiftFixture,
  MONDAY,
  type SchedulingScenario,
  createSchedulingScenario,
} from "../../fixtures/scheduling-fixtures";
import { FIXTURE_TIME_ZONE, insertClosedEntry, insertOpenEntry } from "../../fixtures/timeclock-fixtures";

// Phase 20 policies 11-14: schedule, swap, time-off, certification and time-clock
// notifications, written with the change they report or by the periodic check, once each.

const database = () => getDatabase();
const SELF = ["schedule.view", "schedule.swap.request", "timeclock.punch"] as const;

async function periodVersion(periodId: string): Promise<number> {
  const [row] = await database()
    .select({ version: schedulePeriods.version })
    .from(schedulePeriods)
    .where(eq(schedulePeriods.id, periodId));

  return row!.version;
}

const ofType = (userId: string, type: string) =>
  database()
    .select()
    .from(notifications)
    .where(and(eq(notifications.recipientUserId, userId), eq(notifications.notificationType, type)));

describe("Phase 20 notifications", () => {
  let scenario: SchedulingScenario;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  async function assignAndPublish(employeeId: string) {
    const period = await createDraftPeriod(database(), scenario.owner);
    const shift = await createShiftFixture(database(), scenario.owner, period, scenario);
    const { id } = await assignEmployee(database(), scenario.owner, shift.id, {
      employeeId,
      notes: null,
      expectedPeriodVersion: await periodVersion(period.id),
    });

    await publishPeriod(database(), scenario.owner, period.id, { expectedVersion: await periodVersion(period.id) });

    return { periodId: period.id, assignmentId: id };
  }

  it("tells each scheduled employee with a login that the schedule is published, after commit", async () => {
    const linked = await createLinkedEmployee(database(), scenario, SELF);
    const { periodId } = await assignAndPublish(linked.employeeId);
    const [notice] = await ofType(linked.actor.userId, "SCHEDULE_PUBLISHED");

    expect(notice).toMatchObject({ schedulePeriodId: periodId, locationId: scenario.locationA });
    expect(notice!.body).not.toMatch(/\$|wage|rate/i);

    const [event] = await database()
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.eventType, "notification.created"), eq(outboxEvents.aggregateId, notice!.id)));

    expect(event).toMatchObject({ recipientUserId: linked.actor.userId });

    const listing = await listNotifications(database(), linked.actor);

    expect(listing.notifications[0]!.link).toEqual({ href: "/my-schedule", label: "Open my schedule" });
  });

  it("tells both employees when a swap is approved", async () => {
    const holder = await createLinkedEmployee(database(), scenario, SELF);
    const target = await createLinkedEmployee(database(), scenario, SELF);
    const published = await assignAndPublish(holder.employeeId);
    const swap = await openSwapForEmployee(database(), scenario.owner, {
      assignmentId: published.assignmentId,
      targetEmployeeId: target.employeeId,
      reason: null,
    });

    await recordSwapAcceptance(database(), scenario.owner, swap.id, { expectedVersion: 1 });
    await approveSwap(database(), scenario.owner, swap.id, { expectedVersion: 2 });

    for (const person of [holder, target]) {
      expect(await ofType(person.actor.userId, "SHIFT_CHANGED")).toMatchObject([{ shiftSwapRequestId: swap.id }]);
    }
  });

  it("tells the requester when time off is approved or denied, and not when the change fails", async () => {
    const linked = await createLinkedEmployee(database(), scenario, SELF);
    const request = (date: string) =>
      requestTimeOffForEmployee(database(), scenario.owner, linked.employeeId, {
        startDate: date,
        startTime: null,
        endDate: date,
        endTime: null,
        requestType: "VACATION",
        reason: null,
        employeeNote: null,
      });
    const approved = await request(MONDAY);
    const denied = await request(addDays(MONDAY, 2));

    await approveTimeOff(database(), scenario.owner, approved.id, { managerNote: null, expectedVersion: 1 });
    await denyTimeOff(database(), scenario.owner, denied.id, { managerNote: "Busy week", expectedVersion: 1 });
    await expect(
      denyTimeOff(database(), scenario.owner, denied.id, { managerNote: null, expectedVersion: 1 }),
    ).rejects.toBeDefined();

    expect(await ofType(linked.actor.userId, "TIME_OFF_APPROVED")).toMatchObject([
      { timeOffRequestId: approved.id, body: expect.stringContaining(MONDAY) },
    ]);
    expect(await ofType(linked.actor.userId, "TIME_OFF_DENIED")).toHaveLength(1);
  });

  it("sends expiring-certification, overtime and missed clock-out notices once each", async () => {
    const linked = await createLinkedEmployee(database(), scenario, SELF);
    const manager = await actorWith(database(), scenario, ["hr.certifications.manage", "timeclock.manage", "timeclock.view"]);
    const today = localDateOf(new Date(), FIXTURE_TIME_ZONE);
    const [type] = await database()
      .insert(certificationTypes)
      .values({
        organizationId: scenario.organizationId,
        code: `FOOD-${Date.now()}`,
        name: "Food handler",
        expirationRequired: true,
        warningDays: 30,
      })
      .returning();
    const [soon] = await database()
      .insert(employeeCertifications)
      .values({ employeeId: linked.employeeId, certificationTypeId: type!.id, expirationDate: addDays(today, 10) })
      .returning();

    await database()
      .insert(employeeCertifications)
      .values({ employeeId: linked.employeeId, certificationTypeId: type!.id, expirationDate: addDays(today, 90) });

    // Clocked in two days ago and never out: a missed clock-out.
    const entryId = await insertOpenEntry(database(), scenario.owner, {
      employeeId: linked.employeeId,
      positionId: scenario.server,
      businessDate: addDays(today, -2),
      clockInAt: new Date(Date.now() - 50 * 3600_000),
    });

    await notifyTimeBasedSignals(database(), new Date(), { locationIds: [scenario.locationA] });
    await notifyTimeBasedSignals(database(), new Date(), { locationIds: [scenario.locationA] });

    expect(await ofType(linked.actor.userId, "CERTIFICATION_EXPIRING")).toMatchObject([
      { employeeCertificationId: soon!.id },
    ]);
    expect(await ofType(manager.userId, "CERTIFICATION_EXPIRING")).toHaveLength(1);
    expect(await ofType(manager.userId, "MISSED_CLOCK_OUT")).toMatchObject([{ timeEntryId: entryId }]);
    expect(await ofType(linked.actor.userId, "MISSED_CLOCK_OUT")).toEqual([]);

    const listing = await listNotifications(database(), manager);

    expect(listing.notifications.find((notice) => notice.type === "MISSED_CLOCK_OUT")?.link?.href).toBe(
      "/scheduling/time-clock",
    );
  });

  it("warns once a week when someone on the clock nears overtime", async () => {
    const linked = await createLinkedEmployee(database(), scenario, SELF);
    const manager = await actorWith(database(), scenario, ["timeclock.manage", "timeclock.view"]);
    const today = localDateOf(new Date(), FIXTURE_TIME_ZONE);
    const hour = 3600_000;

    // 37 closed hours this business date plus 2 open ones: within 4 hours of 40.
    await insertClosedEntry(database(), scenario.owner, {
      employeeId: linked.employeeId,
      positionId: scenario.server,
      businessDate: today,
      clockInAt: new Date(Date.now() - 40 * hour),
      clockOutAt: new Date(Date.now() - 3 * hour),
    });
    await insertOpenEntry(database(), scenario.owner, {
      employeeId: linked.employeeId,
      positionId: scenario.server,
      businessDate: today,
      clockInAt: new Date(Date.now() - 2 * hour),
    });

    await notifyTimeBasedSignals(database(), new Date(), { locationIds: [scenario.locationA] });
    await notifyTimeBasedSignals(database(), new Date(), { locationIds: [scenario.locationA] });

    expect(await ofType(linked.actor.userId, "OVERTIME_APPROACHING")).toHaveLength(1);
    expect(await ofType(manager.userId, "OVERTIME_APPROACHING")).toHaveLength(1);
    expect((await listNotifications(database(), linked.actor)).notifications[0]!.link?.href).toBe("/my-time");
  });

  it("refuses a notification of a new kind without its link", async () => {
    const linked = await createLinkedEmployee(database(), scenario, SELF);

    await expect(
      database().insert(notifications).values({
        organizationId: scenario.organizationId,
        locationId: scenario.locationA,
        recipientUserId: linked.actor.userId,
        notificationType: "SCHEDULE_PUBLISHED",
        title: "Missing link",
        body: "No period",
      }),
    ).rejects.toThrow();
    expect(
      await database()
        .select()
        .from(notifications)
        .where(inArray(notifications.recipientUserId, [linked.actor.userId])),
    ).toEqual([]);
  });
});
