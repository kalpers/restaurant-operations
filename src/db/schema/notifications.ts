import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz } from "../helpers/timestamps";
import { users } from "./auth";
import { employeeCertifications } from "./employees";
import { inventoryStockAlerts } from "./inventory";
import { kitchenTickets } from "./kitchen";
import { orders } from "./orders";
import { locations, organizations } from "./organization";
import { schedulePeriods, shiftSwapRequests, timeOffRequests } from "./scheduling";
import { timeEntries } from "./timeclock";

// Notifications (README section 22): in-app only, for one recipient. Phase 10 writes the
// server-ready kinds when a ticket becomes READY, in the same transaction. Phase 19 adds
// INVENTORY_LOW, written by the inventory posting that opens a low-stock alert. Phase 20
// (policies 11-14) adds the scheduling, time-off, certification and time-clock kinds, each
// with its own link; the time-based kinds carry a dedupe key so a repeated check sends once.

export const NOTIFICATION_TYPES = [
  "FOOD_READY",
  "BAR_ORDER_READY",
  "INVENTORY_LOW",
  "SCHEDULE_PUBLISHED",
  "SHIFT_CHANGED",
  "TIME_OFF_APPROVED",
  "TIME_OFF_DENIED",
  "CERTIFICATION_EXPIRING",
  "OVERTIME_APPROACHING",
  "MISSED_CLOCK_OUT",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

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
    schedulePeriodId: uuid("schedule_period_id").references(() => schedulePeriods.id, { onDelete: "restrict" }),
    shiftSwapRequestId: uuid("shift_swap_request_id").references(() => shiftSwapRequests.id, {
      onDelete: "restrict",
    }),
    timeOffRequestId: uuid("time_off_request_id").references(() => timeOffRequests.id, { onDelete: "restrict" }),
    employeeCertificationId: uuid("employee_certification_id"),
    timeEntryId: uuid("time_entry_id").references(() => timeEntries.id, { onDelete: "restrict" }),
    /** Phase 20: one notification per key and recipient, for the periodic checks. */
    dedupeKey: text("dedupe_key"),
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
    // Named here: the generated name would pass PostgreSQL's 63-character limit.
    foreignKey({
      name: "notifications_certification_fk",
      columns: [table.employeeCertificationId],
      foreignColumns: [employeeCertifications.id],
    }).onDelete("restrict"),
    unique("notifications_dedupe_recipient_unique").on(table.dedupeKey, table.recipientUserId),
    check(
      "notifications_type_valid",
      sql`${table.notificationType} IN ('FOOD_READY', 'BAR_ORDER_READY', 'INVENTORY_LOW', 'SCHEDULE_PUBLISHED', 'SHIFT_CHANGED', 'TIME_OFF_APPROVED', 'TIME_OFF_DENIED', 'CERTIFICATION_EXPIRING', 'OVERTIME_APPROACHING', 'MISSED_CLOCK_OUT')`,
    ),
    check(
      "notifications_link_matches_type",
      sql`(${table.notificationType} <> 'SCHEDULE_PUBLISHED' OR ${table.schedulePeriodId} IS NOT NULL)
        AND (${table.notificationType} <> 'SHIFT_CHANGED' OR ${table.shiftSwapRequestId} IS NOT NULL)
        AND (${table.notificationType} NOT IN ('TIME_OFF_APPROVED', 'TIME_OFF_DENIED') OR ${table.timeOffRequestId} IS NOT NULL)
        AND (${table.notificationType} <> 'CERTIFICATION_EXPIRING' OR (${table.employeeCertificationId} IS NOT NULL AND ${table.dedupeKey} IS NOT NULL))
        AND (${table.notificationType} NOT IN ('OVERTIME_APPROACHING', 'MISSED_CLOCK_OUT') OR (${table.timeEntryId} IS NOT NULL AND ${table.dedupeKey} IS NOT NULL))`,
    ),
    check("notifications_title_not_blank", sql`length(trim(${table.title})) > 0`),
    index("notifications_recipient_idx").on(table.recipientUserId, table.readAt, table.createdAt),
  ],
);
