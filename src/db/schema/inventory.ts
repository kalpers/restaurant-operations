import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { cost, quantity } from "../helpers/numeric";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { locations, organizations } from "./organization";
import { unitsOfMeasure } from "./recipes";

// Inventory authority: `inventory_transactions` is the append-only ledger and the only
// history; `inventory_balances` is a projection updated in the same transaction as every
// posting and reconciled against the ledger in tests. Quantities are in the item's base
// stock unit unless a column says otherwise. Sign: positive adds stock, negative removes it.

const TRANSACTION_TYPES =
  "'RECEIVE', 'CONSUME', 'WASTE', 'ADJUST_INCREASE', 'ADJUST_DECREASE', 'COUNT_INCREASE', 'COUNT_DECREASE', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE_REVERSAL'";

function organizationColumn() {
  return uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" });
}

/** The ingredient and product identity that recipes and stock both use. */
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    measurementType: text("measurement_type").notNull(),
    baseUnitId: uuid("base_unit_id").notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("inventory_items_organization_id_code_unique").on(table.organizationId, table.code),
    unique("inventory_items_id_organization_id_unique").on(table.id, table.organizationId),
    unique("inventory_items_id_base_unit_id_unique").on(table.id, table.baseUnitId),
    // The base unit must be of the item's measurement type.
    foreignKey({
      name: "inventory_items_base_unit_type_fk",
      columns: [table.baseUnitId, table.measurementType],
      foreignColumns: [unitsOfMeasure.id, unitsOfMeasure.measurementType],
    }).onDelete("restrict"),
    check("inventory_items_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("inventory_items_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

/** Where an item is stocked, and its par/reorder levels there (base units). */
export const inventoryItemLocations = pgTable(
  "inventory_item_locations",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    parLevel: quantity("par_level"),
    reorderLevel: quantity("reorder_level"),
    reorderTarget: quantity("reorder_target"),
    storageNote: text("storage_note"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("inventory_item_locations_item_location_unique").on(
      table.inventoryItemId,
      table.locationId,
    ),
    foreignKey({
      name: "inventory_item_locations_item_org_fk",
      columns: [table.inventoryItemId, table.organizationId],
      foreignColumns: [inventoryItems.id, inventoryItems.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_item_locations_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    check(
      "inventory_item_locations_levels_non_negative",
      sql`coalesce(${table.parLevel}, 0) >= 0 AND coalesce(${table.reorderLevel}, 0) >= 0 AND coalesce(${table.reorderTarget}, 0) >= 0`,
    ),
    index("inventory_item_locations_location_id_idx").on(table.locationId),
  ],
);

/**
 * Packaging that generic unit conversion can't know, for one item: 1 CASE = 12 BOTTLE,
 * 1 BOTTLE = 750 ML. At most one active conversion leaves each unit, so the path to the
 * base unit is unique; services also refuse cycles.
 */
export const inventoryItemUnitConversions = pgTable(
  "inventory_item_unit_conversions",
  {
    id: uuidPrimaryKey(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    fromUnitId: uuid("from_unit_id").notNull(),
    toUnitId: uuid("to_unit_id").notNull(),
    factor: numeric("factor", { precision: 14, scale: 6, mode: "string" }).notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "inventory_item_unit_conversions_item_fk",
      columns: [table.inventoryItemId],
      foreignColumns: [inventoryItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_item_unit_conversions_from_unit_fk",
      columns: [table.fromUnitId],
      foreignColumns: [unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_item_unit_conversions_to_unit_fk",
      columns: [table.toUnitId],
      foreignColumns: [unitsOfMeasure.id],
    }).onDelete("restrict"),
    uniqueIndex("inventory_item_unit_conversions_one_active_from")
      .on(table.inventoryItemId, table.fromUnitId)
      .where(sql`${table.active}`),
    check("inventory_item_unit_conversions_factor_positive", sql`${table.factor} > 0`),
    check(
      "inventory_item_unit_conversions_distinct_units",
      sql`${table.fromUnitId} <> ${table.toUnitId}`,
    ),
  ],
);

/** Current stock and weighted-average cost per item and location: a projection of the ledger. */
export const inventoryBalances = pgTable(
  "inventory_balances",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    quantityOnHand: quantity("quantity_on_hand").notNull().default("0"),
    weightedAverageCost: cost("weighted_average_cost"),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("inventory_balances_item_location_unique").on(table.inventoryItemId, table.locationId),
    foreignKey({
      name: "inventory_balances_item_org_fk",
      columns: [table.inventoryItemId, table.organizationId],
      foreignColumns: [inventoryItems.id, inventoryItems.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_balances_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    check(
      "inventory_balances_cost_non_negative",
      sql`${table.weightedAverageCost} IS NULL OR ${table.weightedAverageCost} >= 0`,
    ),
  ],
);

/**
 * The authoritative, append-only ledger. A trigger refuses updates and deletes; a correction
 * is a compensating row. `sequence` orders rows exactly, which counts use to detect activity
 * after a snapshot. `quantity_after` and `average_cost_after` record the posted result, so
 * valuation can be reproduced from history alone.
 */
export const inventoryTransactions = pgTable(
  "inventory_transactions",
  {
    id: uuidPrimaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    organizationId: organizationColumn(),
    locationId: uuid("location_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    transactionType: text("transaction_type").notNull(),
    /** As entered, signed like `base_quantity_delta`. */
    quantity: quantity("quantity").notNull(),
    unitOfMeasureId: uuid("unit_of_measure_id").notNull(),
    baseQuantityDelta: quantity("base_quantity_delta").notNull(),
    /** Base-unit cost of this movement, where it has one. */
    unitCost: cost("unit_cost"),
    totalCost: cost("total_cost"),
    quantityAfter: quantity("quantity_after").notNull(),
    averageCostAfter: cost("average_cost_after"),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),
    /** SALE_REVERSAL only: the order CONSUME row this compensates. At most one reversal each. */
    reversesTransactionId: uuid("reverses_transaction_id"),
    reasonCode: text("reason_code"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "inventory_transactions_unit_fk",
      columns: [table.unitOfMeasureId],
      foreignColumns: [unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_transactions_created_by_fk",
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    unique("inventory_transactions_sequence_unique").on(table.sequence),
    foreignKey({
      name: "inventory_transactions_item_org_fk",
      columns: [table.inventoryItemId, table.organizationId],
      foreignColumns: [inventoryItems.id, inventoryItems.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_transactions_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    check(
      "inventory_transactions_type_valid",
      sql`${table.transactionType} IN (${sql.raw(TRANSACTION_TYPES)})`,
    ),
    check(
      "inventory_transactions_direction_matches_type",
      sql`(${table.transactionType} IN ('RECEIVE', 'ADJUST_INCREASE', 'COUNT_INCREASE', 'TRANSFER_IN', 'SALE_REVERSAL') AND ${table.baseQuantityDelta} > 0 AND ${table.quantity} > 0)
        OR (${table.transactionType} IN ('CONSUME', 'WASTE', 'ADJUST_DECREASE', 'COUNT_DECREASE', 'TRANSFER_OUT') AND ${table.baseQuantityDelta} < 0 AND ${table.quantity} < 0)`,
    ),
    check(
      "inventory_transactions_reason_required",
      sql`${table.transactionType} NOT IN ('WASTE', 'ADJUST_INCREASE', 'ADJUST_DECREASE') OR ${table.reasonCode} IS NOT NULL`,
    ),
    check(
      "inventory_transactions_reference_pair",
      sql`(${table.referenceType} IS NULL) = (${table.referenceId} IS NULL)`,
    ),
    index("inventory_transactions_item_location_sequence_idx").on(
      table.inventoryItemId,
      table.locationId,
      table.sequence,
    ),
    index("inventory_transactions_location_business_date_idx").on(
      table.locationId,
      table.businessDate,
    ),
    index("inventory_transactions_reference_idx").on(table.referenceType, table.referenceId),
    foreignKey({
      name: "inventory_transactions_reverses_fk",
      columns: [table.reversesTransactionId],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
    check(
      "inventory_transactions_reversal_link",
      sql`(${table.transactionType} = 'SALE_REVERSAL') = (${table.reversesTransactionId} IS NOT NULL)`,
    ),
    uniqueIndex("inventory_transactions_reverses_unique").on(table.reversesTransactionId),
    // One submitted Order Item consumes each Inventory Item at most once (retry safety).
    uniqueIndex("inventory_transactions_order_item_consume_unique")
      .on(table.referenceId, table.inventoryItemId)
      .where(
        sql`${table.transactionType} = 'CONSUME' AND ${table.referenceType} = 'ORDER_ITEM'`,
      ),
  ],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("suppliers_organization_id_code_unique").on(table.organizationId, table.code),
    unique("suppliers_id_organization_id_unique").on(table.id, table.organizationId),
    check("suppliers_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("suppliers_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

/**
 * How one supplier sells one item. `base_units_per_purchase` is computed from the item's
 * conversions when saved. `last_unit_cost` is a convenience, not history: receipts and
 * `supplier_item_cost_history` are. There is no preferred-supplier field.
 */
export const supplierItems = pgTable(
  "supplier_items",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    supplierId: uuid("supplier_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    supplierSku: text("supplier_sku"),
    purchaseUnitId: uuid("purchase_unit_id")
      .notNull()
      .references(() => unitsOfMeasure.id, { onDelete: "restrict" }),
    baseUnitsPerPurchase: quantity("base_units_per_purchase").notNull(),
    lastUnitCost: cost("last_unit_cost"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("supplier_items_supplier_item_unit_unique").on(
      table.supplierId,
      table.inventoryItemId,
      table.purchaseUnitId,
    ),
    unique("supplier_items_id_supplier_id_unique").on(table.id, table.supplierId),
    foreignKey({
      name: "supplier_items_supplier_org_fk",
      columns: [table.supplierId, table.organizationId],
      foreignColumns: [suppliers.id, suppliers.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "supplier_items_item_org_fk",
      columns: [table.inventoryItemId, table.organizationId],
      foreignColumns: [inventoryItems.id, inventoryItems.organizationId],
    }).onDelete("restrict"),
    check("supplier_items_base_units_positive", sql`${table.baseUnitsPerPurchase} > 0`),
    check(
      "supplier_items_last_cost_non_negative",
      sql`${table.lastUnitCost} IS NULL OR ${table.lastUnitCost} >= 0`,
    ),
    index("supplier_items_inventory_item_id_idx").on(table.inventoryItemId),
  ],
);

/** Append-only record of each supplier price seen: entered by hand or paid on a receipt. */
export const supplierItemCostHistory = pgTable(
  "supplier_item_cost_history",
  {
    id: uuidPrimaryKey(),
    supplierItemId: uuid("supplier_item_id").notNull(),
    /** Per purchase unit. */
    unitCost: cost("unit_cost").notNull(),
    source: text("source").notNull(),
    receiptLineId: uuid("receipt_line_id"),
    recordedByUserId: uuid("recorded_by_user_id"),
    recordedAt: timestamptz("recorded_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "supplier_item_cost_history_supplier_item_fk",
      columns: [table.supplierItemId],
      foreignColumns: [supplierItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "supplier_item_cost_history_recorded_by_fk",
      columns: [table.recordedByUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check("supplier_item_cost_history_source_valid", sql`${table.source} IN ('MANUAL', 'RECEIPT')`),
    check("supplier_item_cost_history_cost_non_negative", sql`${table.unitCost} >= 0`),
    index("supplier_item_cost_history_item_recorded_idx").on(
      table.supplierItemId,
      table.recordedAt,
    ),
  ],
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    locationId: uuid("location_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    poNumber: text("po_number").notNull(),
    status: text("status").notNull().default("DRAFT"),
    expectedAt: timestamptz("expected_at"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    submittedAt: timestamptz("submitted_at"),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, {
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
  (table) => [
    unique("purchase_orders_location_po_number_unique").on(table.locationId, table.poNumber),
    unique("purchase_orders_location_sequence_unique").on(table.locationId, table.sequenceNumber),
    foreignKey({
      name: "purchase_orders_supplier_org_fk",
      columns: [table.supplierId, table.organizationId],
      foreignColumns: [suppliers.id, suppliers.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_orders_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    check(
      "purchase_orders_status_valid",
      sql`${table.status} IN ('DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')`,
    ),
    check(
      "purchase_orders_submission_recorded",
      sql`${table.status} IN ('DRAFT') OR (${table.status} = 'CANCELLED' AND ${table.submittedAt} IS NULL) OR (${table.submittedAt} IS NOT NULL AND ${table.submittedByUserId} IS NOT NULL)`,
    ),
    check(
      "purchase_orders_cancellation_recorded",
      sql`${table.status} <> 'CANCELLED' OR (${table.cancelledAt} IS NOT NULL AND ${table.cancelledByUserId} IS NOT NULL)`,
    ),
    index("purchase_orders_location_status_idx").on(table.locationId, table.status),
  ],
);

/**
 * A snapshot of the ordering decision: price, unit and conversion as they were then. Later
 * supplier-item edits never change it. Received quantities come from receipt lines.
 */
export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuidPrimaryKey(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    supplierItemId: uuid("supplier_item_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    purchaseUnitId: uuid("purchase_unit_id").notNull(),
    baseUnitsPerPurchase: quantity("base_units_per_purchase").notNull(),
    orderedQuantity: quantity("ordered_quantity").notNull(),
    /** Per purchase unit. */
    unitPrice: cost("unit_price").notNull(),
    lineTotal: cost("line_total").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "purchase_order_lines_order_fk",
      columns: [table.purchaseOrderId],
      foreignColumns: [purchaseOrders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_order_lines_supplier_item_fk",
      columns: [table.supplierItemId],
      foreignColumns: [supplierItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_order_lines_item_fk",
      columns: [table.inventoryItemId],
      foreignColumns: [inventoryItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_order_lines_unit_fk",
      columns: [table.purchaseUnitId],
      foreignColumns: [unitsOfMeasure.id],
    }).onDelete("restrict"),
    unique("purchase_order_lines_order_supplier_item_unique").on(
      table.purchaseOrderId,
      table.supplierItemId,
    ),
    check("purchase_order_lines_quantity_positive", sql`${table.orderedQuantity} > 0`),
    check("purchase_order_lines_price_non_negative", sql`${table.unitPrice} >= 0`),
    check("purchase_order_lines_base_units_positive", sql`${table.baseUnitsPerPurchase} > 0`),
  ],
);

/** One delivery against a purchase order. Append-only once written. */
export const purchaseOrderReceipts = pgTable(
  "purchase_order_receipts",
  {
    id: uuidPrimaryKey(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    locationId: uuid("location_id").notNull(),
    receivedAt: timestamptz("received_at").notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    receivedByUserId: uuid("received_by_user_id").notNull(),
    supplierReference: text("supplier_reference"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (table) => [index("purchase_order_receipts_order_idx").on(table.purchaseOrderId)],
);

/** What arrived, at what actual cost, and the RECEIVE ledger row it posted. Append-only. */
export const purchaseOrderReceiptLines = pgTable(
  "purchase_order_receipt_lines",
  {
    id: uuidPrimaryKey(),
    receiptId: uuid("receipt_id").notNull(),
    purchaseOrderLineId: uuid("purchase_order_line_id").notNull(),
    receivedQuantity: quantity("received_quantity").notNull(),
    purchaseUnitId: uuid("purchase_unit_id").notNull(),
    /** Actual price paid per purchase unit, which may differ from the PO line. */
    actualUnitCost: cost("actual_unit_cost").notNull(),
    baseQuantity: quantity("base_quantity").notNull(),
    baseUnitCost: cost("base_unit_cost").notNull(),
    totalCost: cost("total_cost").notNull(),
    inventoryTransactionId: uuid("inventory_transaction_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "purchase_order_receipt_lines_receipt_fk",
      columns: [table.receiptId],
      foreignColumns: [purchaseOrderReceipts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_order_receipt_lines_order_line_fk",
      columns: [table.purchaseOrderLineId],
      foreignColumns: [purchaseOrderLines.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_order_receipt_lines_unit_fk",
      columns: [table.purchaseUnitId],
      foreignColumns: [unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "purchase_order_receipt_lines_transaction_fk",
      columns: [table.inventoryTransactionId],
      foreignColumns: [inventoryTransactions.id],
    }).onDelete("restrict"),
    check("purchase_order_receipt_lines_quantity_positive", sql`${table.receivedQuantity} > 0`),
    check("purchase_order_receipt_lines_cost_non_negative", sql`${table.actualUnitCost} >= 0`),
    index("purchase_order_receipt_lines_order_line_idx").on(table.purchaseOrderLineId),
  ],
);

export const inventoryCounts = pgTable(
  "inventory_counts",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    locationId: uuid("location_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("DRAFT"),
    notes: text("notes"),
    startedByUserId: uuid("started_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    countedAt: timestamptz("counted_at"),
    submittedAt: timestamptz("submitted_at"),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamptz("approved_at"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    activityAcknowledgedAt: timestamptz("activity_acknowledged_at"),
    activityAcknowledgedByUserId: uuid("activity_acknowledged_by_user_id").references(
      () => users.id,
      { onDelete: "restrict" },
    ),
    cancelledAt: timestamptz("cancelled_at"),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "inventory_counts_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    check(
      "inventory_counts_status_valid",
      sql`${table.status} IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED')`,
    ),
    check(
      "inventory_counts_approval_recorded",
      sql`${table.status} <> 'APPROVED' OR (${table.approvedAt} IS NOT NULL AND ${table.approvedByUserId} IS NOT NULL)`,
    ),
    check(
      "inventory_counts_acknowledgement_pair",
      sql`(${table.activityAcknowledgedAt} IS NULL) = (${table.activityAcknowledgedByUserId} IS NULL)`,
    ),
    index("inventory_counts_location_status_idx").on(table.locationId, table.status),
  ],
);

/**
 * One item in a count, in its base unit. `expected_quantity` and `snapshot_sequence` are
 * captured together under the balance lock; any ledger row for the item with a higher
 * sequence is activity after the snapshot.
 */
export const inventoryCountLines = pgTable(
  "inventory_count_lines",
  {
    id: uuidPrimaryKey(),
    inventoryCountId: uuid("inventory_count_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    unitOfMeasureId: uuid("unit_of_measure_id").notNull(),
    expectedQuantity: quantity("expected_quantity").notNull(),
    snapshotSequence: bigint("snapshot_sequence", { mode: "number" }).notNull(),
    snapshotAt: timestamptz("snapshot_at").notNull(),
    countedQuantity: quantity("counted_quantity"),
    varianceQuantity: quantity("variance_quantity"),
    notes: text("notes"),
    inventoryTransactionId: uuid("inventory_transaction_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "inventory_count_lines_count_fk",
      columns: [table.inventoryCountId],
      foreignColumns: [inventoryCounts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_count_lines_item_fk",
      columns: [table.inventoryItemId],
      foreignColumns: [inventoryItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_count_lines_unit_fk",
      columns: [table.unitOfMeasureId],
      foreignColumns: [unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_count_lines_transaction_fk",
      columns: [table.inventoryTransactionId],
      foreignColumns: [inventoryTransactions.id],
    }).onDelete("restrict"),
    unique("inventory_count_lines_count_item_unique").on(
      table.inventoryCountId,
      table.inventoryItemId,
    ),
    check(
      "inventory_count_lines_counted_non_negative",
      sql`${table.countedQuantity} IS NULL OR ${table.countedQuantity} >= 0`,
    ),
    check(
      "inventory_count_lines_variance_matches",
      sql`(${table.countedQuantity} IS NULL AND ${table.varianceQuantity} IS NULL) OR ${table.varianceQuantity} = ${table.countedQuantity} - ${table.expectedQuantity}`,
    ),
  ],
);
