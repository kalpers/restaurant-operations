import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, orders, tipDistributions } from "@/db/schema";
import { recordRefund, voidRefund } from "@/modules/settlements/services/refund-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { declareTips } from "@/modules/settlements/services/tip-declaration-service";
import { readPoolTotals } from "@/modules/settlements/services/tip-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";

import { actorWith, createEmployeeFixture } from "../../fixtures/employee-fixtures";
import { clearOrderData, newKey } from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  MANAGER_SETTLEMENT_PERMISSIONS,
  sentOrder,
  settlementRow,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";

// Phase 20 policies 18 and 20 (D17, D19): tip refunds and cash tip declarations.

const database = () => getDatabase();

describe("tip refunds and declarations (Phase 20)", () => {
  let scenario: SettlementScenario;
  let manager: Awaited<ReturnType<typeof actorWith>>;

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());
    manager = await actorWith(database(), scenario, [
      ...MANAGER_SETTLEMENT_PERMISSIONS,
      "settlements.refund",
      "settlements.refund-void",
      "tips.manage",
      "timeclock.punch",
    ]);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  /** A CLOSED 10.00 check paid by card with a 2.00 tip. */
  async function closedWithTip() {
    const order = await sentOrder(database(), scenario, ["10.00"]);
    const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

    await tender(database(), scenario.cashier, settlementId, { tenderType: "EXTERNAL_CARD", amount: "10.00", tipAmount: "2.00" });
    await completeSettlement(database(), scenario.cashier, settlementId, {
      expectedVersion: (await settlementRow(database(), settlementId)).version,
      idempotencyKey: newKey(),
    });

    const [row] = await database().select().from(orders).where(eq(orders.id, order.id));

    return row!;
  }

  const refund = (orderId: string, overrides: Partial<Parameters<typeof recordRefund>[3]> = {}) =>
    recordRefund(database(), manager, orderId, {
      idempotencyKey: newKey(),
      tenderType: "EXTERNAL_CARD",
      amount: "0.00",
      taxAmount: "0.00",
      tipAmount: "0.00",
      reason: "Guest complaint",
      otherDescription: null,
      externalReference: null,
      ...overrides,
    });

  it("refunds a tip on its own, up to the recorded tips, and takes it out of the pool", async () => {
    const order = await closedWithTip();
    const before = await readPoolTotals(database(), { locationId: scenario.locationA, businessDate: order.businessDate });
    const result = await refund(order.id, { tipAmount: "1.50" });

    expect(result).toMatchObject({ amount: "0.00", tipAmount: "1.50", remainingTips: "0.50" });
    await expect(refund(order.id, { tipAmount: "0.75" })).rejects.toMatchObject({ code: "REFUND_EXCEEDS_TIPS" });

    const after = await readPoolTotals(database(), { locationId: scenario.locationA, businessDate: order.businessDate });

    expect(Number(before.poolTotal) - Number(after.poolTotal)).toBeCloseTo(1.5, 2);

    const [audit] = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "settlements.refund-recorded"), eq(auditEvents.entityId, result.refundId)));

    expect(audit!.after).toMatchObject({ tipAmount: "1.50" });
  });

  it("refuses a tip refund on a gift card, and an empty refund", async () => {
    const order = await closedWithTip();

    await expect(refund(order.id, { tenderType: "GIFT_CARD", amount: "1.00", tipAmount: "1.00" })).rejects.toMatchObject({
      code: "TIP_REFUND_TENDER",
    });
    await expect(refund(order.id)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });

  it("refuses tip refunds, and voiding one, while the date's tips are finalized", async () => {
    const order = await closedWithTip();
    const recorded = await refund(order.id, { tipAmount: "1.00" });
    const [finalized] = await database()
      .insert(tipDistributions)
      .values({
        organizationId: scenario.organizationId,
        locationId: scenario.locationA,
        businessDate: order.businessDate,
        status: "FINALIZED",
        poolTotal: "1.00",
        cashTips: "0.00",
        cardTips: "1.00",
        totalWeightedHours: "0.0000",
        ruleSnapshot: {},
        finalizedByUserId: manager.userId,
        finalizedAt: new Date(),
        idempotencyRecordId: (
          await database().execute<{ id: string }>(
            sql`INSERT INTO idempotency_records (organization_id, scope, idempotency_key, actor_user_id, request_fingerprint, response)
              VALUES (${scenario.organizationId}, 'tips.finalize', ${newKey()}, ${manager.userId}, 'fixture', '{}'::jsonb) RETURNING id`,
          )
        )[0]!.id,
      })
      .returning();

    expect(finalized).toBeDefined();
    await expect(refund(order.id, { tipAmount: "0.50" })).rejects.toMatchObject({ code: "TIP_DISTRIBUTION_FINALIZED" });
    await expect(
      voidRefund(database(), manager, recorded.refundId, { expectedVersion: 1, reason: "Mistake" }),
    ).rejects.toMatchObject({ code: "TIP_DISTRIBUTION_FINALIZED" });

    // A refund with no tip is still fine.
    await expect(refund(order.id, { amount: "1.00" })).resolves.toBeDefined();
  });

  it("records a manager's cash tip declaration, audited without the amount, and refuses a server's for others", async () => {
    const order = await closedWithTip();
    const { id: someone } = await createEmployeeFixture(database(), scenario.owner);

    const declared = await declareTips(database(), manager, {
      employeeId: someone,
      businessDate: order.businessDate,
      amount: "18.00",
      note: "Bar cash",
    });

    expect(declared).toMatchObject({ amount: "18.00", employeeId: someone });

    const [audit] = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "tips.declaration-recorded"), eq(auditEvents.entityId, declared.id)));

    expect(JSON.stringify(audit)).not.toContain("18.00");

    // A second declaration without the version is a stale write; with it, a correction.
    await expect(
      declareTips(database(), manager, { employeeId: someone, businessDate: order.businessDate, amount: "20.00" }),
    ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
    await expect(
      declareTips(database(), manager, {
        employeeId: someone,
        businessDate: order.businessDate,
        amount: "20.00",
        expectedVersion: declared.version,
      }),
    ).resolves.toMatchObject({ amount: "20.00" });

    const server = await actorWith(database(), scenario, ["timeclock.punch"]);

    await expect(
      declareTips(database(), server, { employeeId: someone, businessDate: order.businessDate, amount: "1.00" }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
