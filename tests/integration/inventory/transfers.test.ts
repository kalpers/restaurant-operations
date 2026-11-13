import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, inventoryBalances, inventoryTransactions, inventoryTransferLines, inventoryTransfers } from "@/db/schema";
import { reconcileBalances } from "@/modules/inventory/queries/stock-queries";
import {
  cancelTransfer,
  createTransfer,
  listTransfers,
  receiveTransfer,
  sendTransfer,
  TRANSFER_REFERENCE,
} from "@/modules/inventory/services/transfer-service";
import { AuthorizationError } from "@/shared/errors/app-error";

import { actorWith } from "../../fixtures/employee-fixtures";
import { createInventoryScenario, post, stockedItem, type InventoryScenario } from "../../fixtures/inventory-fixtures";
import { newKey } from "../../fixtures/order-fixtures";

const database = () => getDatabase();

describe("transfers between locations (Phase 23)", () => {
  let scenario: InventoryScenario;

  beforeEach(async () => {
    scenario = await createInventoryScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const onHand = async (inventoryItemId: string, locationId: string) => {
    const [row] = await database()
      .select({ quantity: inventoryBalances.quantityOnHand, cost: inventoryBalances.weightedAverageCost })
      .from(inventoryBalances)
      .where(and(eq(inventoryBalances.inventoryItemId, inventoryItemId), eq(inventoryBalances.locationId, locationId)));

    return row;
  };

  async function itemWith(quantity: string, totalCost: string) {
    const item = await stockedItem(database(), scenario.admin, {
      measurementType: "WEIGHT",
      baseUnitId: scenario.units.ozWeight,
      alsoAt: [scenario.adminAtB],
    });

    await post(database(), scenario.admin, {
      inventoryItemId: item.id,
      type: "RECEIVE",
      quantity,
      unitOfMeasureId: scenario.units.ozWeight,
      incomingTotalCost: totalCost,
    });

    return item;
  }

  const ledger = (transferId: string) =>
    database()
      .select({
        type: inventoryTransactions.transactionType,
        location: inventoryTransactions.locationId,
        delta: inventoryTransactions.baseQuantityDelta,
        reason: inventoryTransactions.reasonCode,
        totalCost: inventoryTransactions.totalCost,
      })
      .from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.referenceType, TRANSFER_REFERENCE), eq(inventoryTransactions.referenceId, transferId)))
      .orderBy(inventoryTransactions.sequence);

  it("sends, holds the stock in transit, and receives it in full at the frozen cost", async () => {
    const beef = await itemWith("100", "250");
    const cheese = await itemWith("50", "50");
    const draft = await createTransfer(database(), scenario.admin, {
      toLocationId: scenario.locationB,
      notes: "Friday run",
      lines: [
        { inventoryItemId: beef.id, quantity: "2", unitOfMeasureId: scenario.units.lb },
        { inventoryItemId: cheese.id, quantity: "10", unitOfMeasureId: scenario.units.ozWeight },
      ],
    });
    expect(draft.transferNumber).toMatch(/^TR-\d{6}$/);

    const sent = await sendTransfer(database(), scenario.admin, draft.id, { expectedVersion: draft.version, idempotencyKey: newKey() });
    expect(sent.status).toBe("SENT");
    expect((await onHand(beef.id, scenario.locationA))!.quantity).toBe("68.0000");
    expect(await onHand(beef.id, scenario.locationB)).toBeUndefined();

    // A later cost change at the sender doesn't change what travels.
    await post(database(), scenario.admin, {
      inventoryItemId: beef.id,
      type: "RECEIVE",
      quantity: "68",
      unitOfMeasureId: scenario.units.ozWeight,
      incomingTotalCost: "680",
    });

    const incoming = await listTransfers(database(), scenario.adminAtB);
    expect(incoming.find((row) => row.id === draft.id)).toMatchObject({ direction: "INCOMING", status: "SENT" });

    const received = await receiveTransfer(database(), scenario.adminAtB, draft.id, {
      expectedVersion: sent.version,
      idempotencyKey: newKey(),
      lines: null,
    });
    expect(received).toMatchObject({ status: "RECEIVED", shortLines: 0 });
    expect(await onHand(beef.id, scenario.locationB)).toEqual({ quantity: "32.0000", cost: "2.5000" });
    expect((await onHand(cheese.id, scenario.locationB))!.quantity).toBe("10.0000");

    const rows = await ledger(draft.id);
    expect(rows.map((row) => row.type)).toEqual(["TRANSFER_OUT", "TRANSFER_OUT", "TRANSFER_IN", "TRANSFER_IN"]);
    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);
  });

  it("records a short delivery as a TRANSFER_SHORTAGE decrease at the receiver", async () => {
    const beef = await itemWith("100", "100");
    const draft = await createTransfer(database(), scenario.admin, {
      toLocationId: scenario.locationB,
      notes: null,
      lines: [{ inventoryItemId: beef.id, quantity: "40", unitOfMeasureId: scenario.units.ozWeight }],
    });
    const sent = await sendTransfer(database(), scenario.admin, draft.id, { expectedVersion: draft.version, idempotencyKey: newKey() });
    const [line] = await database().select().from(inventoryTransferLines).where(eq(inventoryTransferLines.transferId, draft.id));

    await expect(
      receiveTransfer(database(), scenario.adminAtB, draft.id, {
        expectedVersion: sent.version,
        idempotencyKey: newKey(),
        lines: [{ lineId: line!.id, quantityReceived: "41" }],
      }),
    ).rejects.toMatchObject({ code: "OVER_RECEIVED" });

    const received = await receiveTransfer(database(), scenario.adminAtB, draft.id, {
      expectedVersion: sent.version,
      idempotencyKey: newKey(),
      lines: [{ lineId: line!.id, quantityReceived: "36" }],
    });
    expect(received.shortLines).toBe(1);
    expect((await onHand(beef.id, scenario.locationB))!.quantity).toBe("36.0000");

    const rows = await ledger(draft.id);
    expect(rows.map((row) => [row.type, row.delta, row.reason])).toEqual([
      ["TRANSFER_OUT", "-40.0000", null],
      ["TRANSFER_IN", "40.0000", null],
      ["ADJUST_DECREASE", "-4.0000", "TRANSFER_SHORTAGE"],
    ]);
    const [stored] = await database().select().from(inventoryTransferLines).where(eq(inventoryTransferLines.id, line!.id));
    expect(stored!.baseQuantityReceived).toBe("36.0000");
  });

  it("replays a retried send or receive without posting again", async () => {
    const beef = await itemWith("20", "20");
    const draft = await createTransfer(database(), scenario.admin, {
      toLocationId: scenario.locationB,
      notes: null,
      lines: [{ inventoryItemId: beef.id, quantity: "5", unitOfMeasureId: scenario.units.ozWeight }],
    });
    const sendKey = newKey();
    const first = await sendTransfer(database(), scenario.admin, draft.id, { expectedVersion: draft.version, idempotencyKey: sendKey });
    const again = await sendTransfer(database(), scenario.admin, draft.id, { expectedVersion: draft.version, idempotencyKey: sendKey });
    expect(again).toEqual(first);

    const receiveKey = newKey();
    await receiveTransfer(database(), scenario.adminAtB, draft.id, { expectedVersion: first.version, idempotencyKey: receiveKey, lines: null });
    await receiveTransfer(database(), scenario.adminAtB, draft.id, { expectedVersion: first.version, idempotencyKey: receiveKey, lines: null });

    expect((await ledger(draft.id)).map((row) => row.type)).toEqual(["TRANSFER_OUT", "TRANSFER_IN"]);
  });

  it("needs the permission at each side, and only the receiver can receive", async () => {
    const beef = await itemWith("20", "20");
    const viewer = await actorWith(database(), scenario, ["inventory.view"]);
    await expect(
      createTransfer(database(), viewer, {
        toLocationId: scenario.locationB,
        notes: null,
        lines: [{ inventoryItemId: beef.id, quantity: "1", unitOfMeasureId: scenario.units.ozWeight }],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const draft = await createTransfer(database(), scenario.admin, {
      toLocationId: scenario.locationB,
      notes: null,
      lines: [{ inventoryItemId: beef.id, quantity: "1", unitOfMeasureId: scenario.units.ozWeight }],
    });
    const sent = await sendTransfer(database(), scenario.admin, draft.id, { expectedVersion: draft.version, idempotencyKey: newKey() });

    // The sender's own location can't receive it.
    await expect(
      receiveTransfer(database(), scenario.admin, draft.id, { expectedVersion: sent.version, idempotencyKey: newKey(), lines: null }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("cancels only drafts, and keeps sent quantities frozen", async () => {
    const beef = await itemWith("20", "20");
    const first = await createTransfer(database(), scenario.admin, {
      toLocationId: scenario.locationB,
      notes: null,
      lines: [{ inventoryItemId: beef.id, quantity: "1", unitOfMeasureId: scenario.units.ozWeight }],
    });
    await cancelTransfer(database(), scenario.admin, first.id, first.version);
    const [cancelled] = await database().select().from(inventoryTransfers).where(eq(inventoryTransfers.id, first.id));
    expect(cancelled!.status).toBe("CANCELLED");

    const second = await createTransfer(database(), scenario.admin, {
      toLocationId: scenario.locationB,
      notes: null,
      lines: [{ inventoryItemId: beef.id, quantity: "1", unitOfMeasureId: scenario.units.ozWeight }],
    });
    expect(second.transferNumber).not.toBe(first.transferNumber);
    const sent = await sendTransfer(database(), scenario.admin, second.id, { expectedVersion: second.version, idempotencyKey: newKey() });
    await expect(cancelTransfer(database(), scenario.admin, second.id, sent.version)).rejects.toMatchObject({
      code: "TRANSFER_NOT_DRAFT",
    });
    // The guard trigger refuses changing a sent line, whatever the caller.
    await expect(
      database().update(inventoryTransferLines).set({ quantity: "2" }).where(eq(inventoryTransferLines.transferId, second.id)),
    ).rejects.toThrow();

    const actions = await database()
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, second.id));
    expect(actions.map((row) => row.action)).toEqual(["inventory.transfer-sent"]);
  });

  it("refuses sending what the receiver doesn't stock or the sender doesn't have", async () => {
    const onlyHere = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });
    await post(database(), scenario.admin, {
      inventoryItemId: onlyHere.id,
      type: "RECEIVE",
      quantity: "5",
      unitOfMeasureId: scenario.units.each,
      incomingTotalCost: "5",
    });
    const notStocked = await createTransfer(database(), scenario.admin, {
      toLocationId: scenario.locationB,
      notes: null,
      lines: [{ inventoryItemId: onlyHere.id, quantity: "1", unitOfMeasureId: scenario.units.each }],
    });
    await expect(
      sendTransfer(database(), scenario.admin, notStocked.id, { expectedVersion: notStocked.version, idempotencyKey: newKey() }),
    ).rejects.toMatchObject({ code: "ITEM_NOT_STOCKED_HERE" });

    const beef = await itemWith("3", "3");
    const tooMuch = await createTransfer(database(), scenario.admin, {
      toLocationId: scenario.locationB,
      notes: null,
      lines: [{ inventoryItemId: beef.id, quantity: "4", unitOfMeasureId: scenario.units.ozWeight }],
    });
    await expect(
      sendTransfer(database(), scenario.admin, tooMuch.id, { expectedVersion: tooMuch.version, idempotencyKey: newKey() }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect((await onHand(beef.id, scenario.locationA))!.quantity).toBe("3.0000");
  });
});
