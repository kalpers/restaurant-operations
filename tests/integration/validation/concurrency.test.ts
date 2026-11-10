import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { schedulePeriods, settlements, shiftAssignments } from "@/db/schema";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { assignEmployee, publishPeriod } from "@/modules/scheduling/services/schedule-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import type { AppError } from "@/shared/errors/app-error";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import { itemRows, newKey, orderRow, plainItem } from "../../fixtures/order-fixtures";
import {
  createDraftPeriod,
  createSchedulableEmployee,
  createSchedulingScenario,
  createShiftFixture,
  type SchedulingScenario,
} from "../../fixtures/scheduling-fixtures";
import { createSettlementScenario, sentOrder, type SettlementScenario } from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();

const codes = (results: PromiseSettledResult<unknown>[]) =>
  results.flatMap((result) => (result.status === "rejected" ? [(result.reason as AppError).code] : []));
const fulfilled = (results: PromiseSettledResult<unknown>[]) => results.filter((result) => result.status === "fulfilled");

/**
 * Phase 13 concurrency checks the per-domain suites don't already make. Already covered
 * there, and not repeated: two SENDs of one order (orders/submission), two seatings of one
 * reservation and two parties for one table (reservations/holds-and-seating,
 * restaurant/seating), two terminals taking the last balance and two completions of one
 * settlement (settlements/settlements), and two cooks starting one item (kitchen/lifecycle).
 */
describe("Phase 13: concurrency", () => {
  describe("orders and settlements", () => {
    let scenario: SettlementScenario;

    beforeAll(async () => {
      scenario = await createSettlementScenario(database());
    });

    afterAll(async () => {
      await clearEmployeeData(database());
    });

    it("two terminals editing one order at the same version: one wins, one gets a conflict", async () => {
      const order = await createOrder(database(), scenario.cashier, { orderType: "TAKEOUT", customerName: null });
      const soda = await plainItem(database(), scenario.owner, "3.00");
      const add = () =>
        addDraftItem(database(), scenario.cashier, order.id, {
          expectedVersion: order.version,
          menuItemId: soda.id,
          quantity: 1,
          selections: [],
          specialInstructions: null,
        });
      const results = await Promise.allSettled([add(), add()]);

      expect(fulfilled(results)).toHaveLength(1);
      expect(codes(results)).toEqual(["CONCURRENCY_CONFLICT"]);
      expect(await itemRows(database(), order.id)).toHaveLength(1);
      expect((await orderRow(database(), order.id)).version).toBe(order.version + 1);
    });

    it("SEND racing a settlement opening never leaves a snapshot that disagrees with the order", async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const order = await sentOrder(database(), scenario, ["10.00"], { drafts: ["4.00"] });
        const results = await Promise.allSettled([
          sendOrderItems(database(), scenario.cashier, order.id, { expectedVersion: order.version, idempotencyKey: newKey() }),
          openSettlement(database(), scenario.cashier, order.id),
        ]);
        const [settlement] = await database().select().from(settlements).where(eq(settlements.orderId, order.id));
        const after = await orderRow(database(), order.id);

        // Whichever commits first, the other sees it: the snapshot is the order's amount.
        expect(fulfilled(results).length).toBeGreaterThanOrEqual(1);
        expect(codes(results).every((code) => code === "SETTLEMENT_IN_PROGRESS")).toBe(true);
        expect(settlement!.orderAmountSnapshot).toBe(after.subtotal);
        expect(["10.00", "14.00"]).toContain(after.subtotal);
      }
    });
  });

  describe("scheduling", () => {
    let scenario: SchedulingScenario;

    beforeAll(async () => {
      scenario = await createSchedulingScenario(database());
    });

    afterAll(async () => {
      await clearEmployeeData(database());
      await closeDatabase();
    });

    const periodVersion = async (periodId: string) =>
      (await database().select().from(schedulePeriods).where(eq(schedulePeriods.id, periodId)))[0]!.version;

    it("two managers filling one shift at the same period version: one assignment", async () => {
      const period = await createDraftPeriod(database(), scenario.owner, { name: "Race week" });
      const shift = await createShiftFixture(database(), scenario.owner, { id: period.id, version: period.version }, scenario);
      const version = await periodVersion(period.id);
      const [a, b] = [
        await createSchedulableEmployee(database(), scenario, { firstName: "Ana" }),
        await createSchedulableEmployee(database(), scenario, { firstName: "Ben" }),
      ];
      const results = await Promise.allSettled(
        [a, b].map((employeeId) =>
          assignEmployee(database(), scenario.owner, shift.id, { employeeId, notes: null, expectedPeriodVersion: version }),
        ),
      );
      const assignments = await database().select().from(shiftAssignments).where(eq(shiftAssignments.shiftId, shift.id));

      expect(fulfilled(results)).toHaveLength(1);
      expect(codes(results)).toEqual(["CONCURRENCY_CONFLICT"]);
      expect(assignments.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
      expect(await periodVersion(period.id)).toBe(version + 1);
    });

    it("an edit racing a publish: the published schedule is exactly what was checked", async () => {
      const period = await createDraftPeriod(database(), scenario.owner, {
        name: "Publish race",
        startDate: "2030-02-04",
        endDate: "2030-02-10",
      });
      const shift = await createShiftFixture(database(), scenario.owner, { id: period.id, version: period.version }, scenario, {
        shiftDate: "2030-02-04",
      });
      const employeeId = await createSchedulableEmployee(database(), scenario, { firstName: "Cy" });
      const version = await periodVersion(period.id);
      const results = await Promise.allSettled([
        assignEmployee(database(), scenario.owner, shift.id, { employeeId, notes: null, expectedPeriodVersion: version }),
        publishPeriod(database(), scenario.owner, period.id, { expectedVersion: version }),
      ]);
      const [row] = await database().select().from(schedulePeriods).where(eq(schedulePeriods.id, period.id));
      const assignments = await database().select().from(shiftAssignments).where(eq(shiftAssignments.shiftId, shift.id));

      expect(fulfilled(results)).toHaveLength(1);
      expect(codes(results)).toEqual(["CONCURRENCY_CONFLICT"]);

      if (row!.status === "PUBLISHED") {
        // Publish won: the assignment never reached the published schedule.
        expect(assignments).toEqual([]);
      } else {
        // The edit won: the draft has it and is still unpublished.
        expect(row!.status).toBe("DRAFT");
        expect(assignments).toHaveLength(1);
      }
    });
  });
});
