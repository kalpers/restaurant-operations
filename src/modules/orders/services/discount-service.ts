import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { updateVersioned } from "@/db/helpers/versioned-update";
import { discountDefinitions, orderDiscounts, orderItemDiscounts, orderItems } from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
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
      rewardOnly: discountDefinitions.rewardOnly,
      active: discountDefinitions.active,
      version: discountDefinitions.version,
    })
    .from(discountDefinitions)
    .where(
      and(
        eq(discountDefinitions.organizationId, actor.organizationId),
        // Phase 30 (policy 7): reward-only discounts are never offered in the picker; the
        // Discounts page lists them read-only.
        includeInactive
          ? undefined
          : and(eq(discountDefinitions.active, true), eq(discountDefinitions.rewardOnly, false)),
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
    .select({ discountType: discountDefinitions.discountType, rewardOnly: discountDefinitions.rewardOnly })
    .from(discountDefinitions)
    .where(
      and(eq(discountDefinitions.id, definitionId), eq(discountDefinitions.organizationId, actor.organizationId)),
    );

  if (!existing) {
    throw new NotFoundError("discount");
  }

  if (existing.rewardOnly) {
    throw rewardOnlyError();
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

function rewardOnlyError() {
  return new BusinessRuleError(
    "REWARD_ONLY_DISCOUNT",
    "That discount belongs to a loyalty reward. Redeem the reward, or change it on the Loyalty page.",
  );
}

/**
 * Phase 30 (policy 7, amendment 4): a reward's own discount definition, created with the
 * reward in the caller's transaction. The Loyalty service checks `loyalty.manage`.
 */
export async function createRewardDiscountDefinition(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: DiscountDefinitionInput,
): Promise<string> {
  assertValidValue(input.discountType, input.value);

  const [row] = await transaction
    .insert(discountDefinitions)
    .values({
      organizationId: actor.organizationId,
      code: input.code,
      name: input.name.trim(),
      scope: input.scope,
      discountType: input.discountType,
      value: toScale(input.value, 2),
      rewardOnly: true,
    })
    .returning({ id: discountDefinitions.id });

  return row!.id;
}

/** Changes a reward's discount for later redemptions; applied snapshots never change. */
export async function updateRewardDiscountDefinition(
  transaction: DatabaseTransaction,
  actor: Actor,
  definitionId: string,
  input: { name: string; value: string; active: boolean },
): Promise<void> {
  const [existing] = await transaction
    .select({ discountType: discountDefinitions.discountType, rewardOnly: discountDefinitions.rewardOnly })
    .from(discountDefinitions)
    .where(and(eq(discountDefinitions.id, definitionId), eq(discountDefinitions.organizationId, actor.organizationId)))
    .for("update");

  if (!existing?.rewardOnly) {
    throw new NotFoundError("discount");
  }

  assertValidValue(existing.discountType as DiscountType, input.value);

  await transaction
    .update(discountDefinitions)
    .set({
      name: input.name.trim(),
      value: toScale(input.value, 2),
      active: input.active,
      version: sql`${discountDefinitions.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(discountDefinitions.id, definitionId));
}

async function requireActiveDefinition(
  transaction: DatabaseTransaction,
  actor: Actor,
  definitionId: string,
  scope: DiscountScope,
  allowRewardOnly = false,
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

  if (definition.rewardOnly && !allowRewardOnly) {
    throw rewardOnlyError();
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

export type DiscountApplication = {
  discountDefinitionId: string;
  reason: string;
  expectedVersion: number;
  /** An ITEM-scope discount names the SUBMITTED item. */
  orderItemId?: string;
};

/**
 * Applies a discount inside the caller's transaction, with every discount rule except the
 * permission check, which each caller makes: the routes below need `orders.discount.apply`,
 * and Phase 30 reward redemption needs `loyalty.redeem` (amendment 3). A reward-only
 * definition applies only when `allowRewardOnly` is set.
 */
export async function applyDiscountInTransaction(
  transaction: DatabaseTransaction,
  actor: Actor,
  orderId: string,
  input: DiscountApplication,
  options: { allowRewardOnly?: boolean } = {},
) {
  const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

  assertOrderOpen(order.status);

  if (input.orderItemId === undefined) {
    if (compareDecimals(order.itemSubtotal, "0") <= 0) {
      throw new BusinessRuleError(
        "NOTHING_TO_DISCOUNT",
        "Send at least one item before discounting the order.",
      );
    }

    const definition = await requireActiveDefinition(
      transaction,
      actor,
      input.discountDefinitionId,
      "ORDER",
      options.allowRewardOnly,
    );
    const [row] = await transaction
      .insert(orderDiscounts)
      .values({ orderId, ...snapshot(definition, actor, input.reason) })
      .returning({ id: orderDiscounts.id });
    const updated = await recomputeAndBumpOrder(transaction, orderId);
    const [applied] = await transaction
      .select({ amount: orderDiscounts.appliedAmount, isComp: orderDiscounts.isComp, reason: orderDiscounts.reason })
      .from(orderDiscounts)
      .where(eq(orderDiscounts.id, row!.id));

    await recordAudit(transaction, actor, {
      action: "orders.discount-applied",
      entityId: orderId,
      after: { discountId: row!.id, definitionCode: definition.code, ...applied },
    });

    return { discountId: row!.id, orderVersion: updated.version, scope: "ORDER" as const, amount: applied!.amount };
  }

  const [item] = await transaction
    .select({ status: orderItems.status })
    .from(orderItems)
    .where(and(eq(orderItems.id, input.orderItemId), eq(orderItems.orderId, orderId)));

  if (!item) {
    throw new NotFoundError("order item");
  }

  if (item.status !== "SUBMITTED") {
    throw new BusinessRuleError(
      "ITEM_NOT_DISCOUNTABLE",
      item.status === "DRAFT" ? "Send the item before discounting it." : "A voided item can't be discounted.",
    );
  }

  const definition = await requireActiveDefinition(
    transaction,
    actor,
    input.discountDefinitionId,
    "ITEM",
    options.allowRewardOnly,
  );
  const [row] = await transaction
    .insert(orderItemDiscounts)
    .values({ orderItemId: input.orderItemId, ...snapshot(definition, actor, input.reason) })
    .returning({ id: orderItemDiscounts.id });
  const updated = await recomputeAndBumpOrder(transaction, orderId);
  const [applied] = await transaction
    .select({
      amount: orderItemDiscounts.appliedAmount,
      isComp: orderItemDiscounts.isComp,
      reason: orderItemDiscounts.reason,
    })
    .from(orderItemDiscounts)
    .where(eq(orderItemDiscounts.id, row!.id));

  await recordAudit(transaction, actor, {
    action: "orders.discount-applied",
    entityId: orderId,
    after: { discountId: row!.id, orderItemId: input.orderItemId, definitionCode: definition.code, ...applied },
  });

  return { discountId: row!.id, orderVersion: updated.version, scope: "ITEM" as const, amount: applied!.amount };
}

export async function applyOrderDiscount(
  database: Database,
  actor: Actor,
  orderId: string,
  input: { discountDefinitionId: string; reason: string; expectedVersion: number },
) {
  assertPermission(actor, "orders.discount.apply");

  return withTransaction(database, async (transaction) => {
    const applied = await applyDiscountInTransaction(transaction, actor, orderId, input);

    return { discountId: applied.discountId, orderVersion: applied.orderVersion };
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
    const applied = await applyDiscountInTransaction(transaction, actor, orderId, { ...input, orderItemId: itemId });

    return { discountId: applied.discountId, orderVersion: applied.orderVersion };
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

    await recordAudit(transaction, actor, {
      action: "orders.discount-removed",
      entityId: orderId,
      before: { discountId, status: "APPLIED" },
      after: { discountId, reason },
    });

    return { id: orderId, version: updated.version };
  });
}
