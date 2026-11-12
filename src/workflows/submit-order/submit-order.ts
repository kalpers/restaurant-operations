import { and, asc, eq, inArray, max, sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  orderItemInventoryConsumption,
  orderItemModifiers,
  orderItems,
  orderSendBatches,
} from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { assertNoOpenSettlement } from "@/modules/settlements/repositories/settlement-repository";
import { createTicketsForSendBatch, type FireMode } from "@/modules/kitchen/services/ticket-generation";
import { postOrderConsumption } from "@/modules/inventory/services/order-consumption";
import {
  loadModifierEffectsForItem,
  resolveSellableItem,
} from "@/modules/menu/queries/order-menu-facts";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { resolveItemTaxes } from "@/modules/menu/services/tax-service";
import { resolveRevisionRequirements } from "@/modules/recipes/services/ingredient-service";
import { resolveEffectiveRevisionForMenuItem } from "@/modules/recipes/services/recipe-service";
import {
  appendItemHistory,
  lockOrder,
  readOrderLocation,
  recomputeAndBumpOrder,
} from "@/modules/orders/repositories/order-repository";
import { planLineConsumption } from "@/modules/orders/rules/consumption-plan";
import { assertOrderOpen, buildKitchenInstructions } from "@/modules/orders/rules/order-lifecycle";
import { assertPermission } from "@/modules/orders/services/access";
import { draftColumns } from "@/modules/orders/services/draft-item-service";
import { SEND_SCOPE } from "@/modules/orders/types";
import { BusinessRuleError } from "@/shared/errors/app-error";

export type SendResult = {
  orderId: string;
  batchId: string;
  batchNumber: number;
  itemIds: string[];
  sentAt: string;
  orderVersion: number;
  ticketIds: string[];
};

/**
 * SEND: commits every DRAFT item of an order in one send batch, in one transaction
 * (README section 24):
 *
 *   authorize -> claim idempotency key -> lock order and check version -> lock drafts
 *   -> re-resolve price and modifiers (operational menu) -> resolve recipe revision
 *   -> apply modifier effects -> tax snapshot (Phase 17) -> create batch -> freeze snapshots -> consumption
 *   snapshots and CONSUME postings (with balances) -> kitchen/bar tickets (Phase 10)
 *   -> totals -> histories -> outbox events -> audit event -> store result
 *
 * Any failure rolls everything back, including the idempotency claim. A retry with the
 * same key returns the first result and changes nothing.
 */
export async function sendOrderItems(
  database: Database,
  actor: Actor,
  orderId: string,
  input: { expectedVersion: number; idempotencyKey: string; fire?: FireMode },
): Promise<SendResult & { replayed: boolean }> {
  assertPermission(actor, "orders.submit");

  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<SendResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: SEND_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        // `fire` joins the fingerprint only when it isn't the default, so a key claimed
        // before Phase 17 still matches its retry.
        request: {
          orderId,
          expectedVersion: input.expectedVersion,
          ...(input.fire && input.fire !== "ALL" ? { fire: input.fire } : {}),
        },
      },
      async (idempotencyRecordId) => {
        const order = await lockOrder(transaction, actor, orderId, input.expectedVersion);

        assertOrderOpen(order.status);
        await assertNoOpenSettlement(transaction, order.id);

        const drafts = await transaction
          .select()
          .from(orderItems)
          .where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, "DRAFT")))
          .orderBy(asc(orderItems.createdAt), asc(orderItems.id))
          .for("update");

        if (drafts.length === 0) {
          throw new BusinessRuleError("NOTHING_TO_SEND", "There are no unsent items on this order.");
        }

        const sentAt = new Date();
        const location = await readOrderLocation(transaction, actor.locationId, sentAt);
        const menu = await getOperationalMenu(transaction, actor, sentAt);
        const selectionRows = await transaction
          .select()
          .from(orderItemModifiers)
          .where(inArray(orderItemModifiers.orderItemId, drafts.map((item) => item.id)))
          .orderBy(asc(orderItemModifiers.sortOrder));

        // Resolve everything first, so a refusal happens before anything is written.
        const resolved: {
          draft: (typeof drafts)[number];
          sellable: Awaited<ReturnType<typeof resolveSellableItem>>;
          revision: Awaited<ReturnType<typeof resolveEffectiveRevisionForMenuItem>>;
          consumption: ReturnType<typeof planLineConsumption>;
        }[] = [];

        for (const draft of drafts) {
          const selections = selectionRows
            .filter((row) => row.orderItemId === draft.id)
            .map((row) => ({ modifierGroupId: row.modifierGroupId, modifierId: row.modifierId }));
          const sellable = await resolveSellableItem(transaction, actor, {
            menuItemId: draft.menuItemId,
            selections,
            at: sentAt,
            menu,
          });
          const revision = await resolveEffectiveRevisionForMenuItem(
            transaction,
            actor.organizationId,
            draft.menuItemId,
            sentAt,
          );
          const requirements = revision
            ? await resolveRevisionRequirements(transaction, actor.organizationId, revision.id)
            : [];
          const effects = await loadModifierEffectsForItem(
            transaction,
            actor.organizationId,
            draft.menuItemId,
            selections.map((selection) => selection.modifierId),
          );
          const consumption = planLineConsumption({
            requirements,
            effects,
            quantity: draft.quantity,
          });

          resolved.push({ draft, sellable, revision, consumption });
        }

        // Phase 17 tax snapshot (policy A3/A4): the rate in force now, or none when the
        // Location doesn't tax. With tax on, an item with no category or rate stops the round.
        const taxes = location.taxEnabled
          ? await resolveItemTaxes(
              transaction,
              actor.organizationId,
              actor.locationId,
              [...new Set(drafts.map((draft) => draft.menuItemId))],
              sentAt,
            )
          : new Map<string, null>();

        if (location.taxEnabled) {
          const untaxable = resolved
            .filter(({ draft }) => !taxes.get(draft.menuItemId))
            .map(({ sellable }) => sellable.item.name);

          if (untaxable.length > 0) {
            throw new BusinessRuleError(
              "TAX_NOT_CONFIGURED",
              "Some items have no tax category or no tax rate at this location. Ask a manager to set them up.",
              { items: [...new Set(untaxable)] },
            );
          }
        }

        const [last] = await transaction
          .select({ value: max(orderSendBatches.batchNumber) })
          .from(orderSendBatches)
          .where(eq(orderSendBatches.orderId, orderId));
        const [batch] = await transaction
          .insert(orderSendBatches)
          .values({
            orderId,
            batchNumber: (last?.value ?? 0) + 1,
            idempotencyRecordId,
            sentByUserId: actor.userId,
            sentAt,
            businessDate: location.businessDate,
            itemCount: drafts.length,
          })
          .returning();

        for (const { draft, sellable, revision } of resolved) {
          // Refresh the modifier snapshots while the item is still a draft.
          await transaction.delete(orderItemModifiers).where(eq(orderItemModifiers.orderItemId, draft.id));

          if (sellable.selections.length > 0) {
            await transaction.insert(orderItemModifiers).values(
              sellable.selections.map((selection, index) => ({
                orderItemId: draft.id,
                modifierGroupId: selection.modifierGroupId,
                modifierId: selection.modifier.id,
                modifierGroupNameSnapshot: selection.modifierGroupName,
                modifierCodeSnapshot: selection.modifier.code,
                modifierNameSnapshot: selection.modifier.name,
                priceAdjustmentSnapshot: selection.modifier.priceAdjustment,
                preparationEffectTypeSnapshot: selection.modifier.preparationEffectType,
                preparationInstructionSnapshot: selection.modifier.preparationInstruction,
                sortOrder: index,
              })),
            );
          }

          await transaction
            .update(orderItems)
            .set({
              ...draftColumns(sellable, draft.quantity),
              status: "SUBMITTED",
              kitchenInstructionsSnapshot: buildKitchenInstructions(
                sellable.selections.map((selection) => selection.modifier.preparationInstruction),
                draft.specialInstructions,
              ),
              prepStationIdsSnapshot: sellable.item.prepStationIds,
              recipeId: revision?.recipeId ?? null,
              recipeVersionId: revision?.id ?? null,
              taxCategoryId: taxes.get(draft.menuItemId)?.taxCategoryId ?? null,
              taxCategoryCodeSnapshot: taxes.get(draft.menuItemId)?.taxCategoryCode ?? null,
              taxRateSnapshot: taxes.get(draft.menuItemId)?.taxRate ?? null,
              taxIncludedSnapshot: taxes.get(draft.menuItemId)?.priceIncludesTax ?? false,
              menuCategoryId: sellable.category.id,
              menuCategoryNameSnapshot: sellable.category.name,
              sendBatchId: batch!.id,
              submittedAt: sentAt,
              version: sql`${orderItems.version} + 1`,
              updatedAt: sentAt,
            })
            .where(eq(orderItems.id, draft.id));
        }

        const lines = resolved.flatMap(({ draft, consumption }) =>
          consumption.map((entry) => ({
            orderItemId: draft.id,
            inventoryItemId: entry.inventoryItemId,
            baseQuantity: entry.baseQuantity,
          })),
        );
        const postings = await postOrderConsumption(transaction, {
          organizationId: actor.organizationId,
          locationId: actor.locationId,
          occurredAt: sentAt,
          createdByUserId: actor.userId,
          lines,
        });

        if (postings.length > 0) {
          await transaction.insert(orderItemInventoryConsumption).values(
            postings.map((posting) => {
              const { consumption, revision } = resolved.find(
                (entry) => entry.draft.id === posting.orderItemId,
              )!;
              const planned = consumption.find(
                (entry) => entry.inventoryItemId === posting.inventoryItemId,
              )!;

              return {
                organizationId: actor.organizationId,
                orderItemId: posting.orderItemId,
                sendBatchId: batch!.id,
                inventoryItemId: posting.inventoryItemId,
                baseQuantity: posting.baseQuantity,
                baseUnitId: posting.baseUnitId,
                recipeVersionId: revision?.id ?? null,
                sourceSnapshot: {
                  perUnitBaseQuantity: planned.perUnitBaseQuantity,
                  recipeBaseQuantity: planned.recipeBaseQuantity,
                  effects: planned.effects,
                },
                inventoryTransactionId: posting.posting.transactionId,
              };
            }),
          );
        }

        // Station work from the routing snapshot just frozen, in this same transaction.
        const { ticketIds } = await createTicketsForSendBatch(transaction, {
          organizationId: actor.organizationId,
          locationId: actor.locationId,
          actorUserId: actor.userId,
          order: {
            id: order.id,
            orderNumber: order.orderNumber,
            orderType: order.orderType,
            tableSessionId: order.tableSessionId,
            customerName: order.customerName,
            assignedServerEmployeeId: order.assignedServerEmployeeId,
          },
          batch: {
            id: batch!.id,
            batchNumber: batch!.batchNumber,
            sentAt,
            businessDate: location.businessDate,
          },
          fire: input.fire ?? "ALL",
          items: resolved.map(({ draft, sellable }) => ({
            orderItemId: draft.id,
            quantity: draft.quantity,
            courseNumber: draft.courseNumber,
            menuItemCodeSnapshot: sellable.item.code,
            menuItemNameSnapshot: sellable.item.name,
            kitchenInstructionsSnapshot: buildKitchenInstructions(
              sellable.selections.map((selection) => selection.modifier.preparationInstruction),
              draft.specialInstructions,
            ),
            prepStationIds: sellable.item.prepStationIds,
            modifiers: sellable.selections.map((selection) => ({
              groupName: selection.modifierGroupName,
              code: selection.modifier.code,
              name: selection.modifier.name,
              preparationInstruction: selection.modifier.preparationInstruction,
            })),
          })),
        });

        await appendItemHistory(
          transaction,
          drafts.map((draft) => ({
            orderItemId: draft.id,
            status: "SUBMITTED",
            reason: `Send batch ${batch!.batchNumber}`,
            userId: actor.userId,
            at: sentAt,
          })),
        );

        const updated = await recomputeAndBumpOrder(transaction, orderId);

        await writeOutboxEvents(transaction, [
          {
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            eventType: "order.items-submitted",
            aggregateType: "order",
            aggregateId: orderId,
            payload: {
              sendBatchId: batch!.id,
              batchNumber: batch!.batchNumber,
              orderItemIds: drafts.map((draft) => draft.id),
            },
            occurredAt: sentAt,
          },
        ]);
        // Inside the idempotent block: a replayed SEND writes no second audit event.
        await recordAudit(transaction, actor, {
          action: "orders.items-sent",
          entityId: orderId,
          occurredAt: sentAt,
          after: {
            orderNumber: order.orderNumber,
            sendBatchId: batch!.id,
            batchNumber: batch!.batchNumber,
            itemCount: drafts.length,
            orderItemIds: drafts.map((draft) => draft.id),
          },
        });

        return {
          orderId,
          batchId: batch!.id,
          batchNumber: batch!.batchNumber,
          itemIds: drafts.map((draft) => draft.id),
          sentAt: sentAt.toISOString(),
          orderVersion: updated.version,
          ticketIds,
        };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}
