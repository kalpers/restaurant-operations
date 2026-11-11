import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import { ROLE_CATALOG } from "@/modules/auth/role-catalog";
import type { Actor } from "@/modules/auth/types";
import { getOrderSettlementView } from "@/modules/settlements/queries/settlement-queries";
import {
  cancelSettlement,
  openSettlement,
  voidTender,
} from "@/modules/settlements/services/settlement-service";
import { TENDER_PERMISSIONS, TENDER_TYPES } from "@/modules/settlements/types";
import { AppError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";

import { actorWith } from "../../fixtures/employee-fixtures";
import { clearOrderData, newKey } from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  sentOrder,
  settlementRow,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : "DB";
  }

  return undefined;
}

const tenderFields = {
  CASH: { receivedAmount: "1.00" },
  EXTERNAL_CARD: {},
  GIFT_CARD: {},
  HOUSE_ACCOUNT: {},
  OTHER: { otherDescription: "Voucher" },
} as const;

describe("settlement authorization", () => {
  let scenario: SettlementScenario;
  let without: (code: PermissionCode) => Promise<Actor>;

  beforeAll(async () => {
    scenario = await createSettlementScenario(database());
    without = (code) =>
      actorWith(
        database(),
        scenario,
        ["orders.view", "settlements.view", "settlements.create", "settlements.complete", "settlements.void-tender", ...Object.values(TENDER_PERMISSIONS)].filter(
          (entry) => entry !== code,
        ) as PermissionCode[],
      );
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function openFor(amount = "10.00") {
    const order = await sentOrder(database(), scenario, [amount]);
    const { settlementId } = await openSettlement(database(), scenario.settleManager, order.id);

    return { orderId: order.id, settlementId };
  }

  it("lets a view-only user see a settlement and nothing more", async () => {
    const { orderId, settlementId } = await openFor();
    const viewer = scenario.settlementViewer;
    const view = await getOrderSettlementView(database(), viewer, orderId);

    expect(view.current?.id).toBe(settlementId);
    expect(await codeOf(openSettlement(database(), viewer, orderId))).toBe("PERMISSION_DENIED");
    expect(await codeOf(tender(database(), viewer, settlementId, { amount: "1.00", receivedAmount: "1.00" }))).toBe(
      "PERMISSION_DENIED",
    );
    expect(
      await codeOf(completeSettlement(database(), viewer, settlementId, { expectedVersion: 1, idempotencyKey: newKey() })),
    ).toBe("PERMISSION_DENIED");
    expect(await codeOf(cancelSettlement(database(), viewer, settlementId, { expectedVersion: 1, reason: "x" }))).toBe(
      "PERMISSION_DENIED",
    );
  });

  it("needs settlements.view to see one", async () => {
    const { orderId } = await openFor();

    expect(await codeOf(getOrderSettlementView(database(), scenario.viewOnly, orderId))).toBe("PERMISSION_DENIED");
  });

  it("needs settlements.create to open or cancel", async () => {
    const { orderId, settlementId } = await openFor();
    const actor = await without("settlements.create");
    const other = await sentOrder(database(), scenario, ["2.00"]);

    expect(await codeOf(openSettlement(database(), actor, other.id))).toBe("PERMISSION_DENIED");
    expect(await codeOf(cancelSettlement(database(), actor, settlementId, { expectedVersion: 1, reason: "x" }))).toBe(
      "PERMISSION_DENIED",
    );
    expect(orderId).toBeTruthy();
  });

  it.each(TENDER_TYPES)("needs its own permission to record %s", async (tenderType) => {
    const { settlementId } = await openFor();
    const actor = await without(TENDER_PERMISSIONS[tenderType]);
    const input = { tenderType, amount: "1.00", ...tenderFields[tenderType] };

    expect(await codeOf(tender(database(), actor, settlementId, input))).toBe("PERMISSION_DENIED");
    expect((await tender(database(), scenario.settleManager, settlementId, input)).tenderStatus).toBe("RECORDED");
  });

  it("needs settlements.complete to complete", async () => {
    const { settlementId } = await openFor("1.00");

    await tender(database(), scenario.settleManager, settlementId, { amount: "1.00", receivedAmount: "1.00" });

    const { version } = await settlementRow(database(), settlementId);
    const actor = await without("settlements.complete");

    expect(
      await codeOf(completeSettlement(database(), actor, settlementId, { expectedVersion: version, idempotencyKey: newKey() })),
    ).toBe("PERMISSION_DENIED");
  });

  it("needs settlements.void-tender to void, which servers don't hold", async () => {
    const { settlementId } = await openFor();
    const recorded = await tender(database(), scenario.cashier, settlementId, { amount: "1.00", receivedAmount: "1.00" });

    expect(
      await codeOf(
        voidTender(database(), scenario.cashier, settlementId, recorded.tenderId, {
          expectedVersion: recorded.settlementVersion,
          reason: "x",
        }),
      ),
    ).toBe("PERMISSION_DENIED");
  });

  it("shows references and card metadata only with settlements.view-card-metadata", async () => {
    const { orderId, settlementId } = await openFor();

    await tender(database(), scenario.cashier, settlementId, {
      tenderType: "EXTERNAL_CARD",
      amount: "4.00",
      cardBrand: "Visa",
      cardLastFour: "4242",
      authorizationReference: "OK123",
    });

    const asServer = await getOrderSettlementView(database(), scenario.cashier, orderId);
    const asManager = await getOrderSettlementView(database(), scenario.settleManager, orderId);

    expect(asServer.current!.tenders[0]!.reference).toBeNull();
    expect(asManager.current!.tenders[0]!.reference).toMatchObject({ cardBrand: "Visa", cardLastFour: "4242" });
    expect(JSON.stringify(asServer)).not.toContain("4242");
  });

  it("scopes everything to the actor's location", async () => {
    const { orderId, settlementId } = await openFor();
    const other = scenario.managerAtB;

    expect(await codeOf(getOrderSettlementView(database(), other, orderId))).toBe("NOT_FOUND");
    expect(await codeOf(tender(database(), other, settlementId, { expectedVersion: 1, amount: "1.00", receivedAmount: "1.00" }))).toBe(
      "NOT_FOUND",
    );
    expect(
      await codeOf(completeSettlement(database(), other, settlementId, { expectedVersion: 1, idempotencyKey: newKey() })),
    ).toBe("NOT_FOUND");
  });

  it("grants the approved Phase 11 settlement codes by role", () => {
    const codesOf = (role: string) =>
      ROLE_CATALOG.find((entry) => entry.code === role)!.permissions.filter((code) => code.startsWith("settlements."));
    const server = [
      "settlements.view",
      "settlements.create",
      "settlements.tender.cash",
      "settlements.tender.external-card",
      "settlements.tender.gift-card",
      "settlements.complete",
    ];

    expect([...codesOf("SERVER")].sort()).toEqual([...server].sort());
    expect([...codesOf("BARTENDER")].sort()).toEqual([...server].sort());
    // Phase 17 added settlements.refund and settlements.refund-void (managers and up).
    expect(codesOf("MANAGER")).toHaveLength(12);
    expect(codesOf("GENERAL_MANAGER")).toHaveLength(12);
    expect(codesOf("OWNER")).toHaveLength(12);

    for (const role of ["HOST", "COOK", "WAIT_STAFF", "INVENTORY_MANAGER"]) {
      expect(codesOf(role)).toEqual([]);
    }
  });
});
