import { and, asc, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { updateVersioned } from "@/db/helpers/versioned-update";
import { discountDefinitions, orderDiscounts, orderItemDiscounts, orderItems } from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { compareDecimals, significantScale, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";

import { lockOrder, recomputeAndBumpOrder } from "../repositories/order-repository";
import { assertOrderOpen } from "../rules/order-lifecycle";
import { isComp } from "../rules/order-totals";
import type { DiscountScope, DiscountType } from "../types";
import { actorHolds, assertPermission } from "./access";

// Discounts come only from configured definitions. Applying one snapshots its code, name,
// type and value with a reason and the actor, so later definition edits change nothing
// already applied. The applied amount is a projection the order recomputes whenever its
// SUBMITTED items change. Removal is recorded, never deleted. No tax is involved.

export type DiscountDefinitionInput = {
  code: string;
  name: string;
  scope: DiscountScope;
  discountType: DiscountType;
  value: string;
};

function assertValidValue(type: DiscountType, value: string) {
  if (significantScale(value) > 2 || compareDecimals(value, "0") <= 0) {
    throw new BusinessRuleError(
      "INVALID_DISCOUNT_VALUE",
      "Enter a value above zero with at most two decimal places.",
    );
  }

  if (type === "PERCENTAGE" && compareDecimals(value, "100") > 0) {
    throw new BusinessRuleError("INVALID_DISCOUNT_VALUE", "A percentage can't be more than 100.");
  }

  if (compareDecimals(value, "9999999999.99") > 0) {
    throw new BusinessRuleError("INVALID_DISCOUNT_VALUE", "That value is too large.");
  }
}

export async function listDiscountDefinitions(
  executor: DatabaseExecutor,
  actor: Actor,
  options: { includeInactive?: boolean } = {},
) {
  if (!actorHolds(actor, "orders.discount.manage")) {
    assertPermission(actor, "orders.discount.apply");
  }

  const includeInactive = options.includeInactive && actorHolds(actor, "orders.discount.manage");

  return executor
    .select({
      id: discountDefinitions.id,
      code: discountDefinitions.code,
      name: discountDefinitions.name,
      scope: discountDefinitions.scope,
      discountType: discountDefinitions.discountType,
      value: discountDefinitions.value,
      active: discountDefinitions.active,
      version: discountDefinitions.version,
    })
    .from(discountDefinitions)
    .where(
      and(
        eq(discountDefinitions.organizationId, actor.organizationId),
        includeInactive ? undefined : eq(discountDefinitions.active, true),
      ),
    )
    .orderBy(asc(discountDefinitions.name));
}

export async function createDiscountDefinition(
  database: Database,
  actor: Actor,
  input: DiscountDefinitionInput,
) {
  assertPermission(actor, "orders.discount.manage");
  assertValidValue(input.discountType, input.value);

  try {
    const [row] = await database
      .insert(discountDefinitions)
      .values({
        organizationId: actor.organizationId,
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        scope: input.scope,
        discountType: input.discountType,
        value: toScale(input.value, 2),
      })
      .returning({ id: discountDefinitions.id, version: discountDefinitions.version });

    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("DUPLICATE_CODE", "A discount with that code already exists.");
    }

    throw error;
  }
}

/** Changes apply to later applications only; applied snapshots never change. */
export async function updateDiscountDefinition(
  database: Database,
  actor: Actor,
  definitionId: string,
  input: { name: string; value: string; active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "orders.discount.manage");

  const [existing] = await database
    .select({ discountType: discountDefinitions.discountType })
    .from(discountDefinitions)
    .where(
      and(eq(discountDefinitions.id, definitionId), eq(discountDefinitions.organizationId, actor.organizationId)),
    );

  if (!existing) {
    throw new NotFoundError("discount");
  }

  assertValidValue(existing.discountType as DiscountType, input.value);

  const row = await updateVersioned(database, discountDefinitions, {
    id: definitionId,
    organizationId: actor.organizationId,
    expectedVersion: input.expectedVersion,
    values: { name: input.name.trim(), value: toScale(input.value, 2), active: input.active },
    label: "discount",
  });

  return { id: row.id, version: row.version };
}

async function requireActiveDefinition(
  transaction: DatabaseTransaction,
  actor: Actor,
  definitionId: string,
  scope: DiscountScope,
) {
  const [definition] = await transaction
    .select()
    .from(discountDefinitions)
    .where(
      and(eq(discountDefinitions.id, definitionId), eq(discountDefinitions.organizationId, actor.organizationId)),
    );

  if (!definition) {
    throw new NotFoundError("discount");
  }

  if (!definition.active) {
    throw new BusinessRuleError("DISCOUNT_INACTIVE", "That discount isn't active.");
  }

  if (definition.scope !== scope) {
    throw new BusinessRuleError(
      "DISCOUNT_SCOPE_MISMATCH",
      scope === "ITEM" ? "That discount applies to a whole order." : "That discount applies to one item.",
    );
  }

  return definition;
}

function snapshot(definition: typeof discountDefinitions.$inferSelect, actor: Actor, reason: string) {
  const trimmed = reason.trim();

  if (!trimmed) {
    throw new BusinessRuleError("REASON_REQUIRED", "Enter a reason for the discount.");
  }

  return {
    discountDefinitionId: definition.id,
    codeSnapshot: definition.code,
    nameSnapshot: definition.name,
    discountTypeSnapshot: definition.discountType,
    valueSnapshot: definition.value,
    isComp: isComp(definition.discountType as DiscountType, definition.value),
    reason: trimmed,
    appliedAmount: "0.00",
    appliedByUserId: actor.userId,
    appliedAt: new Date(),
  };
}

export async function applyOrderDiscount(
  database: Database,
  actor: Actor,
  orderId: string,
  input: { discountDefinitionId: string; reason: string; expectedVersion: number },
) {
  assertPermission(actor, "orders.discount.apply");

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);

    if (compareDecimals(order.itemSubtotal, "0") <= 0) {
      throw new BusinessRuleError(
        "NOTHING_TO_DISCOUNT",
        "Send at least one item before discounting the order.",
      );
    }

    const definition = await requireActiveDefinition(transaction, actor, input.discountDefinitionId, "ORDER");
    const [row] = await transaction
      .insert(orderDiscounts)
      .values({ orderId, ...snapshot(definition, actor, input.reason) })
      .returning({ id: orderDiscounts.id });
    const updated = await recomputeAndBumpOrder(transaction, orderId);

    return { discountId: row!.id, orderVersion: updated.version };
  });
}

export async function applyItemDiscount(
  database: Database,
  actor: Actor,
  orderId: string,
  itemId: string,
  input: { discountDefinitionId: string; reason: string; expectedVersion: number },
) {
  assertPermission(actor, "orders.discount.apply");

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);

    const [item] = await transaction
      .select({ status: orderItems.status })
      .from(orderItems)
      .where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)));

    if (!item) {
      throw new NotFoundError("order item");
    }

    if (item.status !== "SUBMITTED") {
      throw new BusinessRuleError(
        "ITEM_NOT_DISCOUNTABLE",
        item.status === "DRAFT" ? "Send the item before discounting it." : "A voided item can't be discounted.",
      );
    }

    const definition = await requireActiveDefinition(transaction, actor, input.discountDefinitionId, "ITEM");
    const [row] = await transaction
      .insert(orderItemDiscounts)
      .values({ orderItemId: itemId, ...snapshot(definition, actor, input.reason) })
      .returning({ id: orderItemDiscounts.id });
    const updated = await recomputeAndBumpOrder(transaction, orderId);

    return { discountId: row!.id, orderVersion: updated.version };
  });
}

/** Marks an applied discount REMOVED with who, when and why. Nothing is deleted. */
export async function removeDiscount(
  database: Database,
  actor: Actor,
  orderId: string,
  discountId: string,
  input: { reason: string; expectedVersion: number },
) {
  assertPermission(actor, "orders.discount.apply");

  const reason = input.reason.trim();

  if (!reason) {
    throw new BusinessRuleError("REASON_REQUIRED", "Enter a reason for removing the discount.");
  }

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);

    const removal = {
      status: "REMOVED",
      removedByUserId: actor.userId,
      removedAt: new Date(),
      removeReason: reason,
      updatedAt: new Date(),
    };
    const fromOrder = await transaction
      .update(orderDiscounts)
      .set(removal)
      .where(
        and(
          eq(orderDiscounts.id, discountId),
          eq(orderDiscounts.orderId, orderId),
          eq(orderDiscounts.status, "APPLIED"),
        ),
      )
      .returning({ id: orderDiscounts.id });

    if (fromOrder.length === 0) {
      const [itemDiscount] = await transaction
        .select({ id: orderItemDiscounts.id })
        .from(orderItemDiscounts)
        .innerJoin(orderItems, eq(orderItems.id, orderItemDiscounts.orderItemId))
        .where(
          and(
            eq(orderItemDiscounts.id, discountId),
            eq(orderItems.orderId, orderId),
            eq(orderItemDiscounts.status, "APPLIED"),
          ),
        );

      if (!itemDiscount) {
        throw new NotFoundError("applied discount");
      }

      await transaction.update(orderItemDiscounts).set(removal).where(eq(orderItemDiscounts.id, discountId));
    }

    const updated = await recomputeAndBumpOrder(transaction, orderId);

    return { id: orderId, version: updated.version };
  });
}
