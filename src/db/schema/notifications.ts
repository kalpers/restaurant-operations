import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz } from "../helpers/timestamps";
import { users } from "./auth";
import { inventoryStockAlerts } from "./inventory";
import { kitchenTickets } from "./kitchen";
import { orders } from "./orders";
import { locations, organizations } from "./organization";

// Notifications (README section 22): in-app only, for one recipient. Phase 10 writes the
// server-ready kinds when a ticket becomes READY, in the same transaction. Phase 19 adds
// INVENTORY_LOW, written by the inventory posting that opens a low-stock alert.

export const NOTIFICATION_TYPES = ["FOOD_READY", "BAR_ORDER_READY", "INVENTORY_LOW"] as const;

export const notifications = pgTable(
  "notifications",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    notificationType: text("notification_type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    kitchenTicketId: uuid("kitchen_ticket_id").references(() => kitchenTickets.id, {
      onDelete: "restrict",
    }),
    inventoryStockAlertId: uuid("inventory_stock_alert_id"),
    createdAt: createdAt(),
    readAt: timestamptz("read_at"),
  },
  (table) => [
    foreignKey({
      name: "notifications_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    unique("notifications_ticket_type_unique").on(table.kitchenTicketId, table.notificationType),
    foreignKey({
      name: "notifications_stock_alert_fk",
      columns: [table.inventoryStockAlertId],
      foreignColumns: [inventoryStockAlerts.id],
    }).onDelete("restrict"),
    unique("notifications_alert_recipient_unique").on(table.inventoryStockAlertId, table.recipientUserId),
    check(
      "notifications_type_valid",
      sql`${table.notificationType} IN ('FOOD_READY', 'BAR_ORDER_READY', 'INVENTORY_LOW')`,
    ),
    check("notifications_title_not_blank", sql`length(trim(${table.title})) > 0`),
    index("notifications_recipient_idx").on(table.recipientUserId, table.readAt, table.createdAt),
  ],
);
