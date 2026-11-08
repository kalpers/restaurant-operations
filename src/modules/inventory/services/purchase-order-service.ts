import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { nextVersion } from "@/db/helpers/versioning";
import {
  inventoryItems,
  locationSettings,
  purchaseOrderLines,
  purchaseOrderReceiptLines,
  purchaseOrderReceipts,
  purchaseOrders,
  supplierItems,
  suppliers,
  unitsOfMeasure,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { compareDecimals, isPositiveDecimal, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  assertTransition,
  formatPoNumber,
  lineTotal,
  orderTotal,
  remainingQuantity,
} from "../rules/purchasing";
import type { PurchaseOrderStatus } from "../types";
import { assertPermission } from "./access";
import { requireSupplier } from "./supplier-service";

// A purchase order is procurement intent. Nothing here posts stock: only receiving does.
// Lines snapshot the price, unit and conversion chosen, so later supplier edits never
// rewrite an order. There is no preferred supplier: every order names its supplier.

const quantity4 = (value: string, label: string) => {
  let result: string;

  try {
    result = toScale(value, 4);
  } catch {
    throw new BusinessRuleError("INVALID_QUANTITY", `${label} has at most four decimal places.`);
  }

  return result;
};

/** Locks a purchase order at the expected version, in the actor's location. */
export async function lockOrder(
  transaction: DatabaseTransaction,
  actor: Actor,
  purchaseOrderId: string,
  expectedVersion: number | null,
) {
  const [order] = await transaction
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.id, purchaseOrderId),
        eq(purchaseOrders.organizationId, actor.organizationId),
        eq(purchaseOrders.locationId, actor.locationId),
      ),
    )
    .for("update");

  if (!order) {
    throw new NotFoundError("purchase order");
  }

  if (expectedVersion !== null && order.version !== expectedVersion) {
    throw new ConcurrencyError("purchase order", purchaseOrderId);
  }

  return { ...order, status: order.status as PurchaseOrderStatus };
}

export async function bumpOrder(
  transaction: DatabaseTransaction,
  purchaseOrderId: string,
  values: Record<string, unknown> = {},
) {
  const [row] = await transaction
    .update(purchaseOrders)
    .set({ ...values, version: nextVersion(purchaseOrders.version), updatedAt: new Date() } as never)
    .where(eq(purchaseOrders.id, purchaseOrderId))
    .returning();

  return row!;
}

const assertDraft = (status: PurchaseOrderStatus) => {
  if (status !== "DRAFT") {
    throw new BusinessRuleError(
      "PO_NOT_DRAFT",
      "Only a draft purchase order can be edited.",
    );
  }
};

export async function listPurchaseOrders(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "purchasing.view");

  const orders = await executor
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      status: purchaseOrders.status,
      supplierName: suppliers.name,
      expectedAt: purchaseOrders.expectedAt,
      submittedAt: purchaseOrders.submittedAt,
      createdAt: purchaseOrders.createdAt,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(
      and(
        eq(purchaseOrders.organizationId, actor.organizationId),
        eq(purchaseOrders.locationId, actor.locationId),
      ),
    )
    .orderBy(desc(purchaseOrders.sequenceNumber));
  const totals = orders.length
    ? await executor
        .select({
          purchaseOrderId: purchaseOrderLines.purchaseOrderId,
          lineTotal: purchaseOrderLines.lineTotal,
        })
        .from(purchaseOrderLines)
        .where(inArray(purchaseOrderLines.purchaseOrderId, orders.map((order) => order.id)))
    : [];

  return orders.map((order) => ({
    ...order,
    total: orderTotal(
      totals.filter((line) => line.purchaseOrderId === order.id).map((line) => line.lineTotal),
    ),
  }));
}

/** Header, lines with ordered, received and remaining quantities, and receipts. */
export async function getPurchaseOrder(
  executor: DatabaseExecutor,
  actor: Actor,
  purchaseOrderId: string,
) {
  assertPermission(actor, "purchasing.view");

  const [order] = await executor
    .select({ order: purchaseOrders, supplierName: suppliers.name, supplierActive: suppliers.active })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(
      and(
        eq(purchaseOrders.id, purchaseOrderId),
        eq(purchaseOrders.organizationId, actor.organizationId),
        eq(purchaseOrders.locationId, actor.locationId),
      ),
    );

  if (!order) {
    throw new NotFoundError("purchase order");
  }

  const lines = await executor
    .select({
      line: purchaseOrderLines,
      itemName: inventoryItems.name,
      unitCode: unitsOfMeasure.code,
      supplierSku: supplierItems.supplierSku,
    })
    .from(purchaseOrderLines)
    .innerJoin(inventoryItems, eq(inventoryItems.id, purchaseOrderLines.inventoryItemId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, purchaseOrderLines.purchaseUnitId))
    .innerJoin(supplierItems, eq(supplierItems.id, purchaseOrderLines.supplierItemId))
    .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(purchaseOrderLines.createdAt));
  const received = await receivedByLine(executor, purchaseOrderId);
  const receipts = await executor
    .select()
    .from(purchaseOrderReceipts)
    .where(eq(purchaseOrderReceipts.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(purchaseOrderReceipts.receivedAt));
  const receiptLines = receipts.length
    ? await executor
        .select()
        .from(purchaseOrderReceiptLines)
        .where(inArray(purchaseOrderReceiptLines.receiptId, receipts.map((receipt) => receipt.id)))
    : [];

  return {
    order: { ...order.order, supplierName: order.supplierName, supplierActive: order.supplierActive },
    total: orderTotal(lines.map(({ line }) => line.lineTotal)),
    lines: lines.map(({ line, itemName, unitCode, supplierSku }) => {
      const receivedQuantity = received.get(line.id) ?? "0";

      return {
        ...line,
        itemName,
        unitCode,
        supplierSku,
        receivedQuantity: toScale(receivedQuantity, 4),
        remainingQuantity: toScale(remainingQuantity(line.orderedQuantity, receivedQuantity), 4),
      };
    }),
    receipts: receipts.map((receipt) => ({
      ...receipt,
      lines: receiptLines.filter((line) => line.receiptId === receipt.id),
    })),
  };
}

/** Cumulative received purchase-unit quantity per line, from immutable receipt lines. */
export async function receivedByLine(
  executor: DatabaseExecutor,
  purchaseOrderId: string,
): Promise<Map<string, string>> {
  const rows = await executor
    .select({
      lineId: purchaseOrderReceiptLines.purchaseOrderLineId,
      total: sql<string>`sum(${purchaseOrderReceiptLines.receivedQuantity})::text`,
    })
    .from(purchaseOrderReceiptLines)
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, purchaseOrderReceiptLines.purchaseOrderLineId))
    .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
    .groupBy(purchaseOrderReceiptLines.purchaseOrderLineId);

  return new Map(rows.map((row) => [row.lineId, row.total]));
}

/** A new draft for an explicitly chosen, active supplier, numbered per location. */
export async function createPurchaseOrder(
  database: Database,
  actor: Actor,
  input: { supplierId: string; expectedAt: Date | null; notes: string | null },
) {
  assertPermission(actor, "purchasing.manage");

  return withTransaction(database, async (transaction) => {
    const supplier = await requireSupplier(transaction, actor, input.supplierId);

    if (!supplier.active) {
      throw new BusinessRuleError("SUPPLIER_INACTIVE", "That supplier is inactive.");
    }

    // Numbers are allocated one at a time per location.
    await transaction
      .select({ locationId: locationSettings.locationId })
      .from(locationSettings)
      .where(eq(locationSettings.locationId, actor.locationId))
      .for("update");

    const [last] = await transaction
      .select({ value: sql<number | null>`max(${purchaseOrders.sequenceNumber})` })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.locationId, actor.locationId));
    const sequenceNumber = Number(last?.value ?? 0) + 1;
    const [row] = await transaction
      .insert(purchaseOrders)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        supplierId: supplier.id,
        sequenceNumber,
        poNumber: formatPoNumber(sequenceNumber),
        expectedAt: input.expectedAt,
        notes: input.notes,
        createdByUserId: actor.userId,
      })
      .returning();

    return row!;
  });
}

export async function updatePurchaseOrder(
  database: Database,
  actor: Actor,
  purchaseOrderId: string,
  input: { expectedAt: Date | null; notes: string | null; expectedVersion: number },
) {
  assertPermission(actor, "purchasing.manage");

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, purchaseOrderId, input.expectedVersion);

    assertDraft(order.status);

    return bumpOrder(transaction, purchaseOrderId, {
      expectedAt: input.expectedAt,
      notes: input.notes,
    });
  });
}

function priceOf(value: string | null) {
  if (value === null) {
    throw new BusinessRuleError(
      "PRICE_REQUIRED",
      "Enter a unit price: this supplier item has no listed cost.",
    );
  }

  let price: string;

  try {
    price = toScale(value, 4);
  } catch {
    throw new BusinessRuleError("INVALID_PRICE", "A price has at most four decimal places.");
  }

  if (compareDecimals(price, "0") < 0) {
    throw new BusinessRuleError("INVALID_PRICE", "A price can't be negative.");
  }

  return price;
}

/** Adds a line for one of this supplier's items, snapshotting its unit, conversion and price. */
export async function addPurchaseOrderLine(
  database: Database,
  actor: Actor,
  purchaseOrderId: string,
  input: {
    supplierItemId: string;
    orderedQuantity: string;
    unitPrice: string | null;
    expectedVersion: number;
  },
) {
  assertPermission(actor, "purchasing.manage");

  const orderedQuantity = quantity4(input.orderedQuantity, "The ordered quantity");

  if (!isPositiveDecimal(orderedQuantity)) {
    throw new BusinessRuleError("INVALID_QUANTITY", "Order a quantity greater than zero.");
  }

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, purchaseOrderId, input.expectedVersion);

    assertDraft(order.status);

    const [supplierItem] = await transaction
      .select()
      .from(supplierItems)
      .where(
        and(
          eq(supplierItems.id, input.supplierItemId),
          eq(supplierItems.supplierId, order.supplierId),
          eq(supplierItems.organizationId, actor.organizationId),
        ),
      );

    if (!supplierItem) {
      throw new NotFoundError("supplier item");
    }

    if (!supplierItem.active) {
      throw new BusinessRuleError("SUPPLIER_ITEM_INACTIVE", "That supplier item is inactive.");
    }

    const unitPrice = priceOf(input.unitPrice ?? supplierItem.lastUnitCost);
    const [line] = await transaction
      .insert(purchaseOrderLines)
      .values({
        purchaseOrderId,
        supplierItemId: supplierItem.id,
        inventoryItemId: supplierItem.inventoryItemId,
        purchaseUnitId: supplierItem.purchaseUnitId,
        baseUnitsPerPurchase: supplierItem.baseUnitsPerPurchase,
        orderedQuantity,
        unitPrice,
        lineTotal: lineTotal(orderedQuantity, unitPrice),
      })
      .onConflictDoNothing()
      .returning();

    if (!line) {
      throw new BusinessRuleError(
        "LINE_EXISTS",
        "That item is already on this order. Change its quantity instead.",
      );
    }

    await bumpOrder(transaction, purchaseOrderId);

    return line;
  });
}

export async function updatePurchaseOrderLine(
  database: Database,
  actor: Actor,
  purchaseOrderId: string,
  lineId: string,
  input: { orderedQuantity: string; unitPrice: string; expectedVersion: number },
) {
  assertPermission(actor, "purchasing.manage");

  const orderedQuantity = quantity4(input.orderedQuantity, "The ordered quantity");

  if (!isPositiveDecimal(orderedQuantity)) {
    throw new BusinessRuleError("INVALID_QUANTITY", "Order a quantity greater than zero.");
  }

  const unitPrice = priceOf(input.unitPrice);

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, purchaseOrderId, input.expectedVersion);

    assertDraft(order.status);

    const [line] = await transaction
      .update(purchaseOrderLines)
      .set({
        orderedQuantity,
        unitPrice,
        lineTotal: lineTotal(orderedQuantity, unitPrice),
        version: nextVersion(purchaseOrderLines.version),
        updatedAt: new Date(),
      })
      .where(
        and(eq(purchaseOrderLines.id, lineId), eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId)),
      )
      .returning();

    if (!line) {
      throw new NotFoundError("purchase order line");
    }

    await bumpOrder(transaction, purchaseOrderId);

    return line;
  });
}

/** Removes a line from a draft. Draft lines are intent, not history, so they may go. */
export async function removePurchaseOrderLine(
  database: Database,
  actor: Actor,
  purchaseOrderId: string,
  lineId: string,
  expectedVersion: number,
) {
  assertPermission(actor, "purchasing.manage");

  await withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, purchaseOrderId, expectedVersion);

    assertDraft(order.status);

    const removed = await transaction
      .delete(purchaseOrderLines)
      .where(
        and(eq(purchaseOrderLines.id, lineId), eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId)),
      )
      .returning({ id: purchaseOrderLines.id });

    if (removed.length === 0) {
      throw new NotFoundError("purchase order line");
    }

    await bumpOrder(transaction, purchaseOrderId);
  });
}

/** Commits ordered quantities and prices. It moves no stock. */
export async function submitPurchaseOrder(
  database: Database,
  actor: Actor,
  purchaseOrderId: string,
  expectedVersion: number,
  now: Date = new Date(),
) {
  assertPermission(actor, "purchasing.submit");

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, purchaseOrderId, expectedVersion);

    assertTransition(order.status, "SUBMITTED");

    const supplier = await requireSupplier(transaction, actor, order.supplierId);

    if (!supplier.active) {
      throw new BusinessRuleError("SUPPLIER_INACTIVE", "That supplier is inactive.");
    }

    const lines = await transaction
      .select({ active: supplierItems.active })
      .from(purchaseOrderLines)
      .innerJoin(supplierItems, eq(supplierItems.id, purchaseOrderLines.supplierItemId))
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));

    if (lines.length === 0) {
      throw new BusinessRuleError("PO_EMPTY", "Add at least one line before submitting.");
    }

    if (lines.some((line) => !line.active)) {
      throw new BusinessRuleError(
        "SUPPLIER_ITEM_INACTIVE",
        "A line uses a supplier item that is no longer active.",
      );
    }

    return bumpOrder(transaction, purchaseOrderId, {
      status: "SUBMITTED",
      submittedAt: now,
      submittedByUserId: actor.userId,
    });
  });
}

/** Stops further receiving. Stock already received stays received. */
export async function cancelPurchaseOrder(
  database: Database,
  actor: Actor,
  purchaseOrderId: string,
  input: { reason: string | null; expectedVersion: number },
  now: Date = new Date(),
) {
  assertPermission(actor, "purchasing.submit");

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, purchaseOrderId, input.expectedVersion);

    assertTransition(order.status, "CANCELLED");

    return bumpOrder(transaction, purchaseOrderId, {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledByUserId: actor.userId,
      cancelReason: input.reason,
    });
  });
}
