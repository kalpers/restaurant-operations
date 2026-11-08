import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryBalances, inventoryCounts, inventoryTransactions } from "@/db/schema";
import { reconcileBalances } from "@/modules/inventory/queries/stock-queries";
import {
  approveCount,
  cancelCount,
  getCount,
  recordCountLine,
  startCount,
  submitCount,
} from "@/modules/inventory/services/count-service";
import { AuthorizationError } from "@/shared/errors/app-error";

import { actorWith } from "../../fixtures/employee-fixtures";
import {
  createInventoryScenario,
  post,
  stockedItem,
  type InventoryScenario,
} from "../../fixtures/inventory-fixtures";

const database = () => getDatabase();

describe("inventory counts", () => {
  let scenario: InventoryScenario;

  beforeEach(async () => {
    scenario = await createInventoryScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function itemWith(onHand: string) {
    const item = await stockedItem(database(), scenario.admin, { baseUnitId: scenario.units.each });

    await post(database(), scenario.admin, {
      inventoryItemId: item.id,
      type: "RECEIVE",
      quantity: onHand,
      unitOfMeasureId: scenario.units.each,
      incomingTotalCost: onHand,
    });

    return item;
  }

  const balanceOf = async (inventoryItemId: string) =>
    (await database().select().from(inventoryBalances).where(eq(inventoryBalances.inventoryItemId, inventoryItemId)))[0];

  async function countOf(items: { id: string }[]) {
    const count = await startCount(database(), scenario.admin, {
      name: "Fixture count",
      inventoryItemIds: items.map((item) => item.id),
    });

    return getCount(database(), scenario.admin, count.id);
  }

  async function enterAndSubmit(
    detail: Awaited<ReturnType<typeof countOf>>,
    counted: Record<string, string>,
  ) {
    for (const line of detail.lines) {
      await recordCountLine(database(), scenario.admin, detail.count.id, line.id, {
        countedQuantity: counted[line.inventoryItemId] ?? null,
        notes: null,
        expectedVersion: line.version,
      });
    }

    return submitCount(database(), scenario.admin, detail.count.id, detail.count.version);
  }

  it("snapshots expected quantities and moves nothing until approval", async () => {
    const short = await itemWith("10");
    const over = await itemWith("10");
    const exact = await itemWith("10");
    const detail = await countOf([short, over, exact]);

    expect(detail.count.status).toBe("DRAFT");
    expect(detail.lines.map((line) => line.expectedQuantity)).toEqual(["10.0000", "10.0000", "10.0000"]);

    const submitted = await enterAndSubmit(detail, { [short.id]: "8", [over.id]: "12", [exact.id]: "10" });

    expect((await balanceOf(short.id))?.quantityOnHand).toBe("10.0000");

    const after = await getCount(database(), scenario.admin, detail.count.id);
    const variances = Object.fromEntries(after.lines.map((line) => [line.inventoryItemId, line.varianceQuantity]));

    expect(variances).toEqual({ [short.id]: "-2.0000", [over.id]: "2.0000", [exact.id]: "0.0000" });

    const approved = await approveCount(database(), scenario.admin, detail.count.id, {
      expectedVersion: submitted.version,
      acknowledgeActivity: false,
    });

    expect(approved).toMatchObject({ status: "APPROVED", activityAcknowledgedAt: null });
    expect((await balanceOf(short.id))?.quantityOnHand).toBe("8.0000");
    expect((await balanceOf(over.id))?.quantityOnHand).toBe("12.0000");
    expect((await balanceOf(exact.id))?.quantityOnHand).toBe("10.0000");

    const postings = await database()
      .select({ type: inventoryTransactions.transactionType, delta: inventoryTransactions.baseQuantityDelta })
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.referenceId, detail.count.id));

    expect(postings.sort((a, b) => a.type.localeCompare(b.type))).toEqual([
      { type: "COUNT_DECREASE", delta: "-2.0000" },
      { type: "COUNT_INCREASE", delta: "2.0000" },
    ]);
    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);
  });

  it("can't be approved twice, while a draft, or with a missing quantity", async () => {
    const item = await itemWith("5");
    const detail = await countOf([item]);

    await expect(
      approveCount(database(), scenario.admin, detail.count.id, { expectedVersion: detail.count.version, acknowledgeActivity: false }),
    ).rejects.toMatchObject({ code: "COUNT_NOT_SUBMITTED" });

    const missing = await submitCount(database(), scenario.admin, detail.count.id, detail.count.version);

    await expect(
      approveCount(database(), scenario.admin, detail.count.id, { expectedVersion: missing.version, acknowledgeActivity: false }),
    ).rejects.toMatchObject({ code: "COUNT_INCOMPLETE" });

    const second = await countOf([item]);
    const submitted = await enterAndSubmit(second, { [item.id]: "5" });
    const approved = await approveCount(database(), scenario.admin, second.count.id, {
      expectedVersion: submitted.version,
      acknowledgeActivity: false,
    });

    await expect(
      approveCount(database(), scenario.admin, second.count.id, { expectedVersion: approved.version, acknowledgeActivity: false }),
    ).rejects.toMatchObject({ code: "COUNT_NOT_SUBMITTED" });
  });

  it("rejects a stale version", async () => {
    const item = await itemWith("5");
    const detail = await countOf([item]);
    const submitted = await enterAndSubmit(detail, { [item.id]: "4" });

    await expect(
      approveCount(database(), scenario.admin, detail.count.id, { expectedVersion: submitted.version - 1, acknowledgeActivity: false }),
    ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
  });

  it("needs acknowledgement when stock moved after the snapshot, and posts against current stock", async () => {
    const item = await itemWith("10");
    const detail = await countOf([item]);

    // While the count is open, 3 more arrive. Stock isn't frozen.
    await post(database(), scenario.admin, {
      inventoryItemId: item.id,
      type: "RECEIVE",
      quantity: "3",
      unitOfMeasureId: scenario.units.each,
      incomingTotalCost: "3",
    });

    const open = await getCount(database(), scenario.admin, detail.count.id);

    expect(open.lines[0]?.activitySinceSnapshot).toBe(true);

    const submitted = await enterAndSubmit(open, { [item.id]: "9" });

    await expect(
      approveCount(database(), scenario.admin, detail.count.id, { expectedVersion: submitted.version, acknowledgeActivity: false }),
    ).rejects.toMatchObject({ code: "COUNT_ACTIVITY_UNACKNOWLEDGED" });

    const approved = await approveCount(database(), scenario.admin, detail.count.id, {
      expectedVersion: submitted.version,
      acknowledgeActivity: true,
    });

    expect(approved.activityAcknowledgedByUserId).toBe(scenario.admin.userId);
    expect(approved.activityAcknowledgedAt).not.toBeNull();
    // Variance -1 (9 counted vs 10 expected) is posted against current 13: 12, not 9.
    expect((await balanceOf(item.id))?.quantityOnHand).toBe("12.0000");
  });

  it("refuses a decrease that would take current stock below zero", async () => {
    const item = await itemWith("10");
    const detail = await countOf([item]);

    await post(database(), scenario.admin, {
      inventoryItemId: item.id,
      type: "ADJUST_DECREASE",
      quantity: "9",
      unitOfMeasureId: scenario.units.each,
      reasonCode: "OTHER",
    });

    const submitted = await enterAndSubmit(await getCount(database(), scenario.admin, detail.count.id), { [item.id]: "5" });

    await expect(
      approveCount(database(), scenario.admin, detail.count.id, { expectedVersion: submitted.version, acknowledgeActivity: true }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    const [count] = await database().select().from(inventoryCounts).where(eq(inventoryCounts.id, detail.count.id));

    expect(count?.status).toBe("SUBMITTED");
  });

  it("can be cancelled, and then never approved", async () => {
    const item = await itemWith("5");
    const detail = await countOf([item]);
    const cancelled = await cancelCount(database(), scenario.admin, detail.count.id, detail.count.version);

    expect(cancelled.status).toBe("CANCELLED");
    await expect(
      recordCountLine(database(), scenario.admin, detail.count.id, detail.lines[0]!.id, {
        countedQuantity: "1",
        notes: null,
        expectedVersion: detail.lines[0]!.version,
      }),
    ).rejects.toMatchObject({ code: "COUNT_NOT_DRAFT" });
  });

  it("separates counting from approving", async () => {
    const item = await itemWith("5");
    const counter = await actorWith(database(), scenario, ["inventory.view", "inventory.count"]);
    const count = await startCount(database(), counter, { name: "Counter's count", inventoryItemIds: [item.id] });
    const detail = await getCount(database(), counter, count.id);

    await recordCountLine(database(), counter, count.id, detail.lines[0]!.id, {
      countedQuantity: "4",
      notes: null,
      expectedVersion: detail.lines[0]!.version,
    });

    const submitted = await submitCount(database(), counter, count.id, count.version);

    await expect(
      approveCount(database(), counter, count.id, { expectedVersion: submitted.version, acknowledgeActivity: false }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(startCount(database(), scenario.viewer, { name: "No", inventoryItemIds: null })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
