import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { quantity } from "../helpers/numeric";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { idempotencyRecords } from "./infrastructure";
import { inventoryItems, inventoryTransactions } from "./inventory";
import { prepStations } from "./menu";
import { orderItemInventoryConsumption, orderItems, orders, orderSendBatches } from "./orders";
import { locations, organizations } from "./organization";
import { unitsOfMeasure } from "./recipes";

// Domain 11: Kitchen and Bar. One fulfillment model for every station: a ticket per send
// batch (or Remake) and prep station, holding one work item per routed Order Item. Ticket
// status is derived from its items and never stored. Every display field is a snapshot taken
// at SEND, so later Menu, routing or table changes never move or rename submitted work.

/** One station's share of one send batch (attempt 1) or of one Remake (attempt 2+). */
export const kitchenTickets = pgTable(
  "kitchen_tickets",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    prepStationId: uuid("prep_station_id").notNull(),
    orderId: uuid("order_id").notNull(),
    sendBatchId: uuid("send_batch_id").notNull(),
    /** Null for the original submission; set for a Remake attempt. */
    remakeId: uuid("remake_id"),
    attemptNumber: integer("attempt_number").notNull(),
    businessDate: businessDate().notNull(),
    submittedAt: timestamptz("submitted_at").notNull(),
    stationCodeSnapshot: text("station_code_snapshot").notNull(),
    stationNameSnapshot: text("station_name_snapshot").notNull(),
    stationTypeSnapshot: text("station_type_snapshot").notNull(),
    orderNumberSnapshot: integer("order_number_snapshot").notNull(),
    orderTypeSnapshot: text("order_type_snapshot").notNull(),
    batchNumberSnapshot: integer("batch_number_snapshot").notNull(),
    /** Table numbers held by the session at SEND, e.g. "T01+T02". Null for takeout. */
    tableLabelSnapshot: text("table_label_snapshot"),
    /** Takeout pickup label at SEND. */
    pickupLabelSnapshot: text("pickup_label_snapshot"),
    serverNameSnapshot: text("server_name_snapshot"),
    createdAt: createdAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "kitchen_tickets_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "kitchen_tickets_station_location_fk",
      columns: [table.prepStationId, table.locationId],
      foreignColumns: [prepStations.id, prepStations.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "kitchen_tickets_order_fk",
      columns: [table.orderId],
      foreignColumns: [orders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "kitchen_tickets_batch_order_fk",
      columns: [table.sendBatchId, table.orderId],
      foreignColumns: [orderSendBatches.id, orderSendBatches.orderId],
    }).onDelete("restrict"),
    foreignKey({
      name: "kitchen_tickets_remake_fk",
      columns: [table.remakeId],
      foreignColumns: [kitchenRemakes.id],
    }).onDelete("restrict"),
    uniqueIndex("kitchen_tickets_batch_station_unique")
      .on(table.sendBatchId, table.prepStationId)
      .where(sql`${table.remakeId} IS NULL`),
    unique("kitchen_tickets_remake_station_unique").on(table.remakeId, table.prepStationId),
    check(
      "kitchen_tickets_attempt_valid",
      sql`${table.attemptNumber} > 0 AND (${table.remakeId} IS NULL) = (${table.attemptNumber} = 1)`,
    ),
    check("kitchen_tickets_station_type_valid", sql`${table.stationTypeSnapshot} IN ('KITCHEN', 'BAR')`),
    check(
      "kitchen_tickets_order_type_valid",
      sql`${table.orderTypeSnapshot} IN ('DINE_IN', 'BAR', 'TAKEOUT')`,
    ),
    index("kitchen_tickets_location_submitted_idx").on(table.locationId, table.submittedAt, table.id),
    index("kitchen_tickets_order_idx").on(table.orderId),
  ],
);



/** One routed Order Item at one station, for one attempt. */
export const kitchenTicketItems = pgTable(
  "kitchen_ticket_items",
  {
    id: uuidPrimaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => kitchenTickets.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    prepStationId: uuid("prep_station_id").notNull(),
    orderId: uuid("order_id").notNull(),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull().default("NEW"),
    quantity: integer("quantity").notNull(),
    menuItemCodeSnapshot: text("menu_item_code_snapshot").notNull(),
    menuItemNameSnapshot: text("menu_item_name_snapshot").notNull(),
    /** [{ groupName, code, name, preparationInstruction }] in selection order. */
    modifierSnapshots: jsonb("modifier_snapshots").notNull(),
    kitchenInstructionsSnapshot: text("kitchen_instructions_snapshot"),
    submittedAt: timestamptz("submitted_at").notNull(),
    startedAt: timestamptz("started_at"),
    startedByUserId: uuid("started_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    readyAt: timestamptz("ready_at"),
    readyByUserId: uuid("ready_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    completedAt: timestamptz("completed_at"),
    completedByUserId: uuid("completed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    cancelledAt: timestamptz("cancelled_at"),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    cancelReason: text("cancel_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "kitchen_ticket_items_station_location_fk",
      columns: [table.prepStationId, table.locationId],
      foreignColumns: [prepStations.id, prepStations.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "kitchen_ticket_items_order_fk",
      columns: [table.orderId],
      foreignColumns: [orders.id],
    }).onDelete("restrict"),
    unique("kitchen_ticket_items_item_station_attempt_unique").on(
      table.orderItemId,
      table.prepStationId,
      table.attemptNumber,
    ),
    check(
      "kitchen_ticket_items_status_valid",
      sql`${table.status} IN ('NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED')`,
    ),
    check("kitchen_ticket_items_quantity_positive", sql`${table.quantity} > 0`),
    check("kitchen_ticket_items_attempt_positive", sql`${table.attemptNumber} > 0`),
    check(
      "kitchen_ticket_items_lifecycle_fields",
      sql`(${table.startedAt} IS NULL) = (${table.startedByUserId} IS NULL)
        AND (${table.readyAt} IS NULL) = (${table.readyByUserId} IS NULL)
        AND (${table.completedAt} IS NULL) = (${table.completedByUserId} IS NULL)
        AND (${table.cancelledAt} IS NULL) = (${table.cancelledByUserId} IS NULL)
        AND (${table.status} = 'CANCELLED') = (${table.cancelledAt} IS NOT NULL)
        AND (${table.status} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)
        AND (${table.readyAt} IS NULL OR ${table.startedAt} IS NOT NULL)
        AND (${table.completedAt} IS NULL OR ${table.readyAt} IS NOT NULL)
        AND (${table.status} <> 'NEW' OR ${table.startedAt} IS NULL)
        AND (${table.status} <> 'PREPARING' OR (${table.startedAt} IS NOT NULL AND ${table.readyAt} IS NULL))
        AND (${table.status} <> 'READY' OR ${table.readyAt} IS NOT NULL)
        AND (${table.status} <> 'CANCELLED' OR length(trim(coalesce(${table.cancelReason}, ''))) > 0)`,
    ),
    index("kitchen_ticket_items_queue_idx").on(
      table.locationId,
      table.status,
      table.submittedAt,
      table.id,
    ),
    index("kitchen_ticket_items_ticket_idx").on(table.ticketId),
    index("kitchen_ticket_items_order_item_idx").on(table.orderItemId),
  ],
);

/** Append-only: the initial NEW and every later transition, with actor, time and reason. */
export const kitchenTicketItemStatusHistory = pgTable(
  "kitchen_ticket_item_status_history",
  {
    id: uuidPrimaryKey(),
    ticketItemId: uuid("ticket_item_id").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    changedByUserId: uuid("changed_by_user_id"),
    occurredAt: timestamptz("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "kitchen_item_history_item_fk",
      columns: [table.ticketItemId],
      foreignColumns: [kitchenTicketItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "kitchen_item_history_user_fk",
      columns: [table.changedByUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check(
      "kitchen_ticket_item_status_history_status_valid",
      sql`${table.status} IN ('NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED')`,
    ),
    index("kitchen_ticket_item_status_history_item_idx").on(table.ticketItemId, table.occurredAt),
  ],
);

/** An explicit, reasoned new attempt at an Order Item. Append-only. Adds no charge. */
export const kitchenRemakes = pgTable(
  "kitchen_remakes",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    sourceTicketItemId: uuid("source_ticket_item_id").notNull(),
    reason: text("reason").notNull(),
    idempotencyRecordId: uuid("idempotency_record_id").notNull(),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    requestedAt: timestamptz("requested_at").notNull(),
    createdAt: createdAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "kitchen_remakes_idempotency_fk",
      columns: [table.idempotencyRecordId],
      foreignColumns: [idempotencyRecords.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "kitchen_remakes_source_item_fk",
      columns: [table.sourceTicketItemId],
      foreignColumns: [kitchenTicketItems.id],
    }).onDelete("restrict"),
    unique("kitchen_remakes_item_attempt_unique").on(table.orderItemId, table.attemptNumber),
    unique("kitchen_remakes_idempotency_record_unique").on(table.idempotencyRecordId),
    check("kitchen_remakes_attempt_valid", sql`${table.attemptNumber} > 1`),
    check(
      "kitchen_remakes_reason_valid",
      sql`length(trim(${table.reason})) BETWEEN 1 AND 500`,
    ),
    index("kitchen_remakes_order_item_idx").on(table.orderItemId),
  ],
);

/**
 * The additional CONSUME a Remake posted, copied from the original immutable
 * `order_item_inventory_consumption` row, never from current Recipe configuration.
 */
export const kitchenRemakeConsumption = pgTable(
  "kitchen_remake_consumption",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    remakeId: uuid("remake_id")
      .notNull()
      .references(() => kitchenRemakes.id, { onDelete: "restrict" }),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    baseQuantity: quantity("base_quantity").notNull(),
    baseUnitId: uuid("base_unit_id")
      .notNull()
      .references(() => unitsOfMeasure.id, { onDelete: "restrict" }),
    sourceConsumptionId: uuid("source_consumption_id").notNull(),
    inventoryTransactionId: uuid("inventory_transaction_id").notNull(),
    createdAt: createdAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "kitchen_remake_consumption_inventory_item_fk",
      columns: [table.inventoryItemId],
      foreignColumns: [inventoryItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "kitchen_remake_consumption_source_fk",
      columns: [table.sourceConsumptionId],
      foreignColumns: [orderItemInventoryConsumption.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "kitchen_remake_consumption_transaction_fk",
      columns: [table.inventoryTransactionId],
      foreignColumns: [inventoryTransactions.id],
    }).onDelete("restrict"),
    unique("kitchen_remake_consumption_remake_inventory_unique").on(
      table.remakeId,
      table.inventoryItemId,
    ),
    unique("kitchen_remake_consumption_transaction_unique").on(table.inventoryTransactionId),
    check("kitchen_remake_consumption_quantity_positive", sql`${table.baseQuantity} > 0`),
    index("kitchen_remake_consumption_order_item_idx").on(table.orderItemId),
  ],
);
