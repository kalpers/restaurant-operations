import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { idempotencyRecords, orderDiscounts, settlements, settlementTenders } from "@/db/schema";
import {
  applyOrderDiscount,
  createDiscountDefinition,
} from "@/modules/orders/services/discount-service";
import { getOrderSettlementView } from "@/modules/settlements/queries/settlement-queries";
import {
  cancelSettlement,
  openSettlement,
  voidTender,
} from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidOrder } from "@/workflows/void-order-item/void-order-item";

import { uniqueCode } from "../../fixtures/menu-fixtures";
import { clearOrderData, newKey } from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  orderHistory,
  orderRow,
  sentOrder,
  settlementHistory,
  settlementRow,
  tender,
  tendersOf,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : `DB:${(error as Error).message}`;
  }

  return undefined;
}

async function complete(scenario: SettlementScenario, settlementId: string, key = newKey()) {
  const { version } = await settlementRow(database(), settlementId);

  return completeSettlement(database(), scenario.cashier, settlementId, { expectedVersion: version, idempotencyKey: key });
}

describe("settlements", () => {
  let scenario: SettlementScenario;

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  describe("opening", () => {
    it("snapshots the exact post-discount, pre-tax amount of an OPEN order", async () => {
      const order = await sentOrder(database(), scenario, ["12.25", "6.25"]);
      const opened = await openSettlement(database(), scenario.cashier, order.id);
      const row = await settlementRow(database(), opened.settlementId);

      expect(opened.existing).toBe(false);
      expect(row).toMatchObject({ status: "OPEN", orderAmountSnapshot: "18.50", tenderedAmount: "0.00", version: 1 });
      expect(row.openedBusinessDate).toBe((await orderRow(database(), order.id)).businessDate);
      expect((await settlementHistory(database(), opened.settlementId)).map((entry) => entry.status)).toEqual(["OPEN"]);
    });

    it("keeps one OPEN settlement per order: asking again returns it", async () => {
      const order = await sentOrder(database(), scenario, ["5.00"]);
      const [a, b] = await Promise.all([
        openSettlement(database(), scenario.cashier, order.id),
        openSettlement(database(), scenario.settleManager, order.id),
      ]);

      expect(a.settlementId).toBe(b.settlementId);
      expect([a.existing, b.existing].sort()).toEqual([false, true]);
      expect(await database().select().from(settlements).where(eq(settlements.orderId, order.id))).toHaveLength(1);
    });

    it("refuses a second OPEN settlement at the database", async () => {
      const order = await sentOrder(database(), scenario, ["5.00"]);
      const opened = await openSettlement(database(), scenario.cashier, order.id);
      const row = await settlementRow(database(), opened.settlementId);
      const copy = {
        organizationId: row.organizationId,
        locationId: row.locationId,
        orderId: row.orderId,
        orderAmountSnapshot: row.orderAmountSnapshot,
        openedByUserId: row.openedByUserId,
        openedAt: row.openedAt,
        openedBusinessDate: row.openedBusinessDate,
      };

      expect(await codeOf(database().insert(settlements).values(copy))).toMatch(/^DB:/);
    });

    it("treats another location's order as absent", async () => {
      const order = await sentOrder(database(), scenario, ["5.00"]);

      expect(await codeOf(openSettlement(database(), scenario.managerAtB, order.id))).toBe("NOT_FOUND");
    });

    it("refuses a VOIDED order", async () => {
      const order = await sentOrder(database(), scenario, [], { drafts: ["5.00"] });

      await voidOrder(database(), scenario.manager, order.id, {
        reason: "Walked out",
        expectedVersion: order.version,
        dispositions: {},
      });

      expect(await codeOf(openSettlement(database(), scenario.cashier, order.id))).toBe("ORDER_NOT_OPEN");
    });
  });

  describe("tenders", () => {
    it("settles $75 with $25 cash and $50 external card, kept as separate tenders", async () => {
      const order = await sentOrder(database(), scenario, ["50.00", "25.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
      const cash = await tender(database(), scenario.cashier, settlementId, {
        tenderType: "CASH",
        amount: "25.00",
        receivedAmount: "30.00",
      });

      expect(cash).toMatchObject({ amount: "25.00", changeAmount: "5.00", remainingAmount: "50.00" });

      const card = await tender(database(), scenario.cashier, settlementId, {
        tenderType: "EXTERNAL_CARD",
        amount: "50.00",
        tipAmount: "10.00",
        providerName: "Square",
        cardBrand: "Visa",
        cardLastFour: "4242",
        authorizationReference: "A1B2C3",
      });

      expect(card.remainingAmount).toBe("0.00");

      const done = await complete(scenario, settlementId);
      const row = await settlementRow(database(), settlementId);

      expect(done).toMatchObject({ orderStatus: "CLOSED", tenderedAmount: "75.00", tipAmount: "10.00", changeDue: "5.00" });
      expect(row).toMatchObject({ status: "COMPLETED", tenderedAmount: "75.00", tipAmount: "10.00", changeDue: "5.00" });
      expect(row.completedBusinessDate).not.toBeNull();
      expect((await tendersOf(database(), settlementId)).map((entry) => [entry.tenderType, entry.amount])).toEqual([
        ["CASH", "25.00"],
        ["EXTERNAL_CARD", "50.00"],
      ]);

      const closed = await orderRow(database(), order.id);

      expect(closed.status).toBe("CLOSED");
      expect(closed.closedAt).not.toBeNull();
      expect(closed.subtotal).toBe("75.00");
      expect((await orderHistory(database(), order.id)).map((entry) => entry.status)).toEqual(["OPEN", "CLOSED"]);
      expect((await settlementHistory(database(), settlementId)).map((entry) => entry.status)).toEqual([
        "OPEN",
        "COMPLETED",
      ]);
    });

    it("applies 18.50 of 20.00 cash and returns 1.50 change", async () => {
      const order = await sentOrder(database(), scenario, ["18.50"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
      const cash = await tender(database(), scenario.cashier, settlementId, {
        amount: "18.50",
        receivedAmount: "20.00",
      });

      expect(cash).toMatchObject({ amount: "18.50", changeAmount: "1.50", remainingAmount: "0.00" });

      const [row] = await tendersOf(database(), settlementId);

      expect(row).toMatchObject({ receivedAmount: "20.00", amount: "18.50", changeAmount: "1.50", tipAmount: "0.00" });
      expect((await complete(scenario, settlementId)).tenderedAmount).toBe("18.50");
    });

    it("takes change after the cash tip and keeps the tip out of the obligation", async () => {
      const order = await sentOrder(database(), scenario, ["18.50"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

      expect(
        await tender(database(), scenario.cashier, settlementId, { amount: "18.50", tipAmount: "1.00", receivedAmount: "20.00" }),
      ).toMatchObject({ changeAmount: "0.50", tipAmount: "1.00", remainingAmount: "0.00" });
      expect((await orderRow(database(), order.id)).subtotal).toBe("18.50");
    });

    it("refuses insufficient cash, over-application and tips on other types", async () => {
      const order = await sentOrder(database(), scenario, ["10.00"]);
      const { settlementId } = await openSettlement(database(), scenario.settleManager, order.id);
      const actor = scenario.settleManager;

      expect(await codeOf(tender(database(), actor, settlementId, { amount: "10.00", receivedAmount: "9.99" }))).toBe(
        "INSUFFICIENT_CASH",
      );
      expect(
        await codeOf(tender(database(), actor, settlementId, { tenderType: "EXTERNAL_CARD", amount: "10.01" })),
      ).toBe("AMOUNT_EXCEEDS_REMAINING");
      expect(
        await codeOf(tender(database(), actor, settlementId, { tenderType: "GIFT_CARD", amount: "5.00", tipAmount: "1.00" })),
      ).toBe("TIP_NOT_ALLOWED");
      expect(await codeOf(tender(database(), actor, settlementId, { tenderType: "OTHER", amount: "5.00" }))).toBe(
        "DESCRIPTION_REQUIRED",
      );
      expect(await tendersOf(database(), settlementId)).toHaveLength(0);
    });

    it("records GIFT_CARD, HOUSE_ACCOUNT and OTHER as classifications", async () => {
      const order = await sentOrder(database(), scenario, ["30.00"]);
      const { settlementId } = await openSettlement(database(), scenario.settleManager, order.id);
      const actor = scenario.settleManager;

      await tender(database(), actor, settlementId, { tenderType: "GIFT_CARD", amount: "10.00", externalReference: "GC-77" });
      await tender(database(), actor, settlementId, { tenderType: "HOUSE_ACCOUNT", amount: "10.00", externalReference: "Acct Smith" });
      await tender(database(), actor, settlementId, { tenderType: "OTHER", amount: "10.00", otherDescription: "Event voucher 12" });

      expect((await tendersOf(database(), settlementId)).map((row) => row.tenderType)).toEqual([
        "GIFT_CARD",
        "HOUSE_ACCOUNT",
        "OTHER",
      ]);
      expect((await complete(scenario, settlementId)).orderStatus).toBe("CLOSED");
    });

    it("keeps a reported card failure in history at zero and the order OPEN", async () => {
      const order = await sentOrder(database(), scenario, ["40.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

      const failed = await tender(database(), scenario.cashier, settlementId, {
        tenderType: "EXTERNAL_CARD",
        outcome: "FAILED",
        amount: "40.00",
        failureReason: "Declined at terminal",
      });

      expect(failed).toMatchObject({ tenderStatus: "FAILED", remainingAmount: "40.00" });
      expect((await settlementRow(database(), settlementId)).tenderedAmount).toBe("0.00");
      expect(await codeOf(complete(scenario, settlementId))).toBe("SETTLEMENT_NOT_BALANCED");
      expect((await orderRow(database(), order.id)).status).toBe("OPEN");
      expect(await tendersOf(database(), settlementId)).toHaveLength(1);
    });

    it("voids a tender before completion with reason and actor, without deleting it", async () => {
      const order = await sentOrder(database(), scenario, ["20.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
      const recorded = await tender(database(), scenario.cashier, settlementId, {
        tenderType: "EXTERNAL_CARD",
        amount: "20.00",
      });
      const result = await voidTender(database(), scenario.settleManager, settlementId, recorded.tenderId, {
        expectedVersion: recorded.settlementVersion,
        reason: "Wrong card terminal",
      });

      expect(result.remainingAmount).toBe("20.00");

      const [row] = await tendersOf(database(), settlementId);

      expect(row).toMatchObject({ status: "VOIDED", voidReason: "Wrong card terminal", voidedByUserId: scenario.settleManager.userId });
      expect(row!.voidedAt).not.toBeNull();
      expect(await codeOf(complete(scenario, settlementId))).toBe("SETTLEMENT_NOT_BALANCED");
    });

    it("refuses anything that looks like a card number, in the service and the database", async () => {
      const order = await sentOrder(database(), scenario, ["20.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

      expect(
        await codeOf(
          tender(database(), scenario.cashier, settlementId, {
            tenderType: "EXTERNAL_CARD",
            amount: "20.00",
            externalReference: "4111111111111111",
          }),
        ),
      ).toBe("CARD_DATA_REFUSED");

      const recorded = await tender(database(), scenario.cashier, settlementId, { tenderType: "EXTERNAL_CARD", amount: "5.00" });

      expect(
        await codeOf(
          database().execute(
            sql`UPDATE settlement_tenders SET authorization_reference = '4111111111111111' WHERE id = ${recorded.tenderId}`,
          ),
        ),
      ).toMatch(/^DB:/);
      expect(
        await codeOf(
          database().execute(sql`UPDATE settlement_tenders SET card_last_four = '12345' WHERE id = ${recorded.tenderId}`),
        ),
      ).toMatch(/^DB:/);
    });

    it("has no column for a card number, CVV, track data or PIN", async () => {
      const columns = await database().execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name IN ('settlement_tenders', 'order_settlements')`,
      );
      const names = [...columns].map((row) => row.column_name).join(" ");

      expect(names).not.toMatch(/pan|cvv|cvc|track|pin|card_number|account_number|routing/);
    });
  });

  describe("idempotency and concurrency", () => {
    it("records one tender for a retried key", async () => {
      const order = await sentOrder(database(), scenario, ["30.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
      const key = newKey();
      const input = { idempotencyKey: key, expectedVersion: 1, amount: "10.00", receivedAmount: "10.00" };
      const first = await tender(database(), scenario.cashier, settlementId, input);
      const again = await tender(database(), scenario.cashier, settlementId, input);

      expect(again).toEqual({ ...first, replayed: true });
      expect(await tendersOf(database(), settlementId)).toHaveLength(1);
      expect((await settlementRow(database(), settlementId)).tenderedAmount).toBe("10.00");
      expect(
        await codeOf(tender(database(), scenario.cashier, settlementId, { ...input, amount: "11.00", receivedAmount: "11.00" })),
      ).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("lets only one of two terminals take the last $50", async () => {
      const order = await sentOrder(database(), scenario, ["50.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
      const attempt = () =>
        tender(database(), scenario.cashier, settlementId, {
          expectedVersion: 1,
          tenderType: "EXTERNAL_CARD",
          amount: "50.00",
        });
      const results = await Promise.allSettled([attempt(), attempt()]);

      expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      expect(
        results.flatMap((entry) => (entry.status === "rejected" ? [(entry.reason as AppError).code] : [])),
      ).toEqual(["CONCURRENCY_CONFLICT"]);

      // B reloads and tries again: the recheck under the lock refuses over-settlement.
      expect(
        await codeOf(tender(database(), scenario.cashier, settlementId, { tenderType: "EXTERNAL_CARD", amount: "50.00" })),
      ).toBe("AMOUNT_EXCEEDS_REMAINING");
      expect((await settlementRow(database(), settlementId)).tenderedAmount).toBe("50.00");
    });

    it("closes the order once when two terminals complete together", async () => {
      const order = await sentOrder(database(), scenario, ["9.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

      await tender(database(), scenario.cashier, settlementId, { amount: "9.00", receivedAmount: "10.00" });

      const { version } = await settlementRow(database(), settlementId);
      const finish = () =>
        completeSettlement(database(), scenario.cashier, settlementId, { expectedVersion: version, idempotencyKey: newKey() });
      const results = await Promise.allSettled([finish(), finish()]);

      expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      expect((await orderHistory(database(), order.id)).filter((entry) => entry.status === "CLOSED")).toHaveLength(1);
    });

    it("replays a retried completion without closing twice", async () => {
      const order = await sentOrder(database(), scenario, ["9.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

      await tender(database(), scenario.cashier, settlementId, { amount: "9.00", receivedAmount: "9.00" });

      const key = newKey();
      const { version } = await settlementRow(database(), settlementId);
      const first = await completeSettlement(database(), scenario.cashier, settlementId, { expectedVersion: version, idempotencyKey: key });
      const again = await completeSettlement(database(), scenario.cashier, settlementId, { expectedVersion: version, idempotencyKey: key });

      expect(again).toEqual({ ...first, replayed: true });
      expect((await orderHistory(database(), order.id)).filter((entry) => entry.status === "CLOSED")).toHaveLength(1);
      expect((await settlementHistory(database(), settlementId)).filter((entry) => entry.status === "COMPLETED")).toHaveLength(1);
      expect(
        await database().select().from(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, key)),
      ).toHaveLength(1);
    });

    it("refuses a stale settlement version", async () => {
      const order = await sentOrder(database(), scenario, ["9.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

      await tender(database(), scenario.cashier, settlementId, { amount: "4.00", receivedAmount: "4.00" });

      expect(
        await codeOf(tender(database(), scenario.cashier, settlementId, { expectedVersion: 1, amount: "5.00", receivedAmount: "5.00" })),
      ).toBe("CONCURRENCY_CONFLICT");
    });
  });

  describe("completion rules", () => {
    it("closes a fully comped order with a zero-amount settlement and no tender", async () => {
      const order = await sentOrder(database(), scenario, ["14.00", "6.00"]);
      const comp = await createDiscountDefinition(database(), scenario.manager, {
        code: uniqueCode("COMP"),
        name: "Manager comp",
        scope: "ORDER",
        discountType: "PERCENTAGE",
        value: "100",
      });

      await applyOrderDiscount(database(), scenario.manager, order.id, {
        discountDefinitionId: comp.id,
        reason: "Long wait",
        expectedVersion: (await orderRow(database(), order.id)).version,
      });

      const { settlementId, orderAmountSnapshot } = await openSettlement(database(), scenario.cashier, order.id);
      const view = await getOrderSettlementView(database(), scenario.cashier, order.id);

      expect(orderAmountSnapshot).toBe("0.00");
      expect(view.order.fullyComped).toBe(true);
      expect(view.eligibility.canComplete).toBe(true);
      expect(await codeOf(tender(database(), scenario.cashier, settlementId, { amount: "0.00", receivedAmount: "0.00" }))).toBe(
        "INVALID_AMOUNT",
      );

      const done = await complete(scenario, settlementId);

      expect(done).toMatchObject({ zeroAmount: true, orderStatus: "CLOSED", tenderedAmount: "0.00" });
      expect(await tendersOf(database(), settlementId)).toHaveLength(0);
      expect((await settlementHistory(database(), settlementId)).at(-1)).toMatchObject({
        status: "COMPLETED",
        reason: "Zero-amount order",
      });

      const [discount] = await database().select().from(orderDiscounts).where(eq(orderDiscounts.orderId, order.id));

      expect(discount).toMatchObject({ isComp: true, appliedAmount: "20.00", status: "APPLIED" });
    });

    it("refuses completion while draft items remain", async () => {
      const order = await sentOrder(database(), scenario, ["5.00"], { drafts: ["2.00"] });
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

      await tender(database(), scenario.cashier, settlementId, { amount: "5.00", receivedAmount: "5.00" });

      expect(await codeOf(complete(scenario, settlementId))).toBe("DRAFT_ITEMS_PRESENT");
      expect((await orderRow(database(), order.id)).status).toBe("OPEN");
    });

    it("locks the order amount while a settlement is OPEN", async () => {
      const order = await sentOrder(database(), scenario, ["5.00"], { drafts: ["2.00"] });
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
      const { version } = await orderRow(database(), order.id);
      const comp = await createDiscountDefinition(database(), scenario.manager, {
        code: uniqueCode("OFF"),
        name: "Dollar off",
        scope: "ORDER",
        discountType: "FIXED_AMOUNT",
        value: "1.00",
      });

      expect(
        await codeOf(sendOrderItems(database(), scenario.cashier, order.id, { expectedVersion: version, idempotencyKey: newKey() })),
      ).toBe("SETTLEMENT_IN_PROGRESS");
      expect(
        await codeOf(
          applyOrderDiscount(database(), scenario.manager, order.id, {
            discountDefinitionId: comp.id,
            reason: "Test",
            expectedVersion: version,
          }),
        ),
      ).toBe("SETTLEMENT_IN_PROGRESS");
      expect(
        await codeOf(voidOrder(database(), scenario.manager, order.id, { reason: "x", expectedVersion: version, dispositions: {} })),
      ).toBe("SETTLEMENT_IN_PROGRESS");
      expect(
        await codeOf(database().execute(sql`UPDATE orders SET status = 'VOIDED' WHERE id = ${order.id}`)),
      ).toMatch(/^DB:/);

      // Cancelling (with no recorded tender) unlocks it, and a new settlement takes a new snapshot.
      await cancelSettlement(database(), scenario.cashier, settlementId, { expectedVersion: 1, reason: "Guest added dessert" });

      const sent = await sendOrderItems(database(), scenario.cashier, order.id, { expectedVersion: version, idempotencyKey: newKey() });
      const reopened = await openSettlement(database(), scenario.cashier, order.id);

      expect(sent.itemIds).toHaveLength(1);
      expect(reopened.orderAmountSnapshot).toBe("7.00");
      expect((await settlementRow(database(), settlementId)).status).toBe("CANCELLED");
    });

    it("cancels only with no recorded tender left", async () => {
      const order = await sentOrder(database(), scenario, ["8.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
      const recorded = await tender(database(), scenario.cashier, settlementId, { amount: "3.00", receivedAmount: "3.00" });

      expect(
        await codeOf(cancelSettlement(database(), scenario.cashier, settlementId, { expectedVersion: recorded.settlementVersion, reason: "x" })),
      ).toBe("TENDERS_RECORDED");

      const voided = await voidTender(database(), scenario.settleManager, settlementId, recorded.tenderId, {
        expectedVersion: recorded.settlementVersion,
        reason: "Wrong order",
      });

      await cancelSettlement(database(), scenario.cashier, settlementId, { expectedVersion: voided.settlementVersion, reason: "Restart" });

      const row = await settlementRow(database(), settlementId);

      expect(row).toMatchObject({ status: "CANCELLED", cancelReason: "Restart", cancelledByUserId: scenario.cashier.userId });
      expect((await settlementHistory(database(), settlementId)).map((entry) => entry.status)).toEqual(["OPEN", "CANCELLED"]);
      expect((await orderRow(database(), order.id)).status).toBe("OPEN");
    });

    it("keeps COMPLETED and CLOSED terminal", async () => {
      const order = await sentOrder(database(), scenario, ["4.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
      const recorded = await tender(database(), scenario.cashier, settlementId, { amount: "4.00", receivedAmount: "4.00" });

      await complete(scenario, settlementId);

      const { version } = await settlementRow(database(), settlementId);

      expect(await codeOf(tender(database(), scenario.cashier, settlementId, { amount: "1.00", receivedAmount: "1.00" }))).toBe(
        "SETTLEMENT_NOT_OPEN",
      );
      expect(
        await codeOf(voidTender(database(), scenario.settleManager, settlementId, recorded.tenderId, { expectedVersion: version, reason: "x" })),
      ).toBe("SETTLEMENT_NOT_OPEN");
      expect(await codeOf(cancelSettlement(database(), scenario.cashier, settlementId, { expectedVersion: version, reason: "x" }))).toBe(
        "SETTLEMENT_NOT_OPEN",
      );
      expect(await codeOf(openSettlement(database(), scenario.cashier, order.id))).toBe("ORDER_NOT_OPEN");
      // Database guards: no reopen, no edit, no delete.
      expect(await codeOf(database().execute(sql`UPDATE orders SET status = 'OPEN', closed_at = NULL WHERE id = ${order.id}`))).toMatch(/^DB:/);
      expect(await codeOf(database().execute(sql`UPDATE order_settlements SET status = 'OPEN' WHERE id = ${settlementId}`))).toMatch(/^DB:/);
      expect(await codeOf(database().execute(sql`UPDATE settlement_tenders SET amount = 1 WHERE id = ${recorded.tenderId}`))).toMatch(/^DB:/);
      expect(await codeOf(database().execute(sql`DELETE FROM settlement_tenders WHERE id = ${recorded.tenderId}`))).toMatch(/^DB:/);
      expect(await codeOf(database().execute(sql`DELETE FROM order_settlements WHERE id = ${settlementId}`))).toMatch(/^DB:/);
      expect(await codeOf(database().execute(sql`DELETE FROM settlement_status_history WHERE settlement_id = ${settlementId}`))).toMatch(/^DB:/);
    });

    it("refuses closing an order without a completed settlement (no close bypass)", async () => {
      const order = await sentOrder(database(), scenario, ["4.00"]);

      expect(
        await codeOf(database().execute(sql`UPDATE orders SET status = 'CLOSED', closed_at = now() WHERE id = ${order.id}`)),
      ).toMatch(/^DB:/);
    });

    it("commits settlement completion and order closure together, or neither", async () => {
      const order = await sentOrder(database(), scenario, ["6.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

      await tender(database(), scenario.cashier, settlementId, { amount: "6.00", receivedAmount: "6.00" });

      // A deliberate failure at order closure, after the settlement row has been updated.
      await database().execute(sql.raw(`
        CREATE FUNCTION test_fail_close() RETURNS trigger AS $$
        BEGIN
          IF NEW.status = 'CLOSED' AND NEW.id = '${order.id}' THEN
            RAISE EXCEPTION 'forced failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER test_fail_close_trigger BEFORE UPDATE ON orders
          FOR EACH ROW EXECUTE FUNCTION test_fail_close();
      `));

      try {
        expect(await codeOf(complete(scenario, settlementId))).toMatch(/^DB:/);
      } finally {
        await database().execute(sql.raw(`DROP TRIGGER test_fail_close_trigger ON orders; DROP FUNCTION test_fail_close();`));
      }

      expect((await settlementRow(database(), settlementId)).status).toBe("OPEN");
      expect((await orderRow(database(), order.id)).status).toBe("OPEN");
      expect((await settlementHistory(database(), settlementId)).map((entry) => entry.status)).toEqual(["OPEN"]);
      expect((await orderHistory(database(), order.id)).map((entry) => entry.status)).toEqual(["OPEN"]);

      // Nothing was left behind, so the same command now succeeds.
      expect((await complete(scenario, settlementId)).orderStatus).toBe("CLOSED");
    });
  });

  it("writes settlement and order.closed outbox events with identifiers only", async () => {
    const order = await sentOrder(database(), scenario, ["3.00"]);
    const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

    await tender(database(), scenario.cashier, settlementId, { amount: "3.00", receivedAmount: "5.00" });
    await complete(scenario, settlementId);

    const events = await database().execute<{ event_type: string; payload: Record<string, unknown> }>(
      sql`SELECT event_type, payload FROM outbox_events WHERE payload->>'settlementId' = ${settlementId} ORDER BY sequence`,
    );

    expect([...events].map((row) => row.event_type)).toEqual([
      "settlement.opened",
      "settlement.tender-recorded",
      "settlement.completed",
      "order.closed",
    ]);
    expect(JSON.stringify([...events].map((row) => row.payload))).not.toMatch(/3\.00|5\.00|2\.00/);
  });

  it("stores no tender row for a refused request", async () => {
    const order = await sentOrder(database(), scenario, ["3.00"]);
    const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

    await codeOf(tender(database(), scenario.cashier, settlementId, { amount: "9.00", receivedAmount: "9.00" }));

    expect(await database().select().from(settlementTenders).where(eq(settlementTenders.settlementId, settlementId))).toHaveLength(0);
  });
});
