import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import {
  OrderWorkspace,
  type DiscountChoice,
  type MenuCategory,
} from "@/components/orders/order-workspace";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { fulfillmentForOrder } from "@/modules/kitchen/queries/kitchen-queries";
import { heldCoursesForOrder } from "@/modules/kitchen/services/course-fire-service";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { formatInstant } from "@/shared/time/format-instant";
import { getLocationTimeZone } from "@/modules/organization/services/organization-service";
import { getOrderDetail, listOrders } from "@/modules/orders/queries/order-queries";
import { actorHolds } from "@/modules/orders/services/access";
import { listDiscountDefinitions } from "@/modules/orders/services/discount-service";
import { listAllergens } from "@/modules/recipes/queries/allergen-facts";
import { getProfileLoyalty, listLoyaltyRewards } from "@/modules/reservations/services/loyalty-service";
import { NotFoundError } from "@/shared/errors/app-error";

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { actor } = await requirePageActor("orders.view");
  const parsed = z.uuid().safeParse((await params).orderId);

  if (!parsed.success) {
    notFound();
  }

  const database = getDatabase();
  const order = await getOrderDetail(database, actor, parsed.data).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });
  const abilities = {
    edit: actorHolds(actor, "orders.edit") && actorHolds(actor, "menu.view"),
    submit: actorHolds(actor, "orders.submit"),
    void: actorHolds(actor, "orders.void"),
    discount: actorHolds(actor, "orders.discount.apply"),
    remake: actor.permissions.has("fulfillment.remake"),
    settle: actorHolds(actor, "settlements.view"),
    fire: actorHolds(actor, "orders.fire"),
    move: actorHolds(actor, "orders.move-items"),
    newCheck: actorHolds(actor, "orders.move-items") && actorHolds(actor, "orders.create"),
    taxExempt: actorHolds(actor, "tax.exempt"),
    saveAllergyToProfile: actorHolds(actor, "guests.manage"),
  };
  const allergens = (await listAllergens(database, actor.organizationId)).map(({ id, name, active }) => ({ id, name, active }));
  const heldCourses = order.status === "OPEN" ? await heldCoursesForOrder(database, order.id) : [];
  // Other open checks at the same table, for moving items between them (Phase 17).
  const otherChecks =
    abilities.move && order.status === "OPEN" && order.tableSessionId
      ? (await listOrders(database, actor, { tableSessionId: order.tableSessionId, status: "OPEN" }))
          .filter((entry) => entry.id !== order.id)
          .map((entry) => ({ id: entry.id, orderNumber: entry.orderNumber, version: entry.version }))
      : [];
  const fulfillment = Object.fromEntries(await fulfillmentForOrder(database, order.id));
  const categories: MenuCategory[] = [];

  if (abilities.edit && order.status === "OPEN") {
    // Items from every open menu, grouped by category, once each.
    // Phase 28 (policy 3): priced for this check's order type, so happy hour shows where it applies.
    const menu = await getOperationalMenu(database, actor, new Date(), { orderType: order.orderType });
    const timeZone = await getLocationTimeZone(database, actor.locationId);
    const byCategory = new Map<string, MenuCategory>();

    for (const offered of menu.menus) {
      for (const category of offered.categories) {
        const entry = byCategory.get(category.id) ?? { id: category.id, name: category.name, items: [] };

        for (const item of category.items) {
          if (!entry.items.some((existing) => existing.menuItemId === item.menuItemId)) {
            entry.items.push({
              ...item,
              periodLabel: item.pricePeriod
                ? `${item.pricePeriod.name} until ${formatInstant(item.pricePeriod.endsAt, timeZone, "time")}`
                : null,
            });
          }
        }

        byCategory.set(category.id, entry);
      }
    }

    categories.push(...byCategory.values());
  }

  // Phase 30 (policy 15): the linked guest's points and the rewards, when the program is on.
  const profile = order.allergy.profile;
  const profileLoyalty = profile ? await getProfileLoyalty(database, actor, profile.id) : null;
  const loyalty =
    profile && profileLoyalty?.enabled
      ? {
          profileName: profile.displayName,
          balance: profileLoyalty.balance,
          available: profileLoyalty.available,
          canRedeem: actor.permissions.has("loyalty.redeem"),
          rewards: actor.permissions.has("loyalty.redeem")
            ? (await listLoyaltyRewards(database, actor)).map((reward) => ({
                id: reward.id,
                name: reward.name,
                pointsCost: reward.pointsCost,
                scope: reward.scope,
                discountType: reward.discountType,
                value: reward.value,
              }))
            : [],
        }
      : null;

  const discounts: DiscountChoice[] = abilities.discount
    ? (await listDiscountDefinitions(database, actor)).map((entry) => ({
        id: entry.id,
        name: entry.name,
        scope: entry.scope,
        discountType: entry.discountType,
        value: entry.value,
      }))
    : [];

  return (
    <>
      <p className="mb-3">
        <Link
          href={order.tableSessionId ? `/orders?session=${order.tableSessionId}&type=${order.orderType === "BAR" ? "BAR" : "DINE_IN"}` : "/orders"}
          className="text-sm underline"
        >
          Back to orders
        </Link>
      </p>
      <OrderWorkspace
        order={order}
        categories={categories}
        abilities={abilities}
        discounts={discounts}
        fulfillment={fulfillment}
        heldCourses={heldCourses}
        otherChecks={otherChecks}
        allergens={allergens}
        loyalty={loyalty}
      />
    </>
  );
}
