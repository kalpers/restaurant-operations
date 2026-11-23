import { randomBytes } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getGiftCardCodeKey } from "@/config/gift-card-env";
import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, giftCards, idempotencyRecords, outboxEvents } from "@/db/schema";
import { runMaintenance } from "@/infrastructure/maintenance/run-maintenance";
import type { Actor } from "@/modules/auth/types";
import { canonicalGiftCardCode, keyedGiftCardCodeHash, legacyGiftCardCodeHash } from "@/modules/settlements/rules/gift-card-code";
import { rekeyLegacyGiftCardCodes } from "@/modules/settlements/services/gift-card-rekey-service";
import {
  getGiftCardProgram,
  lookUpGiftCard,
  replaceGiftCardCode,
  sellGiftCard,
  updateGiftCardProgram,
  type SellGiftCardInput,
} from "@/modules/settlements/services/gift-card-service";
import { registerStockBatch } from "@/modules/settlements/services/gift-card-stock-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";

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

// Phase 35: gift card codes are stored as a keyed hash (HMAC-SHA256 with GIFT_CARD_CODE_KEY),
// rows still in the plain SHA-256 form keep working until re-keyed, and re-keying is
// repeatable and safe beside a running app.

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : `DB:${(error as Error).message}`;
  }

  return undefined;
}

const printedCode = () => `KEY-${randomBytes(4).toString("hex").toUpperCase()}-X`;

describe("keyed gift card code hashes (Phase 35)", () => {
  let scenario: SettlementScenario;
  let manager: Actor;
  let server: Actor;

  beforeEach(async () => {
    // Old-form rows left by an earlier test would be counted by this one's re-key.
    await rekeyLegacyGiftCardCodes(database());
    scenario = await createSettlementScenario(database());
    manager = await actorWith(database(), scenario, [
      ...MANAGER_SETTLEMENT_PERMISSIONS,
      "gift-cards.view",
      "gift-cards.sell",
      "gift-cards.manage",
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

  async function cardRow(cardId: string) {
    const [row] = await database().select().from(giftCards).where(eq(giftCards.id, cardId));

    return row!;
  }

  /** Puts a card back in the pre-Phase 35 form: the plain SHA-256 of its code. */
  async function makeLegacy(cardId: string, code: string) {
    await database()
      .update(giftCards)
      .set({ codeHash: legacyGiftCardCodeHash(canonicalGiftCardCode(code)!), codeHashScheme: "SHA256" })
      .where(eq(giftCards.id, cardId));
  }

  const keyedOf = (code: string) => keyedGiftCardCodeHash(canonicalGiftCardCode(code)!, getGiftCardCodeKey());

  it("stores the keyed hash for generated and printed codes, never the plain SHA-256", async () => {
    const generated = await sell();
    const printed = printedCode();
    const supplier = await sell({ supplierCode: printed });

    for (const [cardId, code] of [
      [generated.card.id, generated.code!],
      [supplier.card.id, printed],
    ] as const) {
      const row = await cardRow(cardId);

      expect(row).toMatchObject({ codeHashScheme: "HMAC_SHA256", codeHash: keyedOf(code) });
      expect(row.codeHash).not.toBe(legacyGiftCardCodeHash(canonicalGiftCardCode(code)!));
    }

    const replaced = await replaceGiftCardCode(database(), manager, generated.card.id, {
      reason: "Lost",
      expectedVersion: (await cardRow(generated.card.id)).version,
    });

    expect(await cardRow(generated.card.id)).toMatchObject({ codeHashScheme: "HMAC_SHA256", codeHash: keyedOf(replaced.code!) });
  });

  it("finds, reloads, pays with and refuses reuse of a card still in the old form", async () => {
    const sold = await sell({ amount: "40.00" });
    const code = sold.code!;
    const printed = printedCode();
    const supplierCard = await sell({ supplierCode: printed });

    await makeLegacy(sold.card.id, code);
    await makeLegacy(supplierCard.card.id, printed);

    expect((await lookUpGiftCard(database(), server, { code: code.toLowerCase() })).id).toBe(sold.card.id);
    expect(await sell({ giftCardCode: code, amount: "10.00" })).toMatchObject({ kind: "RELOADED", card: { id: sold.card.id, balance: "50.00" } });

    const order = await sentOrder(database(), scenario, ["12.00"]);
    const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

    await tender(database(), scenario.cashier, settlementId, {
      tenderType: "GIFT_CARD",
      amount: "12.00",
      giftCardCode: code,
      idempotencyKey: newKey(),
    });

    expect((await cardRow(sold.card.id)).balance).toBe("38.00");

    // A printed code on an old-form card is still taken, at sale and in a stock batch.
    expect(await codeOf(sell({ supplierCode: printed.toLowerCase() }))).toBe("GIFT_CARD_CODE_IN_USE");
    expect(
      await codeOf(registerStockBatch(database(), manager, { idempotencyKey: newKey(), description: "Box", lines: [printedCode(), printed] })),
    ).toBe("GIFT_CARD_CODE_IN_USE");
  });

  it("re-keys old rows without their codes, keeps them working, and does nothing the second time", async () => {
    const sold = await sell();
    const code = sold.code!;

    await makeLegacy(sold.card.id, code);

    const before = await cardRow(sold.card.id);
    const first = await rekeyLegacyGiftCardCodes(database());

    expect(first.rekeyed).toBe(1);

    const after = await cardRow(sold.card.id);

    expect(after).toMatchObject({ codeHashScheme: "HMAC_SHA256", codeHash: keyedOf(code), version: before.version });
    expect((await lookUpGiftCard(database(), server, { code })).id).toBe(sold.card.id);
    expect(await rekeyLegacyGiftCardCodes(database())).toEqual({ rekeyed: 0, batches: 0 });

    const audits = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "settlements.gift-card-codes-rekeyed"), eq(auditEvents.organizationId, scenario.organizationId)));

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "SYSTEM", category: "SYSTEM", after: { cardsRekeyed: 1 } });
    expect(JSON.stringify(audits)).not.toContain(before.codeHash);
    expect(JSON.stringify(audits)).not.toContain(after.codeHash);
  });

  it("re-keys in batches and skips a card another transaction holds, picking it up later", async () => {
    const cards = await Promise.all([sell(), sell(), sell()]);

    for (const card of cards) {
      await makeLegacy(card.card.id, card.code!);
    }

    const held = cards[0]!.card.id;

    await database().transaction(async (transaction) => {
      await transaction.execute(sql`SELECT id FROM gift_cards WHERE id = ${held} FOR UPDATE`);

      const result = await rekeyLegacyGiftCardCodes(database(), { batchSize: 1 });

      expect(result).toEqual({ rekeyed: 2, batches: 2 });
    });

    expect((await cardRow(held)).codeHashScheme).toBe("SHA256");
    expect(await rekeyLegacyGiftCardCodes(database())).toEqual({ rekeyed: 1, batches: 1 });
    expect((await cardRow(held)).codeHash).toBe(keyedOf(cards[0]!.code!));
  });

  it("is also done by the hourly maintenance run", async () => {
    const sold = await sell();

    await makeLegacy(sold.card.id, sold.code!);

    const result = await runMaintenance(database(), new Date(), { notify: false });

    expect(result).toMatchObject({ skipped: false, giftCardCodesRekeyed: 1 });
    expect((await cardRow(sold.card.id)).codeHashScheme).toBe("HMAC_SHA256");
  });

  it("never puts a code or either of its hashes in audit, outbox or idempotency records", async () => {
    const printed = printedCode();
    const key = newKey();
    const sold = await sell({ supplierCode: printed, idempotencyKey: key });
    const canonical = canonicalGiftCardCode(printed)!;
    const stored = JSON.stringify([
      await database().select().from(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, key)),
      await database().select().from(auditEvents).where(eq(auditEvents.entityId, sold.card.id)),
      await database().select().from(outboxEvents).where(eq(outboxEvents.aggregateId, sold.card.id)),
    ]);

    for (const secret of [canonical, keyedOf(printed), legacyGiftCardCodeHash(canonical)]) {
      expect(stored).not.toContain(secret);
    }
  });
});
