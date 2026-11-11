import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import { auditEvents, inventoryTransactions, orderRefunds, orders } from "@/db/schema";
import {
  closeDrawerSession,
  createDrawer,
  getDrawerSetting,
  listDrawerSessions,
  openDrawerSession,
  recordDrawerMovement,
  setCashDrawerRequired,
} from "@/modules/settlements/services/drawer-service";
import { recordRefund, voidRefund } from "@/modules/settlements/services/refund-service";
import { openSettlement, voidTender } from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";

import { actorWith } from "../../fixtures/employee-fixtures";
import { uniqueCode } from "../../fixtures/menu-fixtures";
import { clearOrderData, newKey } from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  MANAGER_SETTLEMENT_PERMISSIONS,
  orderRow,
  sentOrder,
  settlementRow,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";
import { assignTaxCategory, setTax, taxCategoryWithRate } from "../../fixtures/tax-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    return `DB:${readConstraintName(error) ?? (error as Error).message}`;
  }

  return undefined;
}

describe("cash drawers and refunds (Phase 17 policies B and E)", () => {
  let scenario: SettlementScenario;
  let manager: Awaited<ReturnType<typeof actorWith>>;

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());
    manager = await actorWith(database(), scenario, [
      ...MANAGER_SETTLEMENT_PERMISSIONS,
      "drawers.view",
      "drawers.operate",
      "drawers.manage",
      "settlements.refund",
      "settlements.refund-void",
    ]);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function requireDrawers(required = true) {
    const { version } = await getDrawerSetting(database(), manager);

    return setCashDrawerRequired(database(), manager, { required, expectedVersion: version });
  }

  async function openDrawer(float = "100.00") {
    const drawer = await createDrawer(database(), manager, { code: uniqueCode("DRW"), name: "Front register" });
    const session = await openDrawerSession(database(), manager, drawer.id, { openingFloat: float, idempotencyKey: newKey() });

    return { drawer, session };
  }

  /** Sends one item at the price, opens a settlement, and returns its ID. */
  async function settlementFor(price: string) {
    const order = await sentOrder(database(), scenario, [price]);
    const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

    return { orderId: order.id, settlementId };
  }

  async function complete(settlementId: string) {
    return completeSettlement(database(), scenario.cashier, settlementId, {
      expectedVersion: (await settlementRow(database(), settlementId)).version,
      idempotencyKey: newKey(),
    });
  }

  describe("drawers", () => {
    it("refuses cash with no drawer when the location requires one, and takes it into an open session", async () => {
      await requireDrawers(true);

      const { session } = await openDrawer();
      const { settlementId } = await settlementFor("12.00");

      expect(
        await codeOf(tender(database(), scenario.cashier, settlementId, { amount: "12.00", receivedAmount: "20.00" })),
      ).toBe("CASH_DRAWER_REQUIRED");

      const recorded = await tender(database(), scenario.cashier, settlementId, {
        amount: "12.00",
        tipAmount: "2.00",
        receivedAmount: "20.00",
        cashDrawerSessionId: session.id,
      });

      expect(recorded.changeAmount).toBe("6.00");

      // A card tender can't go into a drawer.
      expect(
        await codeOf(
          tender(database(), scenario.cashier, settlementId, {
            tenderType: "EXTERNAL_CARD",
            amount: "1.00",
            cashDrawerSessionId: session.id,
          }),
        ),
      ).toBe("DRAWER_CASH_ONLY");
    });

    it("takes cash with no drawer while the setting is off", async () => {
      const { settlementId } = await settlementFor("5.00");

      await tender(database(), scenario.cashier, settlementId, { amount: "5.00", receivedAmount: "5.00" });

      expect((await complete(settlementId)).replayed).toBe(false);
    });

    it("computes expected cash and the variance exactly at close, and freezes the session", async () => {
      await requireDrawers(true);

      const { session } = await openDrawer("100.00");
      const first = await settlementFor("18.93");

      await tender(database(), scenario.cashier, first.settlementId, {
        amount: "18.93",
        tipAmount: "3.00",
        receivedAmount: "30.00",
        cashDrawerSessionId: session.id,
      });
      await complete(first.settlementId);
      await recordDrawerMovement(database(), manager, session.id, {
        movementType: "PAID_IN",
        amount: "20.00",
        reason: "Change from the bank",
        idempotencyKey: newKey(),
      });

      const paidOutKey = newKey();
      const paidOut = { movementType: "PAID_OUT" as const, amount: "12.50", reason: "Ice delivery", idempotencyKey: paidOutKey };

      await recordDrawerMovement(database(), manager, session.id, paidOut);
      // A retry with the same key records nothing more.
      expect((await recordDrawerMovement(database(), manager, session.id, paidOut)).replayed).toBe(true);

      // Expected: 100 + 18.93 + 3.00 + 20.00 - 12.50 = 129.43. Counted 129.00 is 0.43 short.
      const [summary] = await listDrawerSessions(database(), manager, { status: "OPEN" });

      expect(summary!.totals).toMatchObject({ cashSales: "18.93", cashTips: "3.00", expected: "129.43" });

      const closed = await closeDrawerSession(database(), manager, session.id, {
        countedAmount: "129.00",
        closeNote: null,
        expectedVersion: session.version,
        idempotencyKey: newKey(),
      });

      expect(closed).toMatchObject({ expected: "129.43", counted: "129.00", variance: "-0.43" });

      // Nothing records into a closed session, in the service or the database.
      expect(
        await codeOf(
          recordDrawerMovement(database(), manager, session.id, {
            movementType: "PAID_IN",
            amount: "1.00",
            reason: "Late",
            idempotencyKey: newKey(),
          }),
        ),
      ).toBe("DRAWER_SESSION_CLOSED");
      expect(
        await codeOf(database().execute(sql`UPDATE cash_drawer_sessions SET counted_amount = 1 WHERE id = ${session.id}`)),
      ).toBe("DB:cash_drawer_sessions_closed");

      const audit = await database()
        .select({ after: auditEvents.after })
        .from(auditEvents)
        .where(eq(auditEvents.action, "drawers.session-closed"));

      expect(audit.map((event) => event.after)).toContainEqual(
        expect.objectContaining({ expectedAmount: "129.43", countedAmount: "129.00", variance: "-0.43" }),
      );
    });

    it("refuses to close while an open settlement holds cash in the drawer", async () => {
      await requireDrawers(true);

      const { session } = await openDrawer();
      const { settlementId } = await settlementFor("10.00");

      await tender(database(), scenario.cashier, settlementId, {
        amount: "4.00",
        receivedAmount: "4.00",
        cashDrawerSessionId: session.id,
      });

      const close = () =>
        closeDrawerSession(database(), manager, session.id, {
          countedAmount: "104.00",
          closeNote: null,
          expectedVersion: session.version,
          idempotencyKey: newKey(),
        });

      expect(await codeOf(close())).toBe("DRAWER_HAS_OPEN_SETTLEMENTS");

      // Voiding the tender (drawer still open) clears the way.
      const [recorded] = await database().execute<{ id: string }>(
        sql`SELECT id FROM settlement_tenders WHERE settlement_id = ${settlementId}`,
      );

      await voidTender(database(), manager, settlementId, (recorded as { id: string }).id, {
        expectedVersion: (await settlementRow(database(), settlementId)).version,
        reason: "Wrong check",
      });

      expect((await close()).variance).toBe("4.00");
    });

    it("allows one open session per drawer and requires drawers.operate", async () => {
      const { drawer } = await openDrawer();

      expect(
        await codeOf(openDrawerSession(database(), manager, drawer.id, { openingFloat: "50.00", idempotencyKey: newKey() })),
      ).toBe("DRAWER_ALREADY_OPEN");
      expect(
        await codeOf(openDrawerSession(database(), scenario.cashier, drawer.id, { openingFloat: "50.00", idempotencyKey: newKey() })),
      ).toBe("PERMISSION_DENIED");
    });
  });

  describe("refunds", () => {
    async function closedTaxedOrder() {
      await setTax(database(), scenario.owner, true);

      const { category } = await taxCategoryWithRate(database(), scenario.owner, "9.00");
      const order = await sentOrder(database(), scenario, []);
      const { plainItem } = await import("../../fixtures/order-fixtures");
      const item = await plainItem(database(), scenario.owner, "20.00", "Taxed entree");
      const { addDraftItem } = await import("@/modules/orders/services/draft-item-service");
      const { sendOrderItems } = await import("@/workflows/submit-order/submit-order");

      await assignTaxCategory(database(), item.id, category.id);

      const added = await addDraftItem(database(), scenario.cashier, order.id, {
        expectedVersion: order.version,
        menuItemId: item.id,
        quantity: 1,
        selections: [],
        specialInstructions: null,
      });

      await sendOrderItems(database(), scenario.cashier, order.id, {
        expectedVersion: added.orderVersion,
        idempotencyKey: newKey(),
      });

      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

      await tender(database(), scenario.cashier, settlementId, { tenderType: "EXTERNAL_CARD", amount: "21.80" });
      await complete(settlementId);

      return order.id;
    }

    it("records a refund on a closed order without changing the order, settlement or inventory", async () => {
      const orderId = await closedTaxedOrder();
      const before = await orderRow(database(), orderId);
      const ledgerBefore = await database().select().from(inventoryTransactions);

      expect(before).toMatchObject({ status: "CLOSED", totalDue: "21.80", taxTotal: "1.80" });

      const refund = await recordRefund(database(), manager, orderId, {
        idempotencyKey: newKey(),
        tenderType: "EXTERNAL_CARD",
        amount: "10.90",
        taxAmount: "0.90",
        reason: "Cold entree",
        otherDescription: null,
        externalReference: "RF-1",
      });

      expect(refund).toMatchObject({ refundNumber: 1, remaining: "10.90", remainingTax: "0.90" });
      expect(await orderRow(database(), orderId)).toEqual(before);
      expect(await database().select().from(inventoryTransactions)).toHaveLength(ledgerBefore.length);

      expect(
        await codeOf(
          recordRefund(database(), manager, orderId, {
            idempotencyKey: newKey(),
            tenderType: "EXTERNAL_CARD",
            amount: "10.91",
            taxAmount: "0.00",
            reason: "Too much",
            otherDescription: null,
            externalReference: null,
          }),
        ),
      ).toBe("REFUND_EXCEEDS_ORDER");

      // Voiding keeps the row, and frees the amount again.
      await voidRefund(database(), manager, refund.refundId, { expectedVersion: 1, reason: "Entered twice" });

      const [voided] = await database().select().from(orderRefunds).where(eq(orderRefunds.id, refund.refundId));

      expect(voided).toMatchObject({ status: "VOIDED", voidReason: "Entered twice" });
      expect(
        (
          await recordRefund(database(), manager, orderId, {
            idempotencyKey: newKey(),
            tenderType: "OTHER",
            amount: "21.80",
            taxAmount: "1.80",
            reason: "Manager comp after close",
            otherDescription: "Store credit slip",
            externalReference: null,
          })
        ).remaining,
      ).toBe("0.00");

      const audit = await database()
        .select({ after: auditEvents.after })
        .from(auditEvents)
        .where(eq(auditEvents.action, "settlements.refund-recorded"));

      expect(JSON.stringify(audit)).not.toContain("RF-1");
    });

    it("refuses a refund on an order that isn't closed, in the service and the database", async () => {
      const order = await sentOrder(database(), scenario, ["8.00"]);

      expect(
        await codeOf(
          recordRefund(database(), manager, order.id, {
            idempotencyKey: newKey(),
            tenderType: "CASH",
            amount: "1.00",
            taxAmount: "0.00",
            reason: "x",
            otherDescription: null,
            externalReference: null,
          }),
        ),
      ).toBe("ORDER_NOT_CLOSED");
      expect(
        await codeOf(
          database().execute(sql`
            INSERT INTO order_refunds (organization_id, location_id, order_id, settlement_id, refund_number,
              tender_type, amount, reason, business_date, recorded_by_user_id, recorded_at, idempotency_record_id)
            SELECT o.organization_id, o.location_id, o.id, gen_random_uuid(), 1, 'CASH', 1, 'x', o.business_date,
              ${manager.userId}, now(), gen_random_uuid()
            FROM orders o WHERE o.id = ${order.id}`),
        ),
      ).toMatch(/^DB:/);
    });

    it("can't run two refunds past the total at once", async () => {
      const orderId = await closedTaxedOrder();
      const attempt = () =>
        recordRefund(database(), manager, orderId, {
          idempotencyKey: newKey(),
          tenderType: "EXTERNAL_CARD",
          amount: "15.00",
          taxAmount: "0.00",
          reason: "Concurrent",
          otherDescription: null,
          externalReference: null,
        });
      const results = await Promise.allSettled([attempt(), attempt()]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        await database().select().from(orderRefunds).where(eq(orderRefunds.orderId, orderId)),
      ).toHaveLength(1);
    });

    it("returns the first refund for a retried key", async () => {
      const orderId = await closedTaxedOrder();
      const input = {
        idempotencyKey: newKey(),
        tenderType: "EXTERNAL_CARD" as const,
        amount: "5.00",
        taxAmount: "0.00",
        reason: "Slow service",
        otherDescription: null,
        externalReference: null,
      };
      const first = await recordRefund(database(), manager, orderId, input);
      const again = await recordRefund(database(), manager, orderId, input);

      expect(again).toMatchObject({ replayed: true, refundId: first.refundId });
    });

    it("takes a cash refund out of the drawer's expected cash", async () => {
      const orderId = await closedTaxedOrder();

      await requireDrawers(true);

      const { session } = await openDrawer("50.00");

      expect(
        await codeOf(
          recordRefund(database(), manager, orderId, {
            idempotencyKey: newKey(),
            tenderType: "CASH",
            amount: "3.00",
            taxAmount: "0.00",
            reason: "Overcharge",
            otherDescription: null,
            externalReference: null,
          }),
        ),
      ).toBe("CASH_DRAWER_REQUIRED");

      await recordRefund(database(), manager, orderId, {
        idempotencyKey: newKey(),
        tenderType: "CASH",
        amount: "3.00",
        taxAmount: "0.00",
        reason: "Overcharge",
        otherDescription: null,
        externalReference: null,
        cashDrawerSessionId: session.id,
      });

      const [summary] = await listDrawerSessions(database(), manager, { status: "OPEN" });

      expect(summary!.totals).toMatchObject({ cashRefunds: "3.00", expected: "47.00" });
    });

    it("requires settlements.refund", async () => {
      const orderId = await closedTaxedOrder();

      expect(
        await codeOf(
          recordRefund(database(), scenario.cashier, orderId, {
            idempotencyKey: newKey(),
            tenderType: "CASH",
            amount: "1.00",
            taxAmount: "0.00",
            reason: "x",
            otherDescription: null,
            externalReference: null,
          }),
        ),
      ).toBe("PERMISSION_DENIED");
      expect((await database().select().from(orders).where(eq(orders.id, orderId)))[0]!.status).toBe("CLOSED");
    });
  });
});
