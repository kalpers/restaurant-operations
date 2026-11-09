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
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { getOrderDetail } from "@/modules/orders/queries/order-queries";
import { actorHolds } from "@/modules/orders/services/access";
import { listDiscountDefinitions } from "@/modules/orders/services/discount-service";
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
  };
  const fulfillment = Object.fromEntries(await fulfillmentForOrder(database, order.id));
  const categories: MenuCategory[] = [];

  if (abilities.edit && order.status === "OPEN") {
    // Items from every open menu, grouped by category, once each.
    const menu = await getOperationalMenu(database, actor);
    const byCategory = new Map<string, MenuCategory>();

    for (const offered of menu.menus) {
      for (const category of offered.categories) {
        const entry = byCategory.get(category.id) ?? { id: category.id, name: category.name, items: [] };

        for (const item of category.items) {
          if (!entry.items.some((existing) => existing.menuItemId === item.menuItemId)) {
            entry.items.push(item);
          }
        }

        byCategory.set(category.id, entry);
      }
    }

    categories.push(...byCategory.values());
  }

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
      />
    </>
  );
}
