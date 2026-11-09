import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { orderItemModifiers, orderItems } from "@/db/schema";
import { withTransaction, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  resolveSellableItem,
  type SellableItem,
} from "@/modules/menu/queries/order-menu-facts";
import type { ProposedSelection } from "@/modules/menu/rules/modifier-selection";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import { lockOrder, recomputeAndBumpOrder } from "../repositories/order-repository";
import { assertItemIsDraft, assertOrderOpen } from "../rules/order-lifecycle";
import { calculateLineAmounts } from "../rules/order-totals";
import { assertPermission } from "./access";

// Draft items are previews: their price columns show what the item would cost now, and
// SEND re-resolves everything before freezing it. Drafts consume nothing, create no
// ticket, and can be edited or removed. Every change locks the order and checks its version.

export type DraftItemInput = {
  menuItemId: string;
  quantity: number;
  selections: ProposedSelection[];
  specialInstructions: string | null;
};

type Versioned = { id: string; version: number };

/** The columns a draft row holds, as previewed from the current menu. */
export function draftColumns(sellable: SellableItem, quantity: number) {
  const amounts = calculateLineAmounts(
    sellable.item.price,
    sellable.selections.map((entry) => entry.modifier.priceAdjustment),
    quantity,
  );

  return {
    menuItemCodeSnapshot: sellable.item.code,
    menuItemNameSnapshot: sellable.item.name,
    basePriceSnapshot: amounts.basePrice,
    modifierTotalSnapshot: amounts.modifierTotal,
    unitPriceSnapshot: amounts.unitPrice,
    lineTotalSnapshot: amounts.lineTotal,
  };
}

export function modifierRows(orderItemId: string, sellable: SellableItem) {
  return sellable.selections.map((selection, index) => ({
    orderItemId,
    modifierGroupId: selection.modifierGroupId,
    modifierId: selection.modifier.id,
    modifierGroupNameSnapshot: selection.modifierGroupName,
    modifierCodeSnapshot: selection.modifier.code,
    modifierNameSnapshot: selection.modifier.name,
    priceAdjustmentSnapshot: selection.modifier.priceAdjustment,
    preparationEffectTypeSnapshot: selection.modifier.preparationEffectType,
    preparationInstructionSnapshot: selection.modifier.preparationInstruction,
    sortOrder: index,
  }));
}

async function lockDraftItem(transaction: DatabaseTransaction, orderId: string, itemId: string) {
  const [item] = await transaction
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)))
    .for("update");

  if (!item) {
    throw new NotFoundError("order item");
  }

  assertItemIsDraft(item.status);

  return item;
}

function normalize(input: DraftItemInput): DraftItemInput {
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
    throw new BusinessRuleError("INVALID_QUANTITY", "Enter a whole quantity from 1 to 99.");
  }

  return { ...input, specialInstructions: input.specialInstructions?.trim() || null };
}

export async function addDraftItem(
  database: Database,
  actor: Actor,
  orderId: string,
  input: DraftItemInput & { expectedVersion: number },
): Promise<{ itemId: string; orderVersion: number }> {
  assertPermission(actor, "orders.edit");

  const entry = normalize(input);

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);

    const sellable = await resolveSellableItem(transaction, actor, {
      menuItemId: entry.menuItemId,
      selections: entry.selections,
      at: new Date(),
    });
    const [item] = await transaction
      .insert(orderItems)
      .values({
        orderId,
        menuItemId: entry.menuItemId,
        quantity: entry.quantity,
        specialInstructions: entry.specialInstructions,
        addedByUserId: actor.userId,
        ...draftColumns(sellable, entry.quantity),
      })
      .returning({ id: orderItems.id });

    if (sellable.selections.length > 0) {
      await transaction.insert(orderItemModifiers).values(modifierRows(item!.id, sellable));
    }

    const updated = await recomputeAndBumpOrder(transaction, orderId);

    return { itemId: item!.id, orderVersion: updated.version };
  });
}

export async function updateDraftItem(
  database: Database,
  actor: Actor,
  orderId: string,
  itemId: string,
  input: Omit<DraftItemInput, "menuItemId"> & { expectedVersion: number },
): Promise<Versioned> {
  assertPermission(actor, "orders.edit");

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);

    const item = await lockDraftItem(transaction, orderId, itemId);
    const entry = normalize({ ...input, menuItemId: item.menuItemId });
    const sellable = await resolveSellableItem(transaction, actor, {
      menuItemId: item.menuItemId,
      selections: entry.selections,
      at: new Date(),
    });

    await transaction.delete(orderItemModifiers).where(eq(orderItemModifiers.orderItemId, itemId));

    if (sellable.selections.length > 0) {
      await transaction.insert(orderItemModifiers).values(modifierRows(itemId, sellable));
    }

    await transaction
      .update(orderItems)
      .set({
        quantity: entry.quantity,
        specialInstructions: entry.specialInstructions,
        ...draftColumns(sellable, entry.quantity),
        version: sql`${orderItems.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(orderItems.id, itemId));

    const updated = await recomputeAndBumpOrder(transaction, orderId);

    return { id: orderId, version: updated.version };
  });
}

/** Removes a draft line outright. Drafts aren't history; sent items are voided instead. */
export async function removeDraftItem(
  database: Database,
  actor: Actor,
  orderId: string,
  itemId: string,
  input: { expectedVersion: number },
): Promise<Versioned> {
  assertPermission(actor, "orders.edit");

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);
    await lockDraftItem(transaction, orderId, itemId);
    await transaction.delete(orderItemModifiers).where(eq(orderItemModifiers.orderItemId, itemId));
    await transaction.delete(orderItems).where(eq(orderItems.id, itemId));

    const updated = await recomputeAndBumpOrder(transaction, orderId);

    return { id: orderId, version: updated.version };
  });
}
