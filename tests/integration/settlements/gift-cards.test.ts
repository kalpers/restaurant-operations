import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import { auditEvents, giftCardEntries, giftCards, giftCardSales, idempotencyRecords, outboxEvents } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import { exportSalesJournal } from "@/modules/reporting/services/export-service";
import { exportReportCsv, runReport } from "@/modules/reporting/services/report-service";
import {
  closeDrawerSession,
  createDrawer,
  getDrawerSetting,
  listDrawerSessions,
  openDrawerSession,
  setCashDrawerRequired,
} from "@/modules/settlements/services/drawer-service";
import {
  adjustGiftCard,
  cashOutGiftCard,
  getGiftCardHistory,
  getGiftCardProgram,
  lookUpGiftCard,
  replaceGiftCardCode,
  sellGiftCard,
  setGiftCardStatus,
  updateGiftCardProgram,
  voidGiftCardSale,
  type SellGiftCardInput,
} from "@/modules/settlements/services/gift-card-service";
import { recordRefund } from "@/workflows/record-refund/record-refund";
import { voidRefund } from "@/workflows/void-refund/void-refund";
import { openSettlement, voidTender } from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith } from "../../fixtures/employee-fixtures";
import { uniqueCode } from "../../fixtures/menu-fixtures";
import { baconCheeseburger, clearOrderData, ledgerFor, newKey, orderRow } from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  MANAGER_SETTLEMENT_PERMISSIONS,
  SERVER_SETTLEMENT_PERMISSIONS,
  sentOrder,
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
    if (error instanceof AppError) {
      return error.code;
    }

    return `DB:${readConstraintName(error) ?? (error as Error).message}`;
  }

  return undefined;
}

describe("gift cards (Phase 31)", () => {
  let scenario: SettlementScenario;
  let manager: Actor;
  let server: Actor;

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());
    manager = await actorWith(database(), scenario, [
      ...MANAGER_SETTLEMENT_PERMISSIONS,
      "drawers.view",
      "drawers.operate",
      "drawers.manage",
      "settlements.refund",
      "settlements.refund-void",
      "gift-cards.view",
      "gift-cards.sell",
      "gift-cards.manage",
      "reports.view",
      "reports.settlements",
      "reports.export",
      "reports.sales",
    ]);
    server = await actorWith(database(), scenario, [...SERVER_SETTLEMENT_PERMISSIONS, "gift-cards.view", "gift-cards.sell"]);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function enable(maxBalance = "500.00") {
    const { version } = await getGiftCardProgram(database(), manager);

    return updateGiftCardProgram(database(), manager, { enabled: true, maxBalance, expectedVersion: version });
  }

  function sell(actor: Actor, input: Partial<SellGiftCardInput> = {}) {
    return sellGiftCard(database(), actor, {
      idempotencyKey: newKey(),
      amount: "50.00",
      tenderType: "EXTERNAL_CARD",
      ...input,
    });
  }

  async function newCard(amount = "50.00") {
    const sold = await sell(server, { amount });

    return { ...sold, code: sold.code! };
  }

  async function cardRow(cardId: string) {
    const [row] = await database().select().from(giftCards).where(eq(giftCards.id, cardId));

    return row!;
  }

  function entriesOf(cardId: string) {
    return database()
      .select()
      .from(giftCardEntries)
      .where(eq(giftCardEntries.giftCardId, cardId))
      .orderBy(asc(giftCardEntries.sequence));
  }

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

  function payWithCard(settlementId: string, code: string, amount: string, key = newKey(), expectedVersion?: number) {
    return tender(database(), scenario.cashier, settlementId, {
      tenderType: "GIFT_CARD",
      amount,
      giftCardCode: code,
      idempotencyKey: key,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  }

  /** The ledger is the record: the card's balance equals the sum of its entries. */
  async function expectLedgerMatches(cardId: string) {
    const entries = await entriesOf(cardId);
    const total = entries.reduce((sum, entry) => sum + Math.round(Number(entry.amount) * 100), 0);

    expect((await cardRow(cardId)).balance).toBe((total / 100).toFixed(2));
    expect(entries.at(-1)?.balanceAfter ?? "0.00").toBe((await cardRow(cardId)).balance);
  }

  describe("program off", () => {
    it("records a gift card tender as before, with no card, and refuses selling or a code", async () => {
      const { settlementId } = await settlementFor("10.00");

      await tender(database(), scenario.cashier, settlementId, {
        tenderType: "GIFT_CARD",
        amount: "10.00",
        externalReference: "Paper certificate 12",
      });

      const [recorded] = await tendersOf(database(), settlementId);

      expect(recorded!.giftCardId).toBeNull();
      expect((await complete(settlementId)).replayed).toBe(false);
      expect(await codeOf(sell(server))).toBe("GIFT_CARDS_NOT_ENABLED");

      const other = await settlementFor("5.00");

      expect(await codeOf(payWithCard(other.settlementId, "7KQ2-M9XD-4TPA-W3HR", "5.00"))).toBe("GIFT_CARDS_NOT_ENABLED");
    });
  });

  describe("selling and reloading", () => {
    beforeEach(() => enable());

    it("issues a card, shows the code once and stores only its hash", async () => {
      const key = newKey();
      const sold = await sell(server, { idempotencyKey: key, amount: "50.00", tenderType: "CASH", receivedAmount: "60.00" });

      expect(sold.kind).toBe("ISSUED");
      expect(sold.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
      expect(sold.changeAmount).toBe("10.00");
      expect(sold.card.balance).toBe("50.00");
      expect(sold.card.cardNumber).toMatch(/^GC-\d{6}$/);

      const replay = await sell(server, { idempotencyKey: key, amount: "50.00", tenderType: "CASH", receivedAmount: "60.00" });

      expect(replay.replayed).toBe(true);
      expect(replay.code).toBeNull();
      expect(replay.saleId).toBe(sold.saleId);
      expect(await entriesOf(sold.card.id)).toHaveLength(1);

      // Neither the code, its hash nor its last four reach audit, outbox or idempotency rows.
      const card = await cardRow(sold.card.id);
      const plain = sold.code!.replace(/-/g, "");
      const stored = JSON.stringify([
        await database().select().from(auditEvents).where(eq(auditEvents.organizationId, scenario.organizationId)),
        await database().select().from(outboxEvents).where(eq(outboxEvents.organizationId, scenario.organizationId)),
        await database().select().from(idempotencyRecords).where(eq(idempotencyRecords.organizationId, scenario.organizationId)),
      ]);

      for (const secret of [sold.code!, plain, card.codeHash, `"${card.codeLastFour}"`]) {
        expect(stored).not.toContain(secret);
      }

      expect(card.codeHash).not.toContain(plain);

      const [soldAudit] = await database()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "settlements.gift-card-sold"), eq(auditEvents.entityId, sold.card.id)))
        .orderBy(asc(auditEvents.occurredAt));

      expect(soldAudit!.after).toMatchObject({ giftNumber: sold.card.cardNumber, amount: "50.00", kind: "ISSUED" });
    });

    it("reloads by code up to the maximum balance and refuses an inactive card", async () => {
      const issued = await newCard("50.00");
      const reloaded = await sell(server, { giftCardCode: issued.code.toLowerCase(), amount: "25.00" });

      expect(reloaded.kind).toBe("RELOADED");
      expect(reloaded.code).toBeNull();
      expect(reloaded.card.balance).toBe("75.00");
      expect(await codeOf(sell(server, { giftCardCode: issued.code, amount: "425.01" }))).toBe("GIFT_CARD_MAX_BALANCE");
      expect(await codeOf(sell(server, { amount: "0.50" }))).toBe("GIFT_CARD_SALE_TOO_SMALL");
      expect(await codeOf(sell(server, { giftCardCode: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" }))).toBe("GIFT_CARD_NOT_FOUND");

      await setGiftCardStatus(database(), manager, issued.card.id, {
        status: "INACTIVE",
        reason: "Reported stolen",
        expectedVersion: (await cardRow(issued.card.id)).version,
      });

      expect(await codeOf(sell(server, { giftCardCode: issued.code }))).toBe("GIFT_CARD_INACTIVE");
      await expectLedgerMatches(issued.card.id);
    });

    it("needs the payment method's tender permission and a drawer for cash where required", async () => {
      expect(await codeOf(sell(server, { tenderType: "OTHER", otherDescription: "Voucher" }))).toBe("PERMISSION_DENIED");

      const { version } = await getDrawerSetting(database(), manager);

      await setCashDrawerRequired(database(), manager, { required: true, expectedVersion: version });

      expect(await codeOf(sell(server, { tenderType: "CASH", receivedAmount: "50.00" }))).toBe("CASH_DRAWER_REQUIRED");
    });

    it("can't be turned off while a card holds a balance", async () => {
      await newCard("10.00");

      const program = await getGiftCardProgram(database(), manager);

      expect(program.outstandingBalance).toBe("10.00");
      expect(
        await codeOf(
          updateGiftCardProgram(database(), manager, { enabled: false, maxBalance: "500.00", expectedVersion: program.version }),
        ),
      ).toBe("GIFT_CARDS_OUTSTANDING");
    });
  });

  describe("paying with a card", () => {
    beforeEach(() => enable());

    it("takes the value at once, closes the check, and a retry writes nothing more", async () => {
      const card = await newCard("50.00");
      const { settlementId } = await settlementFor("30.00");
      const key = newKey();
      const { version } = await settlementRow(database(), settlementId);

      await payWithCard(settlementId, card.code, "30.00", key, version);
      expect((await cardRow(card.card.id)).balance).toBe("20.00");

      // The same request again, as a terminal would resend it.
      const replay = await payWithCard(settlementId, card.code, "30.00", key, version);

      expect(replay.replayed).toBe(true);
      expect((await entriesOf(card.card.id)).map((entry) => entry.kind)).toEqual(["ISSUED", "REDEEMED"]);
      expect((await complete(settlementId)).replayed).toBe(false);
      await expectLedgerMatches(card.card.id);
    });

    it("pays for the canonical Bacon Cheeseburger partly by card; a retried SEND adds nothing", async () => {
      const burger = await baconCheeseburger(database(), scenario);
      const order = await createOrder(database(), scenario.cashier, { orderType: "TAKEOUT" });
      const added = await addDraftItem(database(), scenario.cashier, order.id, {
        expectedVersion: order.version,
        menuItemId: burger.menuItem.id,
        quantity: 1,
        selections: burger.canonicalSelections,
        specialInstructions: null,
      });
      const send = { expectedVersion: added.orderVersion, idempotencyKey: newKey() };

      await sendOrderItems(database(), scenario.cashier, order.id, send);

      const beefMoves = (await ledgerFor(database(), burger.stock.beef.id)).length;

      expect((await sendOrderItems(database(), scenario.cashier, order.id, send)).replayed).toBe(true);
      expect(await ledgerFor(database(), burger.stock.beef.id)).toHaveLength(beefMoves);

      const card = await newCard("10.00");
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
      const due = (await orderRow(database(), order.id)).totalDue;

      await payWithCard(settlementId, card.code, "10.00");
      await tender(database(), scenario.cashier, settlementId, {
        amount: (Math.round(Number(due) * 100 - 1000) / 100).toFixed(2),
        receivedAmount: "100.00",
      });
      await complete(settlementId);

      expect((await orderRow(database(), order.id)).status).toBe("CLOSED");
      expect((await cardRow(card.card.id)).balance).toBe("0.00");
      expect(await ledgerFor(database(), burger.stock.beef.id)).toHaveLength(beefMoves);
    });

    it("splits a check between a card and cash", async () => {
      const card = await newCard("20.00");
      const { settlementId } = await settlementFor("32.50");

      expect(await codeOf(payWithCard(settlementId, card.code, "32.50"))).toBe("INSUFFICIENT_GIFT_CARD_BALANCE");
      await payWithCard(settlementId, card.code, "20.00");
      await tender(database(), scenario.cashier, settlementId, { amount: "12.50", receivedAmount: "20.00" });
      await complete(settlementId);

      expect((await cardRow(card.card.id)).balance).toBe("0.00");
    });

    it("refuses a wrong code, a missing code, an inactive card or a reference, writing nothing", async () => {
      const card = await newCard("50.00");
      const { settlementId } = await settlementFor("10.00");

      expect(await codeOf(payWithCard(settlementId, "ZZZZ-ZZZZ-ZZZZ-ZZZZ", "10.00"))).toBe("GIFT_CARD_NOT_FOUND");
      expect(await codeOf(payWithCard(settlementId, "not a code", "10.00"))).toBe("GIFT_CARD_NOT_FOUND");
      expect(
        await codeOf(tender(database(), scenario.cashier, settlementId, { tenderType: "GIFT_CARD", amount: "10.00" })),
      ).toBe("GIFT_CARD_CODE_REQUIRED");
      expect(
        await codeOf(
          tender(database(), scenario.cashier, settlementId, {
            tenderType: "GIFT_CARD",
            amount: "10.00",
            giftCardCode: card.code,
            externalReference: "X1",
          }),
        ),
      ).toBe("REFERENCE_NOT_ALLOWED");

      await setGiftCardStatus(database(), manager, card.card.id, {
        status: "INACTIVE",
        reason: "Lost",
        expectedVersion: (await cardRow(card.card.id)).version,
      });

      expect(await codeOf(payWithCard(settlementId, card.code, "10.00"))).toBe("GIFT_CARD_INACTIVE");
      expect(await tendersOf(database(), settlementId)).toHaveLength(0);
      expect(await entriesOf(card.card.id)).toHaveLength(1);
    });

    it("puts the value back when the tender is voided", async () => {
      const card = await newCard("50.00");
      const { settlementId } = await settlementFor("30.00");
      const paid = await payWithCard(settlementId, card.code, "30.00");

      await voidTender(database(), manager, settlementId, paid.tenderId, {
        expectedVersion: (await settlementRow(database(), settlementId)).version,
        reason: "Wrong card",
      });

      expect((await cardRow(card.card.id)).balance).toBe("50.00");
      expect((await entriesOf(card.card.id)).map((entry) => entry.kind)).toEqual(["ISSUED", "REDEEMED", "REDEMPTION_VOIDED"]);
      await expectLedgerMatches(card.card.id);
    });

    it("never lets two checks spend more than the card holds", async () => {
      const card = await newCard("20.00");
      const first = await settlementFor("15.00");
      const second = await settlementFor("15.00");
      const results = await Promise.allSettled([
        payWithCard(first.settlementId, card.code, "15.00"),
        payWithCard(second.settlementId, card.code, "15.00"),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

      const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;

      expect((failed.reason as AppError).code).toBe("INSUFFICIENT_GIFT_CARD_BALANCE");
      expect((await cardRow(card.card.id)).balance).toBe("5.00");
      await expectLedgerMatches(card.card.id);
    });
  });

  describe("refunds onto a card", () => {
    beforeEach(() => enable());

    it("goes back onto a card that paid the check, up to what it paid, and its void takes it off", async () => {
      const card = await newCard("50.00");
      const { orderId, settlementId } = await settlementFor("30.00");

      await payWithCard(settlementId, card.code, "20.00");
      await tender(database(), scenario.cashier, settlementId, { amount: "10.00", receivedAmount: "10.00" });
      await complete(settlementId);

      const refund = (amount: string, giftCardId: string | null = card.card.id) =>
        recordRefund(database(), manager, orderId, {
          idempotencyKey: newKey(),
          tenderType: "GIFT_CARD",
          amount,
          taxAmount: "0.00",
          reason: "Cold food",
          otherDescription: null,
          externalReference: null,
          giftCardId,
        });

      expect(await codeOf(refund("10.00", null))).toBe("GIFT_CARD_REQUIRED");

      const first = await refund("10.00");

      expect((await cardRow(card.card.id)).balance).toBe("40.00");
      // 20.00 of the check is still refundable, but only 10.00 more can go back onto the card.
      expect(await codeOf(refund("10.01"))).toBe("REFUND_EXCEEDS_GIFT_CARD");

      await voidRefund(database(), manager, first.refundId, { expectedVersion: 1, reason: "Entered twice" });

      expect((await cardRow(card.card.id)).balance).toBe("30.00");
      expect((await entriesOf(card.card.id)).map((entry) => entry.kind)).toEqual([
        "ISSUED",
        "REDEEMED",
        "REFUNDED",
        "REFUND_VOIDED",
      ]);
      await expectLedgerMatches(card.card.id);
    });

    it("refuses a gift card refund on a check no card paid", async () => {
      const { orderId, settlementId } = await settlementFor("12.00");

      await tender(database(), scenario.cashier, settlementId, { amount: "12.00", receivedAmount: "12.00" });
      await complete(settlementId);

      expect(
        await codeOf(
          recordRefund(database(), manager, orderId, {
            idempotencyKey: newKey(),
            tenderType: "GIFT_CARD",
            amount: "5.00",
            taxAmount: "0.00",
            reason: "Goodwill",
            otherDescription: null,
            externalReference: null,
          }),
        ),
      ).toBe("GIFT_CARD_REFUND_NOT_ALLOWED");
    });
  });

  describe("manager actions", () => {
    beforeEach(() => enable());

    it("voids an unspent sale and refuses one whose value was spent", async () => {
      const card = await newCard("40.00");
      const [sale] = await database().select().from(giftCardSales).where(eq(giftCardSales.id, card.saleId));

      expect(await codeOf(voidGiftCardSale(database(), server, card.saleId, { expectedVersion: sale!.version, reason: "x" }))).toBe(
        "PERMISSION_DENIED",
      );

      const voided = await voidGiftCardSale(database(), manager, card.saleId, { expectedVersion: sale!.version, reason: "Rang twice" });

      expect(voided.balance).toBe("0.00");

      const spent = await newCard("40.00");
      const { settlementId } = await settlementFor("1.00");

      await payWithCard(settlementId, spent.code, "1.00");

      const [spentSale] = await database().select().from(giftCardSales).where(eq(giftCardSales.id, spent.saleId));

      expect(
        await codeOf(voidGiftCardSale(database(), manager, spent.saleId, { expectedVersion: spentSale!.version, reason: "Oops" })),
      ).toBe("GIFT_CARD_SALE_SPENT");
    });

    it("cashes out through the drawer, which counts card sales and cash-outs", async () => {
      const { version } = await getDrawerSetting(database(), manager);

      await setCashDrawerRequired(database(), manager, { required: true, expectedVersion: version });

      const drawer = await createDrawer(database(), manager, { code: uniqueCode("DRW"), name: "Front" });
      const session = await openDrawerSession(database(), manager, drawer.id, { openingFloat: "100.00", idempotencyKey: newKey() });
      const card = await sell(manager, {
        amount: "25.00",
        tenderType: "CASH",
        receivedAmount: "25.00",
        cashDrawerSessionId: session.id,
      });

      expect(
        await codeOf(
          cashOutGiftCard(database(), manager, card.card.id, {
            idempotencyKey: newKey(),
            expectedVersion: (await cardRow(card.card.id)).version,
            reason: "Guest asked",
          }),
        ),
      ).toBe("CASH_DRAWER_REQUIRED");

      const out = await cashOutGiftCard(database(), manager, card.card.id, {
        idempotencyKey: newKey(),
        expectedVersion: (await cardRow(card.card.id)).version,
        reason: "Guest asked",
        cashDrawerSessionId: session.id,
      });

      expect(out.amount).toBe("25.00");
      expect(out.card.balance).toBe("0.00");

      const [summary] = await listDrawerSessions(database(), manager, { status: "OPEN" });

      expect(summary!.totals).toMatchObject({ giftCardSales: "25.00", giftCardCashOuts: "25.00", expected: "100.00" });

      const closed = await closeDrawerSession(database(), manager, session.id, {
        countedAmount: "100.00",
        closeNote: null,
        expectedVersion: summary!.version,
        idempotencyKey: newKey(),
      });

      expect(closed.variance).toBe("0.00");
    });

    it("adjusts within limits, deactivates and replaces a lost code", async () => {
      const card = await newCard("20.00");
      const version = () => cardRow(card.card.id).then((row) => row.version);

      expect(
        await codeOf(adjustGiftCard(database(), manager, card.card.id, { amount: "-20.01", reason: "x", expectedVersion: await version() })),
      ).toBe("INSUFFICIENT_GIFT_CARD_BALANCE");
      expect(
        await codeOf(adjustGiftCard(database(), server, card.card.id, { amount: "1.00", reason: "x", expectedVersion: await version() })),
      ).toBe("PERMISSION_DENIED");
      expect(
        (await adjustGiftCard(database(), manager, card.card.id, { amount: "5.00", reason: "Goodwill", expectedVersion: await version() }))
          .balance,
      ).toBe("25.00");
      expect(
        await codeOf(adjustGiftCard(database(), manager, card.card.id, { amount: "1.00", reason: "x", expectedVersion: 1 })),
      ).toBe("CONCURRENCY_CONFLICT");

      const replaced = await replaceGiftCardCode(database(), manager, card.card.id, {
        reason: "Guest lost the card",
        expectedVersion: await version(),
      });

      expect(replaced.code).not.toBe(card.code);
      expect(await codeOf(lookUpGiftCard(database(), server, { code: card.code }))).toBe("GIFT_CARD_NOT_FOUND");
      expect((await lookUpGiftCard(database(), server, { code: replaced.code })).balance).toBe("25.00");
      expect(await codeOf(lookUpGiftCard(database(), server, { cardNumber: replaced.card.cardNumber }))).toBe("PERMISSION_DENIED");
      expect((await lookUpGiftCard(database(), manager, { cardNumber: replaced.card.cardNumber })).id).toBe(card.card.id);

      const history = await getGiftCardHistory(database(), server, card.card.id);

      expect(history.entries.map((entry) => entry.kind)).toEqual(["ADJUSTED", "ISSUED"]);
      await expectLedgerMatches(card.card.id);
    });
  });

  describe("database guards", () => {
    beforeEach(() => enable());

    it("refuses changing or deleting ledger entries, deleting cards and moving a balance by hand", async () => {
      const card = await newCard("20.00");

      expect(await codeOf(database().execute(sql`UPDATE gift_card_entries SET amount = 99 WHERE gift_card_id = ${card.card.id}`))).toBe(
        "DB:gift_card_entries_append_only",
      );
      expect(await codeOf(database().execute(sql`DELETE FROM gift_card_entries WHERE gift_card_id = ${card.card.id}`))).toBe(
        "DB:gift_card_entries_append_only",
      );
      expect(await codeOf(database().execute(sql`UPDATE gift_cards SET balance = 99 WHERE id = ${card.card.id}`))).toBe(
        "DB:gift_cards_matches_ledger",
      );
      expect(await codeOf(database().execute(sql`DELETE FROM gift_cards WHERE id = ${card.card.id}`))).toBe(
        "DB:gift_cards_matches_ledger",
      );
      expect(
        await codeOf(database().execute(sql`UPDATE gift_card_sales SET amount = 1 WHERE id = ${card.saleId}`)),
      ).toBe("DB:gift_card_sales_frozen");
      await expectLedgerMatches(card.card.id);
    });
  });

  describe("reports and journal", () => {
    beforeEach(() => enable());

    it("shows movements and the outstanding balance, balances the journal, and never counts a card sale as sales", async () => {
      const card = await sell(manager, { amount: "50.00", tenderType: "EXTERNAL_CARD" });
      const { settlementId } = await settlementFor("30.00");

      await payWithCard(settlementId, card.code!, "30.00");
      await complete(settlementId);
      await adjustGiftCard(database(), manager, card.card.id, {
        amount: "-2.00",
        reason: "Correction",
        expectedVersion: (await cardRow(card.card.id)).version,
      });

      const [entry] = await entriesOf(card.card.id);
      const filters = { locationId: scenario.locationA, from: entry!.businessDate, to: entry!.businessDate };
      const report = await runReport(database(), manager, "settlements", filters);
      const movements = report.sections.find((section) => section.key === "giftCardMovements")!;
      const outstanding = report.sections.find((section) => section.key === "giftCardOutstanding")!;

      expect(movements.rows[0]).toMatchObject({ sold: "50.00", redeemed: "30.00", adjusted: "-2.00" });
      expect(outstanding.rows[0]).toMatchObject({ cards: 1, balance: "18.00" });

      const sales = await runReport(database(), manager, "sales", filters);
      const all = sales.sections.find((section) => section.key === "summary")!.rows.find((row) => row.orderType === "All")!;

      expect(all.netSales).toBe("30.00");

      const journal = (await exportSalesJournal(database(), (await getUserAuthContext(database(), manager.userId))!, filters)).csv;

      expect(journal).toContain("GIFT_CARD,ISSUED,0.00,50.00");
      expect(journal).toContain("GIFT_CARD,ADJUSTED,2.00,0.00");

      const csv = (await exportReportCsv(database(), manager, "settlements", filters, "giftCardBalances")).csv;
      const row = await cardRow(card.card.id);

      expect(csv).toContain(card.card.cardNumber);
      expect(csv).not.toContain(row.codeLastFour);
      expect(csv).not.toContain(card.code!);
    });
  });
});
