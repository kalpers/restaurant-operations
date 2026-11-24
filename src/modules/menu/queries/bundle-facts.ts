import { and, asc, eq, inArray } from "drizzle-orm";

import { menuItemBundleSlotOptions, menuItemBundleSlots, menuItems } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

import { slotsFillable, type BundleSlotFacts } from "../rules/bundle-rules";

// Phase 36 (policy 9): what a bundle offers, read for the operational menu. Only active slots
// and options are read; the operational menu keeps options whose component is sellable now.

export type BundleOption = { optionId: string; menuItemId: string; name: string; upcharge: string; isDefault: boolean };

export type OperationalBundle = {
  slots: (Omit<BundleSlotFacts, "options"> & { id: string; name: string; defaultCourse: number; options: BundleOption[] })[];
};

/** Active slots and options of these bundles, in order. */
export async function loadBundleSlots(
  executor: DatabaseExecutor,
  organizationId: string,
  bundleIds: readonly string[],
): Promise<Map<string, OperationalBundle["slots"]>> {
  const result = new Map<string, OperationalBundle["slots"]>();

  if (bundleIds.length === 0) {
    return result;
  }

  const slots = await executor
    .select()
    .from(menuItemBundleSlots)
    .where(
      and(
        eq(menuItemBundleSlots.organizationId, organizationId),
        inArray(menuItemBundleSlots.bundleMenuItemId, [...bundleIds]),
        eq(menuItemBundleSlots.active, true),
      ),
    )
    .orderBy(asc(menuItemBundleSlots.sortOrder), asc(menuItemBundleSlots.createdAt));
  const options =
    slots.length === 0
      ? []
      : await executor
          .select({
            optionId: menuItemBundleSlotOptions.id,
            slotId: menuItemBundleSlotOptions.slotId,
            menuItemId: menuItemBundleSlotOptions.componentMenuItemId,
            name: menuItems.name,
            upcharge: menuItemBundleSlotOptions.upcharge,
            isDefault: menuItemBundleSlotOptions.isDefault,
          })
          .from(menuItemBundleSlotOptions)
          .innerJoin(menuItems, eq(menuItems.id, menuItemBundleSlotOptions.componentMenuItemId))
          .where(and(inArray(menuItemBundleSlotOptions.slotId, slots.map((slot) => slot.id)), eq(menuItemBundleSlotOptions.active, true)))
          .orderBy(asc(menuItemBundleSlotOptions.sortOrder), asc(menuItems.name));

  for (const slot of slots) {
    result.set(slot.bundleMenuItemId, [
      ...(result.get(slot.bundleMenuItemId) ?? []),
      {
        id: slot.id,
        name: slot.name,
        defaultCourse: slot.defaultCourse,
        minimumChoices: slot.minimumChoices,
        maximumChoices: slot.maximumChoices,
        options: options
          .filter((option) => option.slotId === slot.id)
          .map(({ optionId, menuItemId, name, upcharge, isDefault }) => ({ optionId, menuItemId, name, upcharge, isDefault })),
      },
    ]);
  }

  return result;
}

/**
 * Policy 9: a bundle as offered now: each slot keeps the options whose component is sellable,
 * or null when a slot can't be filled (or it has no slots), so the bundle isn't sold.
 */
export function offeredBundle(slots: OperationalBundle["slots"] | undefined, sellableIds: ReadonlySet<string>): OperationalBundle | null {
  if (!slots || slots.length === 0) {
    return null;
  }

  const offered = slots.map((slot) => ({ ...slot, options: slot.options.filter((option) => sellableIds.has(option.menuItemId)) }));

  return slotsFillable(offered) ? { slots: offered } : null;
}
