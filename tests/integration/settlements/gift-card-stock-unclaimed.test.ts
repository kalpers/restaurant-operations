import { randomBytes } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  auditEvents,
  giftCardEntries,
  giftCardEscheatments,
  giftCardPurchasers,
  giftCards,
  giftCardStockBatches,
  idempotencyRecords,
} from "@/db/schema";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";
import { exportHolderReport, exportSalesJournal } from "@/modules/reporting/services/export-service";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { clearPurchaser, getPurchaser, savePurchaser } from "@/modules/settlements/services/gift-card-purchaser-service";
import {
  getGiftCardProgram,
  listGiftCards,
  lookUpGiftCard,
  replaceGiftCardCode,
  sellGiftCard,
  setGiftCardStatus,
  updateGiftCardProgram,
  type SellGiftCardInput,
} from "@/modules/settlements/services/gift-card-service";
import { deactivateStock, listStockBatchCards, listStockBatches, registerStockBatch } from "@/modules/settlements/services/gift-card-stock-service";
import { reportGiftCardUnclaimed } from "@/modules/settlements/services/gift-card-unclaimed-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

import { actorWith } from "../../fixtures/employee-fixtures";
import { clearOrderData, newKey } from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  MANAGER_SETTLEMENT_PERMISSIONS,
  SERVER_SETTLEMENT_PERMISSIONS,
  sentOrder,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";

// Phase 34 policies 3–10: supplier card stock, purchaser details, the holder report and
// balances reported as unclaimed.

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : `DB:${(error as Error).message}`;
  }

  return undefined;
}

/** A fresh printed code: letters first, so never 13 digits in a row. */
const printedCode = () => `STK${randomBytes(5).toString("hex").toUpperCase()}`;

describe("gift card stock, purchasers and unclaimed balances (Phase 34)", () => {
  let scenario: SettlementScenario;
  let manager: Actor;
  let server: Actor;
  let viewer: Actor;

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());
    manager = await actorWith(database(), scenario, [
      ...MANAGER_SETTLEMENT_PERMISSIONS,
      "gift-cards.view",
      "gift-cards.sell",
      "gift-cards.manage",
      "gift-cards.purchaser.view",
      "reports.view",
      "reports.sales",
      "reports.settlements",
      "reports.export",
    ]);
    server = await actorWith(database(), scenario, [...SERVER_SETTLEMENT_PERMISSIONS, "gift-cards.view", "gift-cards.sell"]);
    viewer = await actorWith(database(), scenario, ["gift-cards.view", "gift-cards.manage", "reports.view", "reports.settlements", "reports.export"]);

    const { version } = await getGiftCardProgram(database(), manager);

    await updateGiftCardProgram(database(), manager, { enabled: true, maxBalance: "500.00", expectedVersion: version });
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  const sell = (input: Partial<SellGiftCardInput> = {}) =>
    sellGiftCard(database(), server, { idempotencyKey: newKey(), amount: "25.00", tenderType: "EXTERNAL_CARD", ...input });

  const register = (lines: string[], key = newKey()) =>
    registerStockBatch(database(), manager, { idempotencyKey: key, description: "Box from PrintCo", lines });

  describe("card stock", () => {
    it("registers a batch all or nothing, keeps only hashes, and a retry adds nothing", async () => {
      const codes = [printedCode(), printedCode(), printedCode()];
      const key = newKey();
      const batch = await register([`SN-1,${codes[0]}`, codes[1]!, codes[2]!.toLowerCase()], key);

      expect(batch).toMatchObject({ cardCount: 3, replayed: false });
      expect(batch.batchNumber).toMatch(/^GCB-\d{6}$/);

      const again = await register([`SN-1,${codes[0]}`, codes[1]!, codes[2]!.toLowerCase()], key);

      expect(again).toMatchObject({ batchId: batch.batchId, replayed: true });

      const cards = await database().select().from(giftCards).where(eq(giftCards.stockBatchId, batch.batchId));

      expect(cards).toHaveLength(3);
      expect(cards.every((card) => card.status === "STOCK" && card.issuedAt === null && card.balance === "0.00")).toBe(true);
      expect(cards.find((card) => card.printedSerial === "SN-1")).toBeDefined();

      const stored = JSON.stringify([
        await database().select().from(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, key)),
        await database().select().from(auditEvents).where(eq(auditEvents.entityId, batch.batchId)),
        await database().select().from(giftCardStockBatches).where(eq(giftCardStockBatches.id, batch.batchId)),
      ]);

      for (const code of codes) {
        expect(stored).not.toContain(code);
      }

      // One bad line refuses the whole list, by line number.
      const error = await register([printedCode(), "SHORT", codes[0]!]).catch((caught: AppError) => caught);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("STOCK_LIST_INVALID");
      expect((error as AppError).message).toContain("line 2");

      // A code already registered refuses the batch too.
      expect(await codeOf(register([printedCode(), codes[1]!]))).toBe("GIFT_CARD_CODE_IN_USE");
      expect((await listStockBatches(database(), manager)).filter((row) => row.id === batch.batchId)).toHaveLength(1);
    });

    it("sells a stock card by its printed code, and refuses it at the till before that", async () => {
      const code = printedCode();
      const { batchId } = await register([code]);

      expect(await codeOf(lookUpGiftCard(database(), server, { code }))).toBe("GIFT_CARD_NOT_SOLD");
      expect(await codeOf(sell({ giftCardCode: code }))).toBe("GIFT_CARD_NOT_SOLD");

      const sold = await sell({ supplierCode: code.toLowerCase() });

      expect(sold).toMatchObject({ kind: "ISSUED", card: { balance: "25.00", status: "ACTIVE" } });

      const [card] = await database().select().from(giftCards).where(eq(giftCards.id, sold.card.id));

      expect(card).toMatchObject({ stockBatchId: batchId, issuedLocationId: scenario.locationA, codeSource: "SUPPLIER" });
      expect((await listGiftCards(database(), manager)).map((row) => row.id)).toContain(sold.card.id);
      expect(await codeOf(sell({ supplierCode: code }))).toBe("GIFT_CARD_CODE_IN_USE");

      const [audit] = await database().select().from(auditEvents).where(eq(auditEvents.entityId, sold.card.id));

      expect(JSON.stringify(audit)).toContain('"fromStock":true');
    });

    it("with the stock setting on, refuses a printed code that isn't registered, at sale and replacement", async () => {
      const program = await getGiftCardProgram(database(), manager);

      await updateGiftCardProgram(database(), manager, {
        enabled: true,
        maxBalance: program.maxBalance,
        supplierStockRequired: true,
        expectedVersion: program.version,
      });

      expect(await codeOf(sell({ supplierCode: printedCode() }))).toBe("SUPPLIER_CODE_NOT_IN_STOCK");

      // Generated codes are unaffected.
      const generated = await sell();

      expect(generated.code).not.toBeNull();

      const card = await lookUpGiftCard(database(), manager, { code: generated.code! });

      expect(await codeOf(replaceGiftCardCode(database(), manager, card.id, {
        reason: "Lost",
        expectedVersion: card.version,
        supplierCode: printedCode(),
      }))).toBe("SUPPLIER_CODE_NOT_IN_STOCK");

      // A registered card's code can replace a lost one; that stock card gives it up.
      const stockCode = printedCode();
      const { batchId } = await register([stockCode]);
      const replaced = await replaceGiftCardCode(database(), manager, card.id, {
        reason: "Lost",
        expectedVersion: card.version,
        supplierCode: stockCode,
      });

      expect((await lookUpGiftCard(database(), server, { code: stockCode })).id).toBe(replaced.card.id);

      const [stock] = await listStockBatchCards(database(), manager, batchId);

      expect(stock).toMatchObject({ status: "INACTIVE", sold: false });
    });

    it("deactivates one unsold card or the rest of a batch, never a sold one", async () => {
      const codes = [printedCode(), printedCode(), printedCode()];
      const { batchId } = await register(codes);

      await sell({ supplierCode: codes[0] });

      const cards = await listStockBatchCards(database(), manager, batchId);
      const unsold = cards.find((card) => card.status === "STOCK")!;
      const sold = cards.find((card) => card.sold)!;

      expect(await codeOf(deactivateStock(database(), manager, batchId, { reason: "Damaged", cardId: sold.id }))).toBe("GIFT_CARD_NOT_IN_STOCK");
      expect(await deactivateStock(database(), manager, batchId, { reason: "Damaged", cardId: unsold.id, expectedVersion: unsold.version })).toEqual({
        deactivated: 1,
      });
      expect(await deactivateStock(database(), manager, batchId, { reason: "Box lost" })).toEqual({ deactivated: 1 });
      expect(await codeOf(deactivateStock(database(), manager, batchId, { reason: "Again" }))).toBe("GIFT_CARD_NOT_IN_STOCK");

      const [batch] = (await listStockBatches(database(), manager)).filter((row) => row.id === batchId);

      expect(batch).toMatchObject({ cardCount: 3, sold: 1, inStock: 0, deactivated: 2 });
      expect(await codeOf(sell({ supplierCode: codes[2] }))).toBe("GIFT_CARD_CODE_IN_USE");
      expect(await codeOf(setGiftCardStatus(database(), manager, unsold.id, { status: "ACTIVE", reason: "Oops", expectedVersion: unsold.version + 1 }))).toBe(
        "GIFT_CARD_NOT_SOLD",
      );
    });

    it("refuses stock registration and listing without gift-cards.manage", async () => {
      expect(await codeOf(registerStockBatch(database(), server, { idempotencyKey: newKey(), description: "Box", lines: [printedCode()] }))).toBe(
        "PERMISSION_DENIED",
      );
      expect(await codeOf(listStockBatches(database(), server))).toBe("PERMISSION_DENIED");
    });
  });

  describe("purchaser details", () => {
    const details = {
      name: "Pat Example",
      email: "pat@example.com",
      phone: "555 010 2000",
      addressLine1: "1 Main St",
      city: "Springfield",
      region: "IL",
      postalCode: "62701",
      country: "US",
    };

    it("records them at issue, shows them only with the permission, and never audits the values", async () => {
      const sold = await sell({ purchaser: details });
      const shown = await getPurchaser(database(), manager, sold.card.id);

      expect(shown).toMatchObject({ ...details, addressLine2: null, cleared: false });
      expect(await codeOf(getPurchaser(database(), viewer, sold.card.id))).toBe("PERMISSION_DENIED");

      const stored = JSON.stringify([
        await database().select().from(auditEvents).where(eq(auditEvents.entityId, sold.card.id)),
        await database().select().from(idempotencyRecords).where(eq(idempotencyRecords.actorUserId, server.userId)),
      ]);

      expect(stored).not.toContain("Pat Example");
      expect(stored).not.toContain("pat@example.com");
      expect(stored).toContain('"change":"ADDED"');

      expect(await codeOf(sell({ purchaser: { name: "4111111111111111" } }))).toBe("CARD_DATA_REFUSED");
    });

    it("is changed and cleared by a manager, and a cleared row stays cleared", async () => {
      const sold = await sell();
      const added = await savePurchaser(database(), manager, sold.card.id, { details: { name: "Sam Example" }, expectedVersion: null });

      expect(added).toMatchObject({ name: "Sam Example", version: 1 });

      const changed = await savePurchaser(database(), manager, sold.card.id, { details: { name: "Sam Q Example", city: "Paris" }, expectedVersion: 1 });

      expect(changed).toMatchObject({ name: "Sam Q Example", city: "Paris", version: 2 });

      const cleared = await clearPurchaser(database(), manager, sold.card.id, { expectedVersion: 2 });

      expect(cleared).toMatchObject({ name: null, city: null, cleared: true });
      expect(await codeOf(savePurchaser(database(), manager, sold.card.id, { details: { name: "Again" }, expectedVersion: 3 }))).toBe("PURCHASER_CLEARED");
      expect(await codeOf(database().delete(giftCardPurchasers).where(eq(giftCardPurchasers.giftCardId, sold.card.id)))).toMatch(/^DB:/);
    });
  });

  describe("unclaimed balances", () => {
    async function dormantCard(purchaser?: SellGiftCardInput["purchaser"]) {
      const sold = await sell({ purchaser: purchaser ?? null });
      const program = await getGiftCardProgram(database(), manager);

      await updateGiftCardProgram(database(), manager, {
        enabled: true,
        maxBalance: program.maxBalance,
        dormancyMonths: 12,
        expectedVersion: program.version,
      });

      return sold;
    }

    it("exports the holder report with purchaser details or UNKNOWN, only with the purchaser permission", async () => {
      const withDetails = await dormantCard({ name: "Lee Holder", addressLine1: "9 Elm Rd", city: "Austin", region: "TX", postalCode: "73301", country: "US" });
      const without = await sell();
      const today = (await readLocationClock(database(), scenario.locationA, new Date())).businessDate;
      const yearOn = addDays(today, 400);
      const auth = (await getUserAuthContext(database(), manager.userId))!;
      const { csv, fileName } = await exportHolderReport(database(), auth, { locationId: scenario.locationA, from: yearOn, to: yearOn });
      const lines = csv.trim().split("\r\n");

      expect(fileName).toBe(`gift-card-holder-report_${yearOn}.csv`);
      expect(lines[0]).toContain("owner_name");

      const row = lines.find((line) => line.startsWith(withDetails.card.cardNumber))!;

      expect(row).toContain("Lee Holder");
      expect(row).toContain("Austin");
      expect(lines.find((line) => line.startsWith(without.card.cardNumber))).toContain("UNKNOWN");

      const viewerAuth = (await getUserAuthContext(database(), viewer.userId))!;

      expect(await codeOf(exportHolderReport(database(), viewerAuth, { locationId: scenario.locationA, from: yearOn, to: yearOn }))).toBe("PERMISSION_DENIED");
      expect(await codeOf(exportHolderReport(database(), auth, { locationId: "ALL", from: yearOn, to: yearOn }))).toBe("EXPORT_ORGANIZATION_WIDE");
    });

    it("reports a balance as unclaimed once: zero balance, inactive card, a balanced journal", async () => {
      const sold = await dormantCard();
      const card = await lookUpGiftCard(database(), manager, { cardNumber: sold.card.cardNumber });
      const report = await reportGiftCardUnclaimed(database(), manager, card.id, {
        state: "il",
        filingReference: "IL-2026-0042",
        reportDate: "2026-11-01",
        expectedVersion: card.version,
      });

      expect(report).toMatchObject({ amount: "25.00", state: "IL", filingReference: "IL-2026-0042" });

      const [row] = await database().select().from(giftCards).where(eq(giftCards.id, card.id));

      expect(row).toMatchObject({ balance: "0.00", status: "INACTIVE", statusReason: "Reported as unclaimed" });

      const entries = await database().select().from(giftCardEntries).where(eq(giftCardEntries.giftCardId, card.id));

      expect(entries.filter((entry) => entry.kind === "ESCHEATED").map((entry) => entry.amount)).toEqual(["-25.00"]);
      expect(await database().select().from(giftCardEscheatments).where(eq(giftCardEscheatments.giftCardId, card.id))).toHaveLength(1);
      expect(await codeOf(reportGiftCardUnclaimed(database(), manager, card.id, {
        state: "IL",
        filingReference: "IL-2026-0043",
        reportDate: "2026-11-01",
        expectedVersion: row!.version,
      }))).toBe("GIFT_CARD_ALREADY_REPORTED");
      expect(await codeOf(database().delete(giftCardEscheatments).where(inArray(giftCardEscheatments.giftCardId, [card.id])))).toMatch(/^DB:/);

      const auth = (await getUserAuthContext(database(), manager.userId))!;
      const { csv } = await exportSalesJournal(database(), auth, { locationId: scenario.locationA, from: report.businessDate, to: report.businessDate });

      expect(csv).toContain("GIFT_CARD,ESCHEATED,25.00,0.00");
      expect(csv).toContain("UNCLAIMED_PROPERTY,PAYABLE,0.00,25.00");
    });

    it("refuses stock, a card on an open settlement, a bad state, and without gift-cards.manage", async () => {
      const { batchId } = await register([printedCode()]);
      const [stockRow] = await database().select().from(giftCards).where(eq(giftCards.stockBatchId, batchId));
      const input = { state: "IL", filingReference: "R-1", reportDate: "2026-11-01" };

      expect(await codeOf(reportGiftCardUnclaimed(database(), manager, stockRow!.id, { ...input, expectedVersion: stockRow!.version }))).toBe(
        "GIFT_CARD_NOT_SOLD",
      );

      const sold = await sell({ amount: "40.00" });
      const order = await sentOrder(database(), scenario, ["10.00"]);
      const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
      const cardCode = sold.code!;

      await tender(database(), scenario.cashier, settlementId, { tenderType: "GIFT_CARD", amount: "5.00", giftCardCode: cardCode, idempotencyKey: newKey() });

      const card = await lookUpGiftCard(database(), manager, { code: cardCode });

      expect(await codeOf(reportGiftCardUnclaimed(database(), manager, card.id, { ...input, expectedVersion: card.version }))).toBe(
        "GIFT_CARD_SETTLEMENT_OPEN",
      );
      expect(await codeOf(reportGiftCardUnclaimed(database(), manager, card.id, { ...input, state: "Illinois", expectedVersion: card.version }))).toBe(
        "INVALID_STATE",
      );
      expect(await codeOf(reportGiftCardUnclaimed(database(), server, card.id, { ...input, expectedVersion: card.version }))).toBe("PERMISSION_DENIED");
    });
  });
});
