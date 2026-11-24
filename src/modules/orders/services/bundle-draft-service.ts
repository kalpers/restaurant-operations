import type { Database } from "@/db";
import { orderItemModifiers, orderItems } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { resolveSellableItem } from "@/modules/menu/queries/order-menu-facts";
import type { ProposedSelection } from "@/modules/menu/rules/modifier-selection";
import { validateBundleChoices } from "@/modules/menu/rules/bundle-rules";
import { BusinessRuleError } from "@/shared/errors/app-error";

import { lockOrder, recomputeAndBumpOrder } from "../repositories/order-repository";
import { bundleComponentColumns, bundleParentColumns } from "../rules/bundle-lines";
import { assertOrderOpen } from "../rules/order-lifecycle";
import { assertSeatAllowed, validateSeat } from "../rules/seats";
import { assertPermission } from "./access";
import { modifierRows } from "./draft-item-service";

// Phase 36 part 5 (policy 9): a bundle is added to a check as a whole: a priced bundle line and
// one zero-priced component draft per choice, each with its own modifiers, instructions and
// course. Like any draft it consumes nothing and makes no ticket; SEND re-resolves it all.

export type BundleChoiceInput = {
  slotId: string;
  menuItemId: string;
  selections: ProposedSelection[];
  specialInstructions: string | null;
  /** Omitted means the slot's default course. */
  courseNumber?: number;
};

export async function addBundleDraft(
  database: Database,
  actor: Actor,
  orderId: string,
  input: { menuItemId: string; choices: BundleChoiceInput[]; seatNumber?: number | null; expectedVersion: number },
): Promise<{ itemId: string; componentIds: string[]; orderVersion: number }> {
  assertPermission(actor, "orders.edit");

  for (const choice of input.choices) {
    if (choice.courseNumber !== undefined && (!Number.isInteger(choice.courseNumber) || choice.courseNumber < 1 || choice.courseNumber > 5)) {
      throw new BusinessRuleError("INVALID_COURSE", "Choose a course from 1 to 5.");
    }
  }

  return withTransaction(database, async (transaction) => {
    const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

    assertOrderOpen(order.status);

    const seatNumber = validateSeat(input.seatNumber ?? null);

    if (seatNumber !== null) {
      assertSeatAllowed(order);
    }

    const at = new Date();
    const menu = await getOperationalMenu(transaction, actor, at, { orderType: order.orderType });
    const bundle = await resolveSellableItem(transaction, actor, { menuItemId: input.menuItemId, selections: [], at, menu });

    if (bundle.item.itemKind !== "BUNDLE" || !bundle.item.bundle) {
      throw new BusinessRuleError("NOT_A_BUNDLE", "That item isn't a prix-fixe or combo.");
    }

    const upcharges = validateBundleChoices(bundle.item.bundle.slots, input.choices);
    const components = [];

    for (const choice of input.choices) {
      const sellable = await resolveSellableItem(transaction, actor, {
        menuItemId: choice.menuItemId,
        selections: choice.selections,
        at,
        menu,
      });
      const slot = bundle.item.bundle.slots.find((entry) => entry.id === choice.slotId)!;

      components.push({ choice, sellable, slot });
    }

    const courses = components.map(({ choice, slot }) => choice.courseNumber ?? slot.defaultCourse);
    const [parent] = await transaction
      .insert(orderItems)
      .values({
        orderId,
        menuItemId: input.menuItemId,
        quantity: 1,
        specialInstructions: null,
        courseNumber: courses.length > 0 ? Math.min(...courses) : 1,
        seatNumber,
        addedByUserId: actor.userId,
        ...bundleParentColumns(bundle.item, upcharges),
      })
      .returning({ id: orderItems.id });
    const componentIds: string[] = [];

    for (const [index, { choice, sellable, slot }] of components.entries()) {
      const [child] = await transaction
        .insert(orderItems)
        .values({
          orderId,
          menuItemId: choice.menuItemId,
          quantity: 1,
          specialInstructions: choice.specialInstructions?.trim() || null,
          courseNumber: courses[index]!,
          seatNumber,
          addedByUserId: actor.userId,
          bundleParentOrderItemId: parent!.id,
          bundleSlotId: slot.id,
          bundleSlotNameSnapshot: slot.name,
          bundleNameSnapshot: bundle.item.name,
          bundleUpchargeSnapshot: upcharges[index]!,
          ...bundleComponentColumns(sellable.item),
        })
        .returning({ id: orderItems.id });

      if (sellable.selections.length > 0) {
        // Policy 9: a component's modifiers carry no price inside a bundle.
        await transaction
          .insert(orderItemModifiers)
          .values(modifierRows(child!.id, sellable).map((row) => ({ ...row, priceAdjustmentSnapshot: "0.00" })));
      }

      componentIds.push(child!.id);
    }

    const updated = await recomputeAndBumpOrder(transaction, orderId);

    return { itemId: parent!.id, componentIds, orderVersion: updated.version };
  });
}
