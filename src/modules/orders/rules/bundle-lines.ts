import type { OperationalBundle } from "@/modules/menu/queries/bundle-facts";
import { BusinessRuleError } from "@/shared/errors/app-error";

import { calculateLineAmounts } from "./order-totals";

// Phase 36 part 5 (policy 9): how a bundle line and its components are priced. The bundle line
// carries the money (its price plus the chosen options' upcharges, quantity 1); each component
// is an ordinary order item for its own item, priced at zero, with its modifiers priced at zero.

/** The bundle line's price columns. */
export function bundleParentColumns(item: { code: string; name: string; price: string }, upcharges: readonly string[]) {
  const amounts = calculateLineAmounts(item.price, upcharges, 1);

  return {
    menuItemCodeSnapshot: item.code,
    menuItemNameSnapshot: item.name,
    basePriceSnapshot: amounts.basePrice,
    modifierTotalSnapshot: amounts.modifierTotal,
    unitPriceSnapshot: amounts.unitPrice,
    lineTotalSnapshot: amounts.lineTotal,
  };
}

/** A component's price columns: all zero; the bundle line carries the money. */
export function bundleComponentColumns(item: { code: string; name: string }) {
  return {
    menuItemCodeSnapshot: item.code,
    menuItemNameSnapshot: item.name,
    basePriceSnapshot: "0.00",
    modifierTotalSnapshot: "0.00",
    unitPriceSnapshot: "0.00",
    lineTotalSnapshot: "0.00",
  };
}

/** The slot and upcharge a component's choice stands for in the bundle as offered now. */
export function choiceInBundle(bundle: OperationalBundle, slotId: string, menuItemId: string): { slotName: string; upcharge: string } {
  const slot = bundle.slots.find((entry) => entry.id === slotId);
  const option = slot?.options.find((entry) => entry.menuItemId === menuItemId);

  if (!slot || !option) {
    throw new BusinessRuleError("BUNDLE_OPTION_UNAVAILABLE", `A choice in this bundle isn't available right now${slot ? ` (${slot.name})` : ""}.`);
  }

  return { slotName: slot.name, upcharge: option.upcharge };
}

/** How a component shows on a kitchen ticket: its name with the bundle's. */
export function componentTicketName(componentName: string, bundleName: string): string {
  return `${componentName} (${bundleName})`;
}

/** Refuses an action on a bundle component that is only taken on the whole bundle. */
export function assertNotBundleComponent(item: { bundleParentOrderItemId: string | null }, action: string): void {
  if (item.bundleParentOrderItemId) {
    throw new BusinessRuleError("BUNDLE_COMPONENT", `This is part of a bundle; ${action} the whole bundle instead.`);
  }
}
