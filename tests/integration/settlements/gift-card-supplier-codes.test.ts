import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, giftCards, idempotencyRecords } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { exportReportCsv, runReport } from "@/modules/reporting/services/report-service";
import {
  getGiftCardProgram,
  lookUpGiftCard,
  replaceGiftCardCode,
  sellGiftCard,
  updateGiftCardProgram,
  type SellGiftCardInput,
} from "@/modules/settlements/services/gift-card-service";
import { AppError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";
import { readLocationClock } from "@/modules/restaurant/services/access";

import { actorWith } from "../../fixtures/employee-fixtures";
import { clearOrderData, newKey } from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  MANAGER_SETTLEMENT_PERMISSIONS,
  SERVER_SETTLEMENT_PERMISSIONS,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";

// Phase 33 policies 13–15: codes printed by a card supplier, stored only as a hash and last
// four, and the unused-balance report with its dormancy period.

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : `DB:${(error as Error).message}`;
  }

  return undefined;
}

/** A fresh printed code: letters first, so never 13 digits in a row. Codes are unique everywhere. */
const printedCode = () => `SUP-${randomBytes(4).toString("hex").toUpperCase()}-X`;

describe("supplier gift card codes and unused balances (Phase 33)", () => {
  let scenario: SettlementScenario;
  let manager: Actor;
  let server: Actor;

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());
    manager = await actorWith(database(), scenario, [
      ...MANAGER_SETTLEMENT_PERMISSIONS,
      "gift-cards.view",
      "gift-cards.sell",
      "gift-cards.manage",
      "reports.view",
      "reports.settlements",
      "reports.export",
    ]);
    server = await actorWith(database(), scenario, [...SERVER_SETTLEMENT_PERMISSIONS, "gift-cards.view", "gift-cards.sell"]);

    const { version } = await getGiftCardProgram(database(), manager);

    await updateGiftCardProgram(database(), manager, { enabled: true, maxBalance: "500.00", expectedVersion: version });
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  const sell = (input: Partial<SellGiftCardInput> = {}) =>
    sellGiftCard(database(), server, { idempotencyKey: newKey(), amount: "30.00", tenderType: "EXTERNAL_CARD", ...input });

  it("sells a card with a printed code, finds it however the code is typed, and never stores or returns the code", async () => {
    const code = printedCode();
    const key = newKey();
    const sold = await sell({ supplierCode: code, idempotencyKey: key });

    expect(sold.code).toBeNull();

    const [row] = await database().select().from(giftCards).where(eq(giftCards.id, sold.card.id));

    expect(row).toMatchObject({ codeSource: "SUPPLIER", codeLastFour: code.replace(/-/g, "").slice(-4) });
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/);

    for (const typed of [code, code.toLowerCase(), code.replace(/-/g, " ")]) {
      expect((await lookUpGiftCard(database(), server, { code: typed })).id).toBe(sold.card.id);
    }

    // A reload by the printed code adds to the same card.
    const reloaded = await sell({ giftCardCode: code.toLowerCase(), amount: "10.00" });

    expect(reloaded).toMatchObject({ kind: "RELOADED", card: { id: sold.card.id, balance: "40.00" } });

    const stored = JSON.stringify([
      await database().select().from(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, key)),
      await database().select().from(auditEvents).where(eq(auditEvents.entityId, sold.card.id)),
    ]);

    expect(stored).not.toContain(code.replace(/-/g, ""));
    expect(stored).not.toContain(code);
    expect(stored).toContain('"codeSource":"SUPPLIER"');
  });

  it("refuses a code already on a card, a short or odd code, and anything with 13 digits in a row", async () => {
    const code = printedCode();

    await sell({ supplierCode: code });

    expect(await codeOf(sell({ supplierCode: code.toLowerCase() }))).toBe("GIFT_CARD_CODE_IN_USE");
    expect(await codeOf(sell({ supplierCode: "AB12" }))).toBe("INVALID_SUPPLIER_CODE");
    expect(await codeOf(sell({ supplierCode: "ABCD_EFGH_12" }))).toBe("INVALID_SUPPLIER_CODE");
    expect(await codeOf(sell({ supplierCode: "4111 1111 1111 1111" }))).toBe("LOOKS_LIKE_CARD_NUMBER");
    expect(await codeOf(sell({ supplierCode: printedCode(), giftCardCode: code }))).toBe("SUPPLIER_CODE_NEW_CARD_ONLY");
  });

  it("replaces a lost card's code with a printed one, and the old code stops working", async () => {
    const generated = await sell();
    const replacement = printedCode();
    const card = await lookUpGiftCard(database(), manager, { code: generated.code! });
    const replaced = await replaceGiftCardCode(database(), manager, card.id, {
      reason: "Lost card",
      expectedVersion: card.version,
      supplierCode: replacement,
    });

    expect(replaced.code).toBeNull();
    expect((await lookUpGiftCard(database(), server, { code: replacement })).id).toBe(card.id);
    expect(await codeOf(lookUpGiftCard(database(), server, { code: generated.code! }))).toBe("GIFT_CARD_NOT_FOUND");
  });

  it("lists balances unused for the dormancy period, organization-wide, without codes", async () => {
    const code = printedCode();
    const sold = await sell({ supplierCode: code });
    const today = (await readLocationClock(database(), scenario.locationA, new Date())).businessDate;
    const program = await getGiftCardProgram(database(), manager);

    await updateGiftCardProgram(database(), manager, {
      enabled: true,
      maxBalance: program.maxBalance,
      dormancyMonths: 12,
      expectedVersion: program.version,
    });
    expect(await codeOf(updateGiftCardProgram(database(), manager, {
      enabled: true,
      maxBalance: program.maxBalance,
      dormancyMonths: 6,
      expectedVersion: program.version + 1,
    }))).toBe("INVALID_DORMANCY");

    const unusedAt = async (to: string) => {
      const report = await runReport(database(), manager, "settlements", { locationId: scenario.locationA, from: to, to });

      return report.sections.find((section) => section.key === "giftCardUnused")!;
    };
    const yearOn = addDays(today, 370);

    expect((await unusedAt(addDays(today, 300))).rows.map((row) => row.cardNumber)).not.toContain(sold.card.cardNumber);

    const unused = await unusedAt(yearOn);

    expect(unused.title).toBe("Unused gift card balances (all locations)");
    expect(unused.rows).toContainEqual(
      expect.objectContaining({ cardNumber: sold.card.cardNumber, balance: "30.00", lastActivity: today, firstSold: today, monthsInactive: 12 }),
    );

    const csv = await exportReportCsv(database(), manager, "settlements", { locationId: scenario.locationA, from: yearOn, to: yearOn });

    expect(csv.csv).toContain(sold.card.cardNumber);
    expect(csv.csv).not.toContain(code.replace(/-/g, ""));
  });
});
