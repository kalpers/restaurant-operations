import { and, asc, eq, inArray, ne } from "drizzle-orm";

import type { Database } from "@/db";
import { nextVersion } from "@/db/helpers/versioning";
import {
  menuItemBundleSlotOptions,
  menuItemBundleSlots,
  menuItemModifierGroups,
  menuItemPrepRouting,
  menuItems,
  recipes,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";

import { assertBundleShape } from "../rules/bundle-rules";
import { assertPermission } from "./access";

// Phase 36 part 5 (policy 9): setting up a prix-fixe or combo. A bundle is a menu item of kind
// BUNDLE with courses (slots) of component choices. It has no recipe, routing or modifier
// groups of its own; components are active STANDARD items. Slots and options are deactivated,
// never deleted, so sold bundles keep their history.

export type BundleSlotInput = {
  id?: string | null;
  name: string;
  defaultCourse: number;
  minimumChoices: number;
  maximumChoices: number;
  options: { componentMenuItemId: string; upcharge: string; isDefault?: boolean }[];
};

export type BundleConfiguration = {
  menuItemId: string;
  itemKind: "STANDARD" | "BUNDLE";
  version: number;
  slots: {
    id: string;
    name: string;
    defaultCourse: number;
    minimumChoices: number;
    maximumChoices: number;
    options: { componentMenuItemId: string; name: string; upcharge: string; isDefault: boolean }[];
  }[];
};

async function findItem(executor: DatabaseExecutor, actor: Actor, menuItemId: string) {
  const [item] = await executor
    .select()
    .from(menuItems)
    .where(and(eq(menuItems.id, menuItemId), eq(menuItems.organizationId, actor.organizationId)));

  if (!item) {
    throw new NotFoundError("menu item");
  }

  return item;
}

/** A bundle's courses and choices, active ones only. */
export async function getBundleConfiguration(executor: DatabaseExecutor, actor: Actor, menuItemId: string): Promise<BundleConfiguration> {
  assertPermission(actor, "menu.view");

  const item = await findItem(executor, actor, menuItemId);
  const slots = await executor
    .select()
    .from(menuItemBundleSlots)
    .where(and(eq(menuItemBundleSlots.bundleMenuItemId, menuItemId), eq(menuItemBundleSlots.active, true)))
    .orderBy(asc(menuItemBundleSlots.sortOrder));
  const options =
    slots.length === 0
      ? []
      : await executor
          .select({
            slotId: menuItemBundleSlotOptions.slotId,
            componentMenuItemId: menuItemBundleSlotOptions.componentMenuItemId,
            name: menuItems.name,
            upcharge: menuItemBundleSlotOptions.upcharge,
            isDefault: menuItemBundleSlotOptions.isDefault,
          })
          .from(menuItemBundleSlotOptions)
          .innerJoin(menuItems, eq(menuItems.id, menuItemBundleSlotOptions.componentMenuItemId))
          .where(and(inArray(menuItemBundleSlotOptions.slotId, slots.map((slot) => slot.id)), eq(menuItemBundleSlotOptions.active, true)))
          .orderBy(asc(menuItemBundleSlotOptions.sortOrder));

  return {
    menuItemId,
    itemKind: item.itemKind === "BUNDLE" ? "BUNDLE" : "STANDARD",
    version: item.version,
    slots: slots.map((slot) => ({
      id: slot.id,
      name: slot.name,
      defaultCourse: slot.defaultCourse,
      minimumChoices: slot.minimumChoices,
      maximumChoices: slot.maximumChoices,
      options: options
        .filter((option) => option.slotId === slot.id)
        .map(({ componentMenuItemId, name, upcharge, isDefault }) => ({ componentMenuItemId, name, upcharge, isDefault })),
    })),
  };
}

/** A bundle has no recipe, routing or modifier groups of its own, and isn't anyone's component. */
async function assertCanBeBundle(transaction: DatabaseTransaction, menuItemId: string) {
  const [recipe] = await transaction.select({ id: recipes.id }).from(recipes).where(eq(recipes.menuItemId, menuItemId));
  const [routing] = await transaction
    .select({ id: menuItemPrepRouting.id })
    .from(menuItemPrepRouting)
    .where(and(eq(menuItemPrepRouting.menuItemId, menuItemId), eq(menuItemPrepRouting.active, true)));
  const [group] = await transaction
    .select({ id: menuItemModifierGroups.id })
    .from(menuItemModifierGroups)
    .where(and(eq(menuItemModifierGroups.menuItemId, menuItemId), eq(menuItemModifierGroups.active, true)));
  const [component] = await transaction
    .select({ id: menuItemBundleSlotOptions.id })
    .from(menuItemBundleSlotOptions)
    .where(and(eq(menuItemBundleSlotOptions.componentMenuItemId, menuItemId), eq(menuItemBundleSlotOptions.active, true)));

  if (recipe || routing || group) {
    throw new BusinessRuleError(
      "BUNDLE_HAS_OWN_PREP",
      "A bundle has no recipe, kitchen routing or modifiers of its own; its courses do. Remove those first.",
    );
  }

  if (component) {
    throw new BusinessRuleError("BUNDLE_IS_COMPONENT", "This item is a choice in another bundle, so it can't be a bundle itself.");
  }
}

/**
 * Policy 9: makes an item a bundle (or updates one) with these courses and choices. A slot with
 * an ID updates that slot; one without is new; one left out is deactivated. Needs `menu.edit`
 * and, because upcharges are prices, `menu.pricing.edit`. Audited without prices.
 */
export async function saveBundleConfiguration(
  database: Database,
  actor: Actor,
  menuItemId: string,
  input: { slots: BundleSlotInput[]; expectedVersion: number },
): Promise<BundleConfiguration> {
  assertPermission(actor, "menu.edit");
  assertPermission(actor, "menu.pricing.edit");
  assertBundleShape(input.slots);

  await withTransaction(database, async (transaction) => {
    const [item] = await transaction
      .select()
      .from(menuItems)
      .where(and(eq(menuItems.id, menuItemId), eq(menuItems.organizationId, actor.organizationId)))
      .for("update");

    if (!item) {
      throw new NotFoundError("menu item");
    }

    if (item.version !== input.expectedVersion) {
      throw new ConflictError("CONCURRENCY_CONFLICT", "This item was changed by someone else. Reload and try again.");
    }

    await assertCanBeBundle(transaction, menuItemId);

    const componentIds = [...new Set(input.slots.flatMap((slot) => slot.options.map((option) => option.componentMenuItemId)))];
    const components = await transaction
      .select({ id: menuItems.id, itemKind: menuItems.itemKind, active: menuItems.active })
      .from(menuItems)
      .where(and(inArray(menuItems.id, componentIds), eq(menuItems.organizationId, actor.organizationId)));

    if (components.length !== componentIds.length) {
      throw new NotFoundError("menu item");
    }

    if (components.some((component) => component.itemKind !== "STANDARD" || !component.active || component.id === menuItemId)) {
      throw new BusinessRuleError("BUNDLE_COMPONENT_INVALID", "Each choice is an active ordinary menu item, not a bundle.");
    }

    const existing = await transaction.select().from(menuItemBundleSlots).where(eq(menuItemBundleSlots.bundleMenuItemId, menuItemId));
    const kept = new Set<string>();

    for (const [index, slot] of input.slots.entries()) {
      const values = {
        name: slot.name.trim(),
        sortOrder: (index + 1) * 10,
        defaultCourse: slot.defaultCourse,
        minimumChoices: slot.minimumChoices,
        maximumChoices: slot.maximumChoices,
        active: true,
      };
      let slotId: string;

      if (slot.id) {
        if (!existing.some((row) => row.id === slot.id)) {
          throw new NotFoundError("bundle course");
        }

        slotId = slot.id;
        await transaction.update(menuItemBundleSlots).set(values).where(eq(menuItemBundleSlots.id, slotId));
      } else {
        const [created] = await transaction
          .insert(menuItemBundleSlots)
          .values({ ...values, organizationId: actor.organizationId, bundleMenuItemId: menuItemId })
          .returning({ id: menuItemBundleSlots.id });

        slotId = created!.id;
      }

      kept.add(slotId);

      // Options: keep or reactivate those named, deactivate the rest.
      const current = await transaction.select().from(menuItemBundleSlotOptions).where(eq(menuItemBundleSlotOptions.slotId, slotId));

      for (const [order, option] of slot.options.entries()) {
        const row = current.find((entry) => entry.componentMenuItemId === option.componentMenuItemId);
        const optionValues = {
          upcharge: toScale(option.upcharge || "0", 2),
          isDefault: option.isDefault ?? false,
          sortOrder: (order + 1) * 10,
          active: true,
        };

        if (row) {
          await transaction.update(menuItemBundleSlotOptions).set(optionValues).where(eq(menuItemBundleSlotOptions.id, row.id));
        } else {
          await transaction
            .insert(menuItemBundleSlotOptions)
            .values({ ...optionValues, organizationId: actor.organizationId, slotId, componentMenuItemId: option.componentMenuItemId });
        }
      }

      const named = new Set(slot.options.map((option) => option.componentMenuItemId));
      const dropped = current.filter((entry) => !named.has(entry.componentMenuItemId) && entry.active).map((entry) => entry.id);

      if (dropped.length > 0) {
        await transaction.update(menuItemBundleSlotOptions).set({ active: false }).where(inArray(menuItemBundleSlotOptions.id, dropped));
      }
    }

    const retired = existing.filter((row) => !kept.has(row.id) && row.active).map((row) => row.id);

    if (retired.length > 0) {
      await transaction.update(menuItemBundleSlots).set({ active: false }).where(inArray(menuItemBundleSlots.id, retired));
    }

    await transaction
      .update(menuItems)
      .set({ itemKind: "BUNDLE", version: nextVersion(menuItems.version) })
      .where(eq(menuItems.id, menuItemId));
    await recordAudit(transaction, actor, {
      action: "menu.bundle-saved",
      entityId: menuItemId,
      details: { itemCode: item.code, courseCount: input.slots.length, choiceCount: componentIds.length, wasBundle: item.itemKind === "BUNDLE" },
    });
  });

  return getBundleConfiguration(database, actor, menuItemId);
}

/** Policy 9: turns a bundle back into an ordinary item; its courses are deactivated, never deleted. */
export async function clearBundle(database: Database, actor: Actor, menuItemId: string, input: { expectedVersion: number }): Promise<BundleConfiguration> {
  assertPermission(actor, "menu.edit");

  await withTransaction(database, async (transaction) => {
    const [item] = await transaction
      .select()
      .from(menuItems)
      .where(and(eq(menuItems.id, menuItemId), eq(menuItems.organizationId, actor.organizationId)))
      .for("update");

    if (!item) {
      throw new NotFoundError("menu item");
    }

    if (item.version !== input.expectedVersion) {
      throw new ConflictError("CONCURRENCY_CONFLICT", "This item was changed by someone else. Reload and try again.");
    }

    await transaction
      .update(menuItemBundleSlots)
      .set({ active: false })
      .where(and(eq(menuItemBundleSlots.bundleMenuItemId, menuItemId), ne(menuItemBundleSlots.active, false)));
    await transaction
      .update(menuItems)
      .set({ itemKind: "STANDARD", version: nextVersion(menuItems.version) })
      .where(eq(menuItems.id, menuItemId));
    await recordAudit(transaction, actor, {
      action: "menu.bundle-cleared",
      entityId: menuItemId,
      details: { itemCode: item.code },
    });
  });

  return getBundleConfiguration(database, actor, menuItemId);
}
