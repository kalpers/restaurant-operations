import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  employees,
  schedulePeriods,
  shiftAssignments,
  shiftSwapRequests,
} from "@/db/schema";
import { terminateEmployee } from "@/workflows/terminate-employee/terminate-employee";
import {
  assignEmployee,
  publishPeriod,
} from "@/modules/scheduling/services/schedule-service";
import {
  acceptOwnSwap,
  approveSwap,
  cancelOwnSwap,
  denySwap,
  listOwnSwaps,
  listSwapsForReview,
  openSwapForEmployee,
  recordSwapAcceptance,
  requestOwnSwap,
  setSwapTarget,
} from "@/modules/scheduling/services/swap-service";
import { requestTimeOffForEmployee, approveTimeOff } from "@/modules/scheduling/services/time-off-service";
import { addAvailabilityException } from "@/modules/scheduling/services/availability-service";
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

const SWAP_SELF = ["schedule.view", "schedule.swap.request"] as const;

async function periodVersion(periodId: string): Promise<number> {
  const [row] = await database()
    .select({ version: schedulePeriods.version })
    .from(schedulePeriods)
    .where(eq(schedulePeriods.id, periodId));

  return row!.version;
}

async function assignmentRow(id: string) {
  const [row] = await database()
    .select()
    .from(shiftAssignments)
    .where(eq(shiftAssignments.id, id));

  return row!;
}

describe("shift swaps", () => {
  let scenario: SchedulingScenario;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  /** A published schedule with the requester on the Monday shift. */
  async function publishedAssignment(requesterEmployeeId: string) {
    const period = await createDraftPeriod(database(), scenario.owner);
    const shift = await createShiftFixture(
      database(),
      scenario.owner,
      period,
      scenario,
    );
    const { id } = await assignEmployee(database(), scenario.owner, shift.id, {
      employeeId: requesterEmployeeId,
      notes: null,
      expectedPeriodVersion: await periodVersion(period.id),
    });

    await publishPeriod(database(), scenario.owner, period.id, {
      expectedVersion: await periodVersion(period.id),
    });

    return { periodId: period.id, shiftId: shift.id, assignmentId: id };
  }

  describe("requesting", () => {
    it("the requester must hold the assignment, identified by the login", async () => {
      const { actor, employeeId } = await createLinkedEmployee(
        database(),
        scenario,
        SWAP_SELF,
      );
      const someoneElse = await createSchedulableEmployee(database(), scenario);
      const mine = await publishedAssignment(employeeId);
      const swap = await requestOwnSwap(database(), actor, {
        assignmentId: mine.assignmentId,
        targetEmployeeId: someoneElse,
        reason: "Appointment",
      });
      const [row] = await database()
        .select()
        .from(shiftSwapRequests)
        .where(eq(shiftSwapRequests.id, swap.id));

      expect(row).toMatchObject({
        requestingEmployeeId: employeeId,
        status: "PENDING",
        requestedByUserId: actor.userId,
      });
    });

    it("refuses someone else's assignment as if absent", async () => {
      const { actor } = await createLinkedEmployee(
        database(),
        scenario,
        SWAP_SELF,
      );
      const holder = await createSchedulableEmployee(database(), scenario);
      const theirs = await publishedAssignment(holder);

      await expect(
        requestOwnSwap(database(), actor, {
          assignmentId: theirs.assignmentId,
          targetEmployeeId: null,
          reason: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("needs a published schedule", async () => {
      const { actor, employeeId } = await createLinkedEmployee(
        database(),
        scenario,
        SWAP_SELF,
      );
      const period = await createDraftPeriod(database(), scenario.owner);
      const shift = await createShiftFixture(
        database(),
        scenario.owner,
        period,
        scenario,
      );
      const { id } = await assignEmployee(database(), scenario.owner, shift.id, {
        employeeId,
        notes: null,
        expectedPeriodVersion: await periodVersion(period.id),
      });

      await expect(
        requestOwnSwap(database(), actor, {
          assignmentId: id,
          targetEmployeeId: null,
          reason: null,
        }),
      ).rejects.toMatchObject({ code: "SWAP_REQUIRES_PUBLISHED" });
    });

    it("allows one open request per assignment", async () => {
      const holder = await createSchedulableEmployee(database(), scenario);
      const { assignmentId } = await publishedAssignment(holder);
      const input = { assignmentId, targetEmployeeId: null, reason: null };

      await openSwapForEmployee(database(), scenario.owner, input);

      await expect(
        openSwapForEmployee(database(), scenario.owner, input),
      ).rejects.toMatchObject({ code: "SWAP_ALREADY_OPEN" });
    });

    it("refuses swapping with yourself, or with someone from elsewhere", async () => {
      const holder = await createSchedulableEmployee(database(), scenario);
      const { assignmentId } = await publishedAssignment(holder);
      const other = await createSchedulingScenario(database());
      const stranger = await createSchedulableEmployee(database(), other);

      await expect(
        openSwapForEmployee(database(), scenario.owner, {
          assignmentId,
          targetEmployeeId: holder,
          reason: null,
        }),
      ).rejects.toThrow("someone else");
      await expect(
        openSwapForEmployee(database(), scenario.owner, {
          assignmentId,
          targetEmployeeId: stranger,
          reason: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("needs the request permission", async () => {
      const { actor, employeeId } = await createLinkedEmployee(
        database(),
        scenario,
        ["schedule.view"],
      );
      const { assignmentId } = await publishedAssignment(employeeId);

      await expect(
        requestOwnSwap(database(), actor, {
          assignmentId,
          targetEmployeeId: null,
          reason: null,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("acceptance", () => {
    it("the named target accepts for themselves, and nobody else can", async () => {
      const holder = await createSchedulableEmployee(database(), scenario);
      const target = await createLinkedEmployee(database(), scenario, SWAP_SELF);
      const bystander = await createLinkedEmployee(
        database(),
        scenario,
        SWAP_SELF,
      );
      const { assignmentId } = await publishedAssignment(holder);
      const swap = await openSwapForEmployee(database(), scenario.owner, {
        assignmentId,
        targetEmployeeId: target.employeeId,
        reason: null,
      });

      await expect(
        acceptOwnSwap(database(), bystander.actor, swap.id, {
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        acceptOwnSwap(database(), target.actor, swap.id, { expectedVersion: 1 }),
      ).resolves.toMatchObject({ status: "ACCEPTED" });
    });

    it("refuses a target who isn't qualified, with the shared code", async () => {
      const holder = await createSchedulableEmployee(database(), scenario);
      const unqualified = await createLinkedEmployee(
        database(),
        scenario,
        SWAP_SELF,
        { positionId: scenario.bartender },
      );
      const { assignmentId } = await publishedAssignment(holder);
      const swap = await openSwapForEmployee(database(), scenario.owner, {
        assignmentId,
        targetEmployeeId: unqualified.employeeId,
        reason: null,
      });

      await expect(
        acceptOwnSwap(database(), unqualified.actor, swap.id, {
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "POSITION_NOT_HELD" });
    });

    it("refuses a target with no availability", async () => {
      const holder = await createSchedulableEmployee(database(), scenario);
      const target = await createSchedulableEmployee(database(), scenario, {
        available: false,
      });
      const { assignmentId } = await publishedAssignment(holder);
      const swap = await openSwapForEmployee(database(), scenario.owner, {
        assignmentId,
        targetEmployeeId: target,
        reason: null,
      });

      await expect(
        recordSwapAcceptance(database(), scenario.owner, swap.id, {
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "AVAILABILITY_NOT_CONFIGURED" });
    });

    it("refuses a target already working an overlapping shift", async () => {
      const holder = await createSchedulableEmployee(database(), scenario);
      const target = await createSchedulableEmployee(database(), scenario);
      const period = await createDraftPeriod(database(), scenario.owner);
      const first = await createShiftFixture(
        database(),
        scenario.owner,
        period,
        scenario,
      );
      const second = await createShiftFixture(
        database(),
        scenario.owner,
        { id: period.id, version: await periodVersion(period.id) },
        scenario,
      );
      const { id: assignmentId } = await assignEmployee(
        database(),
        scenario.owner,
        first.id,
        {
          employeeId: holder,
          notes: null,
          expectedPeriodVersion: await periodVersion(period.id),
        },
      );

      await assignEmployee(database(), scenario.owner, second.id, {
        employeeId: target,
        notes: null,
        expectedPeriodVersion: await periodVersion(period.id),
      });
      await publishPeriod(database(), scenario.owner, period.id, {
        expectedVersion: await periodVersion(period.id),
      });

      const swap = await openSwapForEmployee(database(), scenario.owner, {
        assignmentId,
        targetEmployeeId: target,
        reason: null,
      });

      await expect(
        recordSwapAcceptance(database(), scenario.owner, swap.id, {
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "SHIFT_OVERLAP" });
    });

    it("needs a target first, which a manager can name", async () => {
      const holder = await createSchedulableEmployee(database(), scenario);
      const target = await createSchedulableEmployee(database(), scenario);
      const { assignmentId } = await publishedAssignment(holder);
      const swap = await openSwapForEmployee(database(), scenario.owner, {
        assignmentId,
        targetEmployeeId: null,
        reason: null,
      });

      await expect(
        recordSwapAcceptance(database(), scenario.owner, swap.id, {
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "SWAP_HAS_NO_TARGET" });

      await setSwapTarget(database(), scenario.owner, swap.id, {
        targetEmployeeId: target,
        expectedVersion: 1,
      });

      await expect(
        recordSwapAcceptance(database(), scenario.owner, swap.id, {
          expectedVersion: 2,
        }),
      ).resolves.toMatchObject({ status: "ACCEPTED" });
    });
  });

  describe("approval", () => {
    async function acceptedSwap() {
      const holder = await createSchedulableEmployee(database(), scenario);
      const target = await createSchedulableEmployee(database(), scenario);
      const published = await publishedAssignment(holder);
      const swap = await openSwapForEmployee(database(), scenario.owner, {
        assignmentId: published.assignmentId,
        targetEmployeeId: target,
        reason: null,
      });

      await recordSwapAcceptance(database(), scenario.owner, swap.id, {
        expectedVersion: 1,
      });

      return { ...published, swapId: swap.id, holder, target };
    }

    it("replaces the assignment transactionally, keeping history and provenance", async () => {
      const accepted = await acceptedSwap();
      const before = await periodVersion(accepted.periodId);
      const result = await approveSwap(
        database(),
        scenario.owner,
        accepted.swapId,
        { expectedVersion: 2 },
      );
      const [swap] = await database()
        .select()
        .from(shiftSwapRequests)
        .where(eq(shiftSwapRequests.id, accepted.swapId));
      const original = await assignmentRow(accepted.assignmentId);
      const replacement = await assignmentRow(swap!.replacementAssignmentId!);

      expect(result.status).toBe("COMPLETED");
      expect(swap).toMatchObject({
        approvedByUserId: scenario.owner.userId,
        status: "COMPLETED",
      });
      expect(swap?.approvedAt).toBeInstanceOf(Date);
      expect(original).toMatchObject({
        status: "SWAPPED",
        employeeId: accepted.holder,
        endedByUserId: scenario.owner.userId,
      });
      expect(replacement).toMatchObject({
        status: "ACTIVE",
        employeeId: accepted.target,
        assignmentSource: "SHIFT_SWAP",
        shiftId: accepted.shiftId,
      });
      expect(await periodVersion(accepted.periodId)).toBe(before + 1);
    });

    it("needs the receiving employee to have accepted", async () => {
      const holder = await createSchedulableEmployee(database(), scenario);
      const target = await createSchedulableEmployee(database(), scenario);
      const { assignmentId } = await publishedAssignment(holder);
      const swap = await openSwapForEmployee(database(), scenario.owner, {
        assignmentId,
        targetEmployeeId: target,
        reason: null,
      });

      await expect(
        approveSwap(database(), scenario.owner, swap.id, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ code: "SWAP_NOT_ACCEPTED" });
    });

    it("revalidates at approval, leaving the original assignment unchanged on failure", async () => {
      const accepted = await acceptedSwap();

      await addAvailabilityException(
        database(),
        scenario.owner,
        { kind: "employee", employeeId: accepted.target },
        {
          exceptionDate: MONDAY,
          startTime: null,
          endTime: null,
          availabilityType: "UNAVAILABLE",
          reason: null,
          thisLocationOnly: false,
        },
      );

      await expect(
        approveSwap(database(), scenario.owner, accepted.swapId, {
          expectedVersion: 2,
        }),
      ).rejects.toMatchObject({ code: "AVAILABILITY_UNAVAILABLE" });

      const original = await assignmentRow(accepted.assignmentId);
      const [swap] = await database()
        .select({ status: shiftSwapRequests.status })
        .from(shiftSwapRequests)
        .where(eq(shiftSwapRequests.id, accepted.swapId));

      expect(original.status).toBe("ACTIVE");
      expect(swap?.status).toBe("ACCEPTED");
    });

    it("rolls back the whole swap on a stale version", async () => {
      const accepted = await acceptedSwap();

      await expect(
        approveSwap(database(), scenario.owner, accepted.swapId, {
          expectedVersion: 99,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      const original = await assignmentRow(accepted.assignmentId);
      const rows = await database()
        .select()
        .from(shiftAssignments)
        .where(eq(shiftAssignments.shiftId, accepted.shiftId));

      expect(original.status).toBe("ACTIVE");
      expect(rows).toHaveLength(1);
    });

    it("refuses approval without the permission", async () => {
      const accepted = await acceptedSwap();
      const requester = await actorWith(database(), scenario, [
        "schedule.swap.request",
      ]);

      await expect(
        approveSwap(database(), requester, accepted.swapId, {
          expectedVersion: 2,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("refuses at another location", async () => {
      const accepted = await acceptedSwap();

      await expect(
        approveSwap(database(), scenario.ownerAtB, accepted.swapId, {
          expectedVersion: 2,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("moves a terminated employee's published shift by a manager-opened swap", async () => {
      const holder = await createSchedulableEmployee(database(), scenario);
      const target = await createSchedulableEmployee(database(), scenario);
      const { assignmentId } = await publishedAssignment(holder);
      const [row] = await database()
        .select({ version: employees.version })
        .from(employees)
        .where(eq(employees.id, holder));

      await terminateEmployee(database(), scenario.owner, {
        employeeId: holder,
        terminationDate: "2026-01-02",
        reason: null,
        expectedVersion: row!.version,
      });

      const swap = await openSwapForEmployee(database(), scenario.owner, {
        assignmentId,
        targetEmployeeId: target,
        reason: "Left the company",
      });

      await recordSwapAcceptance(database(), scenario.owner, swap.id, {
        expectedVersion: 1,
      });

      await expect(
        approveSwap(database(), scenario.owner, swap.id, { expectedVersion: 2 }),
      ).resolves.toMatchObject({ status: "COMPLETED" });
    });

    it("the approved swap frees the original holder to take time off", async () => {
      const accepted = await acceptedSwap();

      await approveSwap(database(), scenario.owner, accepted.swapId, {
        expectedVersion: 2,
      });

      const { id } = await requestTimeOffForEmployee(
        database(),
        scenario.owner,
        accepted.holder,
        {
          startDate: MONDAY,
          startTime: null,
          endDate: MONDAY,
          endTime: null,
          requestType: "PERSONAL",
          reason: null,
          employeeNote: null,
        },
      );

      await expect(
        approveTimeOff(database(), scenario.owner, id, {
          managerNote: null,
          expectedVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "APPROVED" });
    });
  });

  describe("closing and listing", () => {
    it("a manager can deny and the requester can withdraw", async () => {
      const denyHolder = await createLinkedEmployee(
        database(),
        scenario,
        SWAP_SELF,
      );
      const denied = await publishedAssignment(denyHolder.employeeId);
      const swap = await requestOwnSwap(database(), denyHolder.actor, {
        assignmentId: denied.assignmentId,
        targetEmployeeId: null,
        reason: null,
      });

      await expect(
        denySwap(database(), scenario.owner, swap.id, { expectedVersion: 1 }),
      ).resolves.toMatchObject({ status: "DENIED" });
      await expect(
        cancelOwnSwap(database(), denyHolder.actor, swap.id, {
          expectedVersion: 2,
        }),
      ).rejects.toMatchObject({ code: "SWAP_NOT_OPEN" });

      const second = await requestOwnSwap(database(), denyHolder.actor, {
        assignmentId: denied.assignmentId,
        targetEmployeeId: null,
        reason: null,
      });

      await expect(
        cancelOwnSwap(database(), denyHolder.actor, second.id, {
          expectedVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "CANCELLED" });
    });

    it("someone can't withdraw another person's request", async () => {
      const holder = await createSchedulableEmployee(database(), scenario);
      const { assignmentId } = await publishedAssignment(holder);
      const swap = await openSwapForEmployee(database(), scenario.owner, {
        assignmentId,
        targetEmployeeId: null,
        reason: null,
      });
      const other = await createLinkedEmployee(database(), scenario, SWAP_SELF);

      await expect(
        cancelOwnSwap(database(), other.actor, swap.id, { expectedVersion: 1 }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("lists an employee's own swaps, and the manager queue by location", async () => {
      const { actor, employeeId } = await createLinkedEmployee(
        database(),
        scenario,
        SWAP_SELF,
      );
      const { assignmentId } = await publishedAssignment(employeeId);
      const swap = await requestOwnSwap(database(), actor, {
        assignmentId,
        targetEmployeeId: null,
        reason: null,
      });

      expect(
        (await listOwnSwaps(database(), actor)).swaps.map((row) => row.id),
      ).toEqual([swap.id]);
      expect(
        (await listSwapsForReview(database(), scenario.owner)).map((row) => row.id),
      ).toEqual([swap.id]);
      expect(await listSwapsForReview(database(), scenario.ownerAtB)).toEqual([]);
    });
  });
});
