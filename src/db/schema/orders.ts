import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { money, quantity } from "../helpers/numeric";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { employees } from "./employees";
import { guestParties } from "./guest-parties";
import { idempotencyRecords } from "./infrastructure";
import { inventoryItems, inventoryTransactions } from "./inventory";
import { menuCategories, menuItems, modifierGroups, modifiers } from "./menu";
import { locations, organizations } from "./organization";
import { recipes, recipeVersions, unitsOfMeasure } from "./recipes";
import { tableSessions } from "./restaurant";
import { taxCategories, taxRate } from "./tax";

// Domain 10: Orders. An Order references a Table Session (DINE_IN, BAR) or none
// (TAKEOUT), never a physical table. Draft items hold preview prices; SEND re-resolves and
// freezes them as immutable snapshots, posts inventory, and records a send batch. Totals are
// pre-tax and post-discount. Settlement and closure are Phase 11.

function organizationColumn() {
  return uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" });
}

/** Per-Location, per-business-date order numbering, incremented under a row lock. */
export const orderNumberCounters = pgTable(
  "order_number_counters",
  {
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    businessDate: businessDate().notNull(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (table) => [
    primaryKey({ name: "order_number_counters_pk", columns: [table.locationId, table.businessDate] }),
    check("order_number_counters_non_negative", sql`${table.lastNumber} >= 0`),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    locationId: uuid("location_id").notNull(),
    orderType: text("order_type").notNull(),
    status: text("status").notNull().default("OPEN"),
    orderNumber: integer("order_number").notNull(),
    businessDate: businessDate().notNull(),
    tableSessionId: uuid("table_session_id"),
    guestPartyId: uuid("guest_party_id"),
    /** Takeout pickup label only. No contact data. */
    customerName: text("customer_name"),
    openedByUserId: uuid("opened_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    openedByEmployeeId: uuid("opened_by_employee_id").references(() => employees.id, {
      onDelete: "restrict",
    }),
    assignedServerEmployeeId: uuid("assigned_server_employee_id").references(
      () => employees.id,
      { onDelete: "restrict" },
    ),
    openedAt: timestamptz("opened_at").notNull().defaultNow(),
    closedAt: timestamptz("closed_at"),
    voidedAt: timestamptz("voided_at"),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    voidReason: text("void_reason"),
    /** Sum of SUBMITTED line totals. */
    itemSubtotal: money("item_subtotal").notNull().default("0.00"),
    discountTotal: money("discount_total").notNull().default("0.00"),
    /** Post-discount, pre-tax amount: net sales. */
    subtotal: money("subtotal").notNull().default("0.00"),
    /** Phase 17: tax on the post-discount amount of SUBMITTED items, from their snapshots. */
    taxTotal: money("tax_total").notNull().default("0.00"),
    /**
     * Phase 20 (policy 15, D14): the part of the item prices that is tax included in them.
     * `subtotal` stays pre-tax: item subtotal − discounts − included tax. `tax_total` holds
     * both kinds, so `total_due` = `subtotal` + `tax_total` is still what the guest pays.
     */
    includedTaxTotal: money("included_tax_total").notNull().default("0.00"),
    /** Phase 20 (policy 16, D15): a tax-exempt check pays no tax. Set only while OPEN. */
    taxExempt: boolean("tax_exempt").notNull().default(false),
    taxExemptReason: text("tax_exempt_reason"),
    taxExemptReference: text("tax_exempt_reference"),
    taxExemptByUserId: uuid("tax_exempt_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    taxExemptAt: timestamptz("tax_exempt_at"),
    /** Phase 17: what the guest owes and what Settlement reconciles to. Always computed. */
    totalDue: money("total_due")
      .notNull()
      .generatedAlwaysAs(sql`subtotal + tax_total`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("orders_location_business_date_number_unique").on(
      table.locationId,
      table.businessDate,
      table.orderNumber,
    ),
    unique("orders_id_organization_id_unique").on(table.id, table.organizationId),
    foreignKey({
      name: "orders_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "orders_table_session_location_fk",
      columns: [table.tableSessionId, table.locationId],
      foreignColumns: [tableSessions.id, tableSessions.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "orders_guest_party_location_fk",
      columns: [table.guestPartyId, table.locationId],
      foreignColumns: [guestParties.id, guestParties.locationId],
    }).onDelete("restrict"),
    check("orders_type_valid", sql`${table.orderType} IN ('DINE_IN', 'BAR', 'TAKEOUT')`),
    check("orders_status_valid", sql`${table.status} IN ('OPEN', 'CLOSED', 'VOIDED')`),
    check(
      "orders_session_matches_type",
      sql`(${table.orderType} = 'TAKEOUT') = (${table.tableSessionId} IS NULL)`,
    ),
    check(
      "orders_takeout_has_no_party",
      sql`${table.orderType} <> 'TAKEOUT' OR ${table.guestPartyId} IS NULL`,
    ),
    check(
      "orders_customer_name_takeout_only",
      sql`${table.customerName} IS NULL OR (${table.orderType} = 'TAKEOUT' AND length(trim(${table.customerName})) BETWEEN 1 AND 60)`,
    ),
    check("orders_number_positive", sql`${table.orderNumber} > 0`),
    check(
      "orders_void_fields",
      sql`(${table.status} = 'VOIDED') = (${table.voidedAt} IS NOT NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidedByUserId} IS NULL)
        AND (${table.voidedAt} IS NULL OR length(trim(coalesce(${table.voidReason}, ''))) > 0)`,
    ),
    check("orders_closed_fields", sql`(${table.status} = 'CLOSED') = (${table.closedAt} IS NOT NULL)`),
    check(
      "orders_totals_valid",
      sql`${table.itemSubtotal} >= 0 AND ${table.discountTotal} >= 0
        AND ${table.discountTotal} <= ${table.itemSubtotal}
        AND ${table.subtotal} = ${table.itemSubtotal} - ${table.discountTotal} - ${table.includedTaxTotal}`,
    ),
    check("orders_tax_total_non_negative", sql`${table.taxTotal} >= 0`),
    check(
      "orders_included_tax_valid",
      sql`${table.includedTaxTotal} >= 0 AND (${table.taxExempt} OR ${table.includedTaxTotal} <= ${table.taxTotal})`,
    ),
    check(
      "orders_tax_exempt_fields",
      sql`(${table.taxExempt} = (${table.taxExemptReason} IS NOT NULL))
        AND (${table.taxExempt} = (${table.taxExemptByUserId} IS NOT NULL))
        AND (${table.taxExempt} = (${table.taxExemptAt} IS NOT NULL))
        AND (${table.taxExemptReference} IS NULL OR ${table.taxExempt})
        AND (NOT ${table.taxExempt} OR ${table.taxTotal} = 0)
        AND (${table.taxExemptReason} IS NULL OR length(trim(${table.taxExemptReason})) > 0)
        AND (${table.taxExemptReference} IS NULL OR ${table.taxExemptReference} !~ '[0-9]{13}')`,
    ),
    index("orders_table_session_status_idx").on(table.tableSessionId, table.status),
    index("orders_location_status_idx").on(table.locationId, table.status),
    index("orders_location_business_date_idx").on(table.locationId, table.businessDate),
  ],
);

export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: uuidPrimaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    reason: text("reason"),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    occurredAt: timestamptz("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("order_status_history_status_valid", sql`${table.status} IN ('OPEN', 'CLOSED', 'VOIDED')`),
    index("order_status_history_order_idx").on(table.orderId, table.occurredAt),
  ],
);

/** One SEND round: the DRAFT items it committed, numbered 1, 2, 3 per order. */
export const orderSendBatches = pgTable(
  "order_send_batches",
  {
    id: uuidPrimaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    batchNumber: integer("batch_number").notNull(),
    idempotencyRecordId: uuid("idempotency_record_id").notNull(),
    sentByUserId: uuid("sent_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    sentAt: timestamptz("sent_at").notNull(),
    businessDate: businessDate().notNull(),
    itemCount: integer("item_count").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("order_send_batches_order_number_unique").on(table.orderId, table.batchNumber),
    unique("order_send_batches_id_order_id_unique").on(table.id, table.orderId),
    foreignKey({
      name: "order_send_batches_idempotency_fk",
      columns: [table.idempotencyRecordId],
      foreignColumns: [idempotencyRecords.id],
    }).onDelete("restrict"),
    unique("order_send_batches_idempotency_record_unique").on(table.idempotencyRecordId),
    check("order_send_batches_number_positive", sql`${table.batchNumber} > 0`),
    check("order_send_batches_item_count_positive", sql`${table.itemCount} > 0`),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuidPrimaryKey(),
    orderId: uuid("order_id").notNull(),
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("DRAFT"),
    quantity: integer("quantity").notNull(),
    menuItemCodeSnapshot: text("menu_item_code_snapshot").notNull(),
    menuItemNameSnapshot: text("menu_item_name_snapshot").notNull(),
    basePriceSnapshot: money("base_price_snapshot").notNull(),
    modifierTotalSnapshot: money("modifier_total_snapshot").notNull(),
    unitPriceSnapshot: money("unit_price_snapshot").notNull(),
    lineTotalSnapshot: money("line_total_snapshot").notNull(),
    /** Free text for the kitchen. Never affects inventory. */
    specialInstructions: text("special_instructions"),
    /** Set at SEND: modifier preparation instructions plus special instructions. */
    kitchenInstructionsSnapshot: text("kitchen_instructions_snapshot"),
    /** Set at SEND: the active prep stations routed for this item (Phase 10 contract). */
    prepStationIdsSnapshot: uuid("prep_station_ids_snapshot").array(),
    recipeId: uuid("recipe_id").references(() => recipes.id, { onDelete: "restrict" }),
    recipeVersionId: uuid("recipe_version_id").references(() => recipeVersions.id, {
      onDelete: "restrict",
    }),
    sendBatchId: uuid("send_batch_id"),
    addedByUserId: uuid("added_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    submittedAt: timestamptz("submitted_at"),
    voidedAt: timestamptz("voided_at"),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    voidReason: text("void_reason"),
    /** Phase 17: course 1 to 5. Editable on drafts, frozen at SEND. */
    courseNumber: smallint("course_number").notNull().default(1),
    /** Phase 17 tax snapshot, set at SEND; all null when the Location doesn't tax. */
    taxCategoryId: uuid("tax_category_id").references(() => taxCategories.id, {
      onDelete: "restrict",
    }),
    taxCategoryCodeSnapshot: text("tax_category_code_snapshot"),
    taxRateSnapshot: taxRate("tax_rate_snapshot"),
    /** Phase 20 (policy 15): the rate's "price includes tax", snapshotted at SEND. */
    taxIncludedSnapshot: boolean("tax_included_snapshot").notNull().default(false),
    /**
     * Phase 20 (policy 1): the menu category the item was sold under, from the placement
     * the operational menu resolved at SEND. Null for drafts and for items sent before.
     */
    menuCategoryId: uuid("menu_category_id").references(() => menuCategories.id, {
      onDelete: "restrict",
    }),
    menuCategoryNameSnapshot: text("menu_category_name_snapshot"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "order_items_order_fk",
      columns: [table.orderId],
      foreignColumns: [orders.id],
    }).onDelete("restrict"),
    // Phase 17: a sent item may move to another check, so its batch may belong to the
    // order it came from. The custom migration's trigger allows that only for an item with
    // a recorded transfer from the batch's order.
    foreignKey({
      name: "order_items_send_batch_fk",
      columns: [table.sendBatchId],
      foreignColumns: [orderSendBatches.id],
    }).onDelete("restrict"),
    // Phase 20 (policy 17): SPLIT is a sent item shared between checks; its shares carry the money.
    check("order_items_status_valid", sql`${table.status} IN ('DRAFT', 'SUBMITTED', 'VOIDED', 'SPLIT')`),
    check("order_items_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "order_items_amounts_valid",
      sql`${table.basePriceSnapshot} >= 0 AND ${table.unitPriceSnapshot} >= 0
        AND ${table.unitPriceSnapshot} = ${table.basePriceSnapshot} + ${table.modifierTotalSnapshot}
        AND ${table.lineTotalSnapshot} = ${table.unitPriceSnapshot} * ${table.quantity}`,
    ),
    check(
      "order_items_send_fields",
      sql`(${table.sendBatchId} IS NULL) = (${table.submittedAt} IS NULL)
        AND (${table.status} <> 'SUBMITTED' OR ${table.sendBatchId} IS NOT NULL)
        AND (${table.status} <> 'DRAFT' OR ${table.sendBatchId} IS NULL)
        AND (${table.recipeVersionId} IS NULL OR ${table.recipeId} IS NOT NULL)`,
    ),
    check(
      "order_items_void_fields",
      sql`(${table.status} = 'VOIDED') = (${table.voidedAt} IS NOT NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidedByUserId} IS NULL)
        AND (${table.voidedAt} IS NULL OR length(trim(coalesce(${table.voidReason}, ''))) > 0)`,
    ),
    check(
      "order_items_special_instructions_length",
      sql`${table.specialInstructions} IS NULL OR length(${table.specialInstructions}) <= 500`,
    ),
    check("order_items_course_range", sql`${table.courseNumber} BETWEEN 1 AND 5`),
    check(
      "order_items_tax_snapshot_fields",
      sql`(${table.taxCategoryId} IS NULL) = (${table.taxCategoryCodeSnapshot} IS NULL)
        AND (${table.taxCategoryId} IS NULL) = (${table.taxRateSnapshot} IS NULL)
        AND (${table.status} <> 'DRAFT' OR ${table.taxCategoryId} IS NULL)
        AND (${table.taxRateSnapshot} IS NULL OR (${table.taxRateSnapshot} >= 0 AND ${table.taxRateSnapshot} <= 100))
        AND (${table.taxRateSnapshot} IS NOT NULL OR NOT ${table.taxIncludedSnapshot})`,
    ),
    check(
      "order_items_category_snapshot_fields",
      sql`(${table.menuCategoryId} IS NULL) = (${table.menuCategoryNameSnapshot} IS NULL)
        AND (${table.status} <> 'DRAFT' OR ${table.menuCategoryId} IS NULL)`,
    ),
    index("order_items_order_status_idx").on(table.orderId, table.status),
    index("order_items_send_batch_idx").on(table.sendBatchId),
  ],
);

export const orderItemModifiers = pgTable(
  "order_item_modifiers",
  {
    id: uuidPrimaryKey(),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    modifierGroupId: uuid("modifier_group_id")
      .notNull()
      .references(() => modifierGroups.id, { onDelete: "restrict" }),
    modifierId: uuid("modifier_id")
      .notNull()
      .references(() => modifiers.id, { onDelete: "restrict" }),
    modifierGroupNameSnapshot: text("modifier_group_name_snapshot").notNull(),
    modifierCodeSnapshot: text("modifier_code_snapshot").notNull(),
    modifierNameSnapshot: text("modifier_name_snapshot").notNull(),
    priceAdjustmentSnapshot: money("price_adjustment_snapshot").notNull(),
    preparationEffectTypeSnapshot: text("preparation_effect_type_snapshot").notNull(),
    preparationInstructionSnapshot: text("preparation_instruction_snapshot"),
    sortOrder: integer("sort_order").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("order_item_modifiers_item_group_modifier_unique").on(
      table.orderItemId,
      table.modifierGroupId,
      table.modifierId,
    ),
  ],
);

export const orderItemStatusHistory = pgTable(
  "order_item_status_history",
  {
    id: uuidPrimaryKey(),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    reason: text("reason"),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    occurredAt: timestamptz("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "order_item_status_history_status_valid",
      sql`${table.status} IN ('SUBMITTED', 'VOIDED')`,
    ),
    index("order_item_status_history_item_idx").on(table.orderItemId, table.occurredAt),
  ],
);

/**
 * The consumption computed once at SEND for one item and Inventory Item, with the ledger
 * row it produced and the recipe and modifier effects that explain it. Append-only.
 */
export const orderItemInventoryConsumption = pgTable(
  "order_item_inventory_consumption",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    orderItemId: uuid("order_item_id").notNull(),
    sendBatchId: uuid("send_batch_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    /** Total for the line (per-unit requirement times quantity), in the item's base unit. */
    baseQuantity: quantity("base_quantity").notNull(),
    baseUnitId: uuid("base_unit_id").notNull(),
    recipeVersionId: uuid("recipe_version_id"),
    /** Per-unit recipe requirement and the modifier effects applied to it. */
    sourceSnapshot: jsonb("source_snapshot").notNull(),
    inventoryTransactionId: uuid("inventory_transaction_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "order_item_consumption_org_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_item_consumption_item_fk",
      columns: [table.orderItemId],
      foreignColumns: [orderItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_item_consumption_batch_fk",
      columns: [table.sendBatchId],
      foreignColumns: [orderSendBatches.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_item_consumption_inventory_item_fk",
      columns: [table.inventoryItemId],
      foreignColumns: [inventoryItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_item_consumption_base_unit_fk",
      columns: [table.baseUnitId],
      foreignColumns: [unitsOfMeasure.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_item_consumption_recipe_version_fk",
      columns: [table.recipeVersionId],
      foreignColumns: [recipeVersions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_item_consumption_transaction_fk",
      columns: [table.inventoryTransactionId],
      foreignColumns: [inventoryTransactions.id],
    }).onDelete("restrict"),
    unique("order_item_inventory_consumption_item_inventory_unique").on(
      table.orderItemId,
      table.inventoryItemId,
    ),
    unique("order_item_inventory_consumption_transaction_unique").on(table.inventoryTransactionId),
    check("order_item_inventory_consumption_positive", sql`${table.baseQuantity} > 0`),
  ],
);

/** The void of a submitted item: its reason and physical disposition. Append-only. */
export const orderItemVoids = pgTable(
  "order_item_voids",
  {
    id: uuidPrimaryKey(),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    disposition: text("disposition").notNull(),
    reason: text("reason").notNull(),
    voidedByUserId: uuid("voided_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    voidedAt: timestamptz("voided_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("order_item_voids_item_unique").on(table.orderItemId),
    check(
      "order_item_voids_disposition_valid",
      sql`${table.disposition} IN ('UNPREPARED', 'PREPARED_OR_DISCARDED')`,
    ),
    check("order_item_voids_reason_not_blank", sql`length(trim(${table.reason})) > 0`),
  ],
);

/** Configured discounts. Applying one snapshots it; later edits don't change history. */
export const discountDefinitions = pgTable(
  "discount_definitions",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    scope: text("scope").notNull(),
    discountType: text("discount_type").notNull(),
    /** FIXED_AMOUNT: dollars. PERCENTAGE: percent, above 0 and at most 100. */
    value: money("value").notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("discount_definitions_organization_id_code_unique").on(table.organizationId, table.code),
    check("discount_definitions_scope_valid", sql`${table.scope} IN ('ITEM', 'ORDER')`),
    check(
      "discount_definitions_type_valid",
      sql`${table.discountType} IN ('FIXED_AMOUNT', 'PERCENTAGE')`,
    ),
    check(
      "discount_definitions_value_valid",
      sql`${table.value} > 0 AND (${table.discountType} <> 'PERCENTAGE' OR ${table.value} <= 100)`,
    ),
    check("discount_definitions_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("discount_definitions_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

function discountApplicationColumns() {
  return {
    id: uuidPrimaryKey(),
    discountDefinitionId: uuid("discount_definition_id").notNull(),
    /** Application order, for deterministic allocation. */
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    codeSnapshot: text("code_snapshot").notNull(),
    nameSnapshot: text("name_snapshot").notNull(),
    discountTypeSnapshot: text("discount_type_snapshot").notNull(),
    valueSnapshot: money("value_snapshot").notNull(),
    isComp: boolean("is_comp").notNull(),
    reason: text("reason").notNull(),
    /** Projection: recomputed exactly whenever the eligible subtotal changes. */
    appliedAmount: money("applied_amount").notNull(),
    status: text("status").notNull().default("APPLIED"),
    appliedByUserId: uuid("applied_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    appliedAt: timestamptz("applied_at").notNull(),
    removedByUserId: uuid("removed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    removedAt: timestamptz("removed_at"),
    removeReason: text("remove_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  };
}

export const orderDiscounts = pgTable(
  "order_discounts",
  {
    ...discountApplicationColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
  },
  (table) => [
    foreignKey({
      name: "order_discounts_definition_fk",
      columns: [table.discountDefinitionId],
      foreignColumns: [discountDefinitions.id],
    }).onDelete("restrict"),
    check("order_discounts_status_valid", sql`${table.status} IN ('APPLIED', 'REMOVED')`),
    check("order_discounts_amount_non_negative", sql`${table.appliedAmount} >= 0`),
    check("order_discounts_reason_not_blank", sql`length(trim(${table.reason})) > 0`),
    check(
      "order_discounts_removed_fields",
      sql`(${table.status} = 'REMOVED') = (${table.removedAt} IS NOT NULL)
        AND (${table.removedAt} IS NULL) = (${table.removedByUserId} IS NULL)`,
    ),
    check(
      "order_discounts_type_valid",
      sql`${table.discountTypeSnapshot} IN ('FIXED_AMOUNT', 'PERCENTAGE')`,
    ),
    unique("order_discounts_sequence_unique").on(table.sequence),
    index("order_discounts_order_idx").on(table.orderId),
  ],
);

export const orderItemDiscounts = pgTable(
  "order_item_discounts",
  {
    ...discountApplicationColumns(),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
  },
  (table) => [
    foreignKey({
      name: "order_item_discounts_definition_fk",
      columns: [table.discountDefinitionId],
      foreignColumns: [discountDefinitions.id],
    }).onDelete("restrict"),
    check(
      "order_item_discounts_status_valid",
      sql`${table.status} IN ('APPLIED', 'REMOVED', 'VOIDED')`,
    ),
    check("order_item_discounts_amount_non_negative", sql`${table.appliedAmount} >= 0`),
    check("order_item_discounts_reason_not_blank", sql`length(trim(${table.reason})) > 0`),
    check(
      "order_item_discounts_removed_fields",
      sql`(${table.status} = 'REMOVED') = (${table.removedAt} IS NOT NULL)
        AND (${table.removedAt} IS NULL) = (${table.removedByUserId} IS NULL)`,
    ),
    check(
      "order_item_discounts_type_valid",
      sql`${table.discountTypeSnapshot} IN ('FIXED_AMOUNT', 'PERCENTAGE')`,
    ),
    unique("order_item_discounts_sequence_unique").on(table.sequence),
    index("order_item_discounts_item_idx").on(table.orderItemId),
  ],
);

/**
 * Phase 17 tax projection: one row per (Tax Category, rate snapshot) of an Order's
 * SUBMITTED items, rewritten whenever the Order's totals are recomputed (like applied
 * discount amounts). Its tax amounts add up to `orders.tax_total`. Reports read it.
 */
export const orderTaxLines = pgTable(
  "order_tax_lines",
  {
    id: uuidPrimaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    taxCategoryId: uuid("tax_category_id")
      .notNull()
      .references(() => taxCategories.id, { onDelete: "restrict" }),
    taxCategoryCodeSnapshot: text("tax_category_code_snapshot").notNull(),
    taxRateSnapshot: taxRate("tax_rate_snapshot").notNull(),
    taxableAmount: money("taxable_amount").notNull(),
    taxAmount: money("tax_amount").notNull(),
    /** Phase 20 (policy 15): tax included in the prices rather than added on top. */
    taxIncluded: boolean("tax_included").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    unique("order_tax_lines_order_category_rate_unique").on(
      table.orderId,
      table.taxCategoryId,
      table.taxRateSnapshot,
      table.taxIncluded,
    ),
    check(
      "order_tax_lines_amounts_valid",
      sql`${table.taxableAmount} >= 0 AND ${table.taxAmount} >= 0`,
    ),
  ],
);

/**
 * Phase 17 split checks (policy C): one append-only row per item moved from one OPEN order
 * to another on the same Table Session. An item's snapshots, consumption and kitchen work
 * stay as they were; only its `order_id` changes, and only alongside one of these rows.
 */
export const orderItemTransfers = pgTable(
  "order_item_transfers",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    fromOrderId: uuid("from_order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    toOrderId: uuid("to_order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    /** One move of several items shares a group. */
    transferGroupId: uuid("transfer_group_id").notNull(),
    movedByUserId: uuid("moved_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    movedAt: timestamptz("moved_at").notNull().defaultNow(),
  },
  (table) => [
    check("order_item_transfers_different_orders", sql`${table.fromOrderId} <> ${table.toOrderId}`),
    index("order_item_transfers_item_idx").on(table.orderItemId, table.movedAt),
    index("order_item_transfers_group_idx").on(table.transferGroupId),
  ],
);

export const ORDER_ITEM_SHARE_STATUSES = ["ACTIVE", "VOIDED"] as const;

/**
 * Phase 20 (policy 17, D16): one sent item shared between checks. The original item becomes
 * SPLIT and leaves the totals; its shares carry the money (equal parts, cents by largest
 * remainder) on the checks they were given to, with the original's tax snapshot. Kitchen
 * work, consumption and modifier snapshots stay with the original, so nothing is made or
 * counted twice. A share can be voided for money only; it never touches stock.
 */
export const orderItemShares = pgTable(
  "order_item_shares",
  {
    id: uuidPrimaryKey(),
    organizationId: organizationColumn(),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    splitGroupId: uuid("split_group_id").notNull(),
    shareNumber: smallint("share_number").notNull(),
    shareCount: smallint("share_count").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    amount: money("amount").notNull(),
    taxCategoryId: uuid("tax_category_id").references(() => taxCategories.id, { onDelete: "restrict" }),
    taxCategoryCodeSnapshot: text("tax_category_code_snapshot"),
    taxRateSnapshot: taxRate("tax_rate_snapshot"),
    taxIncludedSnapshot: boolean("tax_included_snapshot").notNull().default(false),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    voidedAt: timestamptz("voided_at"),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    voidReason: text("void_reason"),
    version: versionColumn(),
  },
  (table) => [
    unique("order_item_shares_item_number_unique").on(table.orderItemId, table.shareNumber),
    check("order_item_shares_status_valid", sql`${table.status} IN ('ACTIVE', 'VOIDED')`),
    check(
      "order_item_shares_numbers_valid",
      sql`${table.shareCount} BETWEEN 2 AND 10 AND ${table.shareNumber} BETWEEN 1 AND ${table.shareCount}`,
    ),
    check("order_item_shares_amount_non_negative", sql`${table.amount} >= 0`),
    check(
      "order_item_shares_void_fields",
      sql`(${table.status} = 'VOIDED') = (${table.voidedAt} IS NOT NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidedByUserId} IS NULL)
        AND (${table.voidedAt} IS NULL OR length(trim(coalesce(${table.voidReason}, ''))) > 0)`,
    ),
    check(
      "order_item_shares_tax_fields",
      sql`(${table.taxCategoryId} IS NULL) = (${table.taxRateSnapshot} IS NULL)
        AND (${table.taxCategoryId} IS NULL) = (${table.taxCategoryCodeSnapshot} IS NULL)
        AND (${table.taxRateSnapshot} IS NOT NULL OR NOT ${table.taxIncludedSnapshot})`,
    ),
    index("order_item_shares_order_idx").on(table.orderId, table.status),
  ],
);
