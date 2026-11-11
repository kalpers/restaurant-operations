import type { AUDIT_CATEGORIES } from "@/db/schema/auditing";

// The audit registry (README section 20). Every audited action is listed here with the
// only fields its before, after and details may keep. Anything else a caller passes is
// dropped. `changedOnly` fields are recorded as `true` (changed) or `false`, never as values:
// wage amounts use this. Personal HR changes record field names only (`changedFields`).
// Viewing the audit trail itself is not audited.

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export type AuditActionDefinition = {
  category: AuditCategory;
  entityType: string;
  /** ORGANIZATION events have no location, such as role and sign-in changes. */
  scope: "LOCATION" | "ORGANIZATION";
  fields: readonly string[];
  changedOnly?: readonly string[];
};

const HR_RECORD = ["employeeId", "recordId", "kind", "status", "changedFields"] as const;
const HR_VIEW = ["employeeId", "recordId", "kind"] as const;

export const AUDIT_ACTIONS = {
  // Access
  "auth.signed-in": { category: "ACCESS", entityType: "user", scope: "ORGANIZATION", fields: [] },
  "auth.sign-in-failed": { category: "ACCESS", entityType: "user", scope: "ORGANIZATION", fields: ["reason"] },
  "auth.signed-out": { category: "ACCESS", entityType: "user", scope: "ORGANIZATION", fields: [] },

  // Sign-in throttling and password lifecycle (Phase 16). No email, password or IP is kept.
  "auth.account-locked": { category: "SECURITY", entityType: "user", scope: "ORGANIZATION", fields: [] },
  "auth.account-unlocked": { category: "SECURITY", entityType: "user", scope: "ORGANIZATION", fields: [] },
  "auth.password-changed": { category: "SECURITY", entityType: "user", scope: "ORGANIZATION", fields: [] },
  "admin.user-password-reset": { category: "SECURITY", entityType: "user", scope: "ORGANIZATION", fields: [] },

  // System operations (Phase 16). Never an event payload.
  "system.outbox-event-retried": {
    category: "SYSTEM",
    entityType: "outbox_event",
    scope: "ORGANIZATION",
    fields: ["eventType", "aggregateType", "attempts"],
  },

  // Security administration
  "auth.owner-bootstrapped": { category: "SECURITY", entityType: "user", scope: "ORGANIZATION", fields: ["roleCode"] },
  "admin.role-created": {
    category: "SECURITY",
    entityType: "role",
    scope: "ORGANIZATION",
    fields: ["roleCode", "roleName", "permissionCodes"],
  },
  "admin.role-activated": { category: "SECURITY", entityType: "role", scope: "ORGANIZATION", fields: ["roleCode", "active"] },
  "admin.role-deactivated": { category: "SECURITY", entityType: "role", scope: "ORGANIZATION", fields: ["roleCode", "active"] },
  "admin.role-permissions-replaced": {
    category: "SECURITY",
    entityType: "role",
    scope: "ORGANIZATION",
    fields: ["roleCode", "added", "removed"],
  },
  "admin.user-created": {
    category: "SECURITY",
    entityType: "user",
    scope: "ORGANIZATION",
    fields: ["roleId", "roleCode", "locationId"],
  },
  "admin.user-enabled": { category: "SECURITY", entityType: "user", scope: "ORGANIZATION", fields: ["active"] },
  "admin.user-disabled": { category: "SECURITY", entityType: "user", scope: "ORGANIZATION", fields: ["active", "reason"] },
  "admin.role-assigned": {
    category: "SECURITY",
    entityType: "user",
    scope: "ORGANIZATION",
    fields: ["roleId", "roleCode", "locationId"],
  },
  "admin.role-removed": {
    category: "SECURITY",
    entityType: "user",
    scope: "ORGANIZATION",
    fields: ["roleId", "roleCode", "locationId"],
  },

  // HR changes: identifiers, statuses, dates and changed field names; never values.
  "hr.employee-created": { category: "HR", entityType: "employee", scope: "LOCATION", fields: ["employeeNumber", "status"] },
  "hr.employee-updated": { category: "HR", entityType: "employee", scope: "LOCATION", fields: ["changedFields"] },
  "hr.status-changed": {
    category: "HR",
    entityType: "employee",
    scope: "LOCATION",
    fields: ["status", "effectiveDate"],
  },
  "hr.employee-terminated": {
    category: "HR",
    entityType: "employee",
    scope: "LOCATION",
    fields: ["status", "effectiveDate", "userDisabled"],
  },
  "hr.personal-updated": { category: "HR", entityType: "employee", scope: "LOCATION", fields: HR_RECORD },
  "hr.position-assigned": {
    category: "HR",
    entityType: "employee",
    scope: "LOCATION",
    fields: ["recordId", "positionId", "startDate", "endDate", "primary"],
  },
  "hr.position-ended": { category: "HR", entityType: "employee", scope: "LOCATION", fields: ["recordId", "positionId", "endDate"] },
  "hr.position-primary-set": { category: "HR", entityType: "employee", scope: "LOCATION", fields: ["recordId", "positionId"] },
  "hr.location-assigned": {
    category: "HR",
    entityType: "employee",
    scope: "LOCATION",
    fields: ["recordId", "assignedLocationId", "startDate", "endDate", "primary"],
  },
  "hr.location-ended": {
    category: "HR",
    entityType: "employee",
    scope: "LOCATION",
    fields: ["recordId", "assignedLocationId", "endDate"],
  },
  "hr.location-primary-set": { category: "HR", entityType: "employee", scope: "LOCATION", fields: ["recordId", "assignedLocationId"] },
  "hr.record-created": { category: "HR", entityType: "employee", scope: "LOCATION", fields: HR_RECORD },
  "hr.record-updated": { category: "HR", entityType: "employee", scope: "LOCATION", fields: HR_RECORD },
  "hr.compensation-changed": {
    category: "HR",
    entityType: "employee",
    scope: "LOCATION",
    fields: ["recordId", "positionId", "payType", "effectiveFrom", "previousRecordId", "rate"],
    changedOnly: ["rate"],
  },

  // Restricted HR reads: who looked at which employee's data.
  "hr.personal-viewed": { category: "HR", entityType: "employee", scope: "LOCATION", fields: HR_VIEW },
  "hr.compensation-viewed": { category: "HR", entityType: "employee", scope: "LOCATION", fields: HR_VIEW },
  "hr.records-viewed": { category: "HR", entityType: "employee", scope: "LOCATION", fields: HR_VIEW },
  "hr.document-downloaded": { category: "HR", entityType: "employee", scope: "LOCATION", fields: HR_VIEW },

  // Scheduling
  "scheduling.period-published": {
    category: "SCHEDULING",
    entityType: "schedule_period",
    scope: "LOCATION",
    fields: ["status", "startDate", "endDate"],
  },
  "scheduling.period-archived": {
    category: "SCHEDULING",
    entityType: "schedule_period",
    scope: "LOCATION",
    fields: ["status", "startDate", "endDate"],
  },
  "scheduling.swap-accepted": {
    category: "SCHEDULING",
    entityType: "shift_swap_request",
    scope: "LOCATION",
    fields: ["status", "shiftId", "acceptingEmployeeId"],
  },
  "scheduling.swap-approved": {
    category: "SCHEDULING",
    entityType: "shift_swap_request",
    scope: "LOCATION",
    fields: ["status", "shiftId", "requestingEmployeeId", "acceptingEmployeeId"],
  },
  "scheduling.swap-denied": {
    category: "SCHEDULING",
    entityType: "shift_swap_request",
    scope: "LOCATION",
    fields: ["status", "shiftId", "reason"],
  },

  // Time clock (Phase 18, category SCHEDULING by amendment 3). Self punches are not audited:
  // the entry is the record.
  "timeclock.manager-clock-in": {
    category: "SCHEDULING",
    entityType: "time_entry",
    scope: "LOCATION",
    fields: ["employeeNumber", "positionCode", "clockInAt"],
  },
  "timeclock.manager-clock-out": {
    category: "SCHEDULING",
    entityType: "time_entry",
    scope: "LOCATION",
    fields: ["employeeNumber", "clockOutAt"],
  },
  "timeclock.entry-adjusted": {
    category: "SCHEDULING",
    entityType: "time_entry",
    scope: "LOCATION",
    fields: ["employeeNumber", "businessDate", "changedFields", "reason"],
  },
  "timeclock.entry-voided": {
    category: "SCHEDULING",
    entityType: "time_entry",
    scope: "LOCATION",
    fields: ["employeeNumber", "businessDate", "reason"],
  },

  // Orders
  "orders.items-sent": {
    category: "ORDERS",
    entityType: "order",
    scope: "LOCATION",
    fields: ["orderNumber", "sendBatchId", "batchNumber", "itemCount", "orderItemIds"],
  },
  "orders.item-voided": {
    category: "ORDERS",
    entityType: "order",
    scope: "LOCATION",
    fields: ["orderItemId", "disposition", "reasonCode", "reason", "status", "amount"],
  },
  "orders.order-voided": {
    category: "ORDERS",
    entityType: "order",
    scope: "LOCATION",
    fields: ["status", "reasonCode", "reason", "voidedItemCount"],
  },
  "orders.discount-applied": {
    category: "ORDERS",
    entityType: "order",
    scope: "LOCATION",
    fields: ["discountId", "orderItemId", "definitionCode", "isComp", "amount", "reason"],
  },
  "orders.items-moved": {
    category: "ORDERS",
    entityType: "order",
    scope: "LOCATION",
    fields: ["fromOrderNumber", "toOrderId", "toOrderNumber", "orderItemIds", "itemCount"],
  },
  "orders.discount-removed": {
    category: "ORDERS",
    entityType: "order",
    scope: "LOCATION",
    fields: ["discountId", "orderItemId", "definitionCode", "isComp", "amount", "reason"],
  },

  // Menu and recipes
  "menu.price-changed": {
    category: "MENU",
    entityType: "menu_item",
    scope: "LOCATION",
    fields: ["priceId", "price", "effectiveFrom"],
  },
  "menu.item-created": {
    category: "MENU",
    entityType: "menu_item",
    scope: "LOCATION",
    fields: ["itemCode", "name", "active", "available"],
  },
  "menu.item-updated": {
    category: "MENU",
    entityType: "menu_item",
    scope: "LOCATION",
    fields: ["itemCode", "name", "active", "available", "changedFields"],
  },
  // Phase 19 per-location 86 board. Reasons are short operational text.
  "menu.item-marked-out": {
    category: "MENU",
    entityType: "menu_item",
    scope: "LOCATION",
    fields: ["itemCode", "outageId", "reason"],
  },
  "menu.item-restored": {
    category: "MENU",
    entityType: "menu_item",
    scope: "LOCATION",
    fields: ["itemCode", "outageId"],
  },
  "menu.sell-anyway-set": {
    category: "MENU",
    entityType: "menu_item",
    scope: "LOCATION",
    fields: ["itemCode", "overrideId", "businessDate", "reason"],
  },
  "menu.sell-anyway-cleared": {
    category: "MENU",
    entityType: "menu_item",
    scope: "LOCATION",
    fields: ["itemCode", "overrideId", "businessDate"],
  },
  "menu.stock-availability-setting-changed": {
    category: "MENU",
    entityType: "location",
    scope: "LOCATION",
    fields: ["enabled"],
  },
  // Phase 17 tax configuration. The rate percentage is configuration, not pay.
  "tax.category-created": {
    category: "MENU",
    entityType: "tax_category",
    scope: "ORGANIZATION",
    fields: ["code", "name", "active"],
  },
  "tax.category-updated": {
    category: "MENU",
    entityType: "tax_category",
    scope: "ORGANIZATION",
    fields: ["code", "name", "active", "changedFields"],
  },
  "tax.rate-changed": {
    category: "MENU",
    entityType: "tax_category",
    scope: "LOCATION",
    fields: ["categoryCode", "recordId", "percent", "effectiveFrom"],
  },
  "tax.location-setting-changed": {
    category: "MENU",
    entityType: "location",
    scope: "LOCATION",
    fields: ["enabled"],
  },
  "recipes.revision-created": {
    category: "MENU",
    entityType: "recipe",
    scope: "LOCATION",
    fields: ["revisionId", "versionNumber", "status"],
  },
  "recipes.revision-published": {
    category: "MENU",
    entityType: "recipe",
    scope: "LOCATION",
    fields: ["revisionId", "versionNumber", "status", "effectiveFrom"],
  },
  "recipes.revision-retired": {
    category: "MENU",
    entityType: "recipe",
    scope: "LOCATION",
    fields: ["revisionId", "versionNumber", "status"],
  },

  // Inventory
  "inventory.adjusted": {
    category: "INVENTORY",
    entityType: "inventory_item",
    scope: "LOCATION",
    fields: ["transactionId", "quantity", "reasonCode", "reason"],
  },
  "inventory.waste-recorded": {
    category: "INVENTORY",
    entityType: "inventory_item",
    scope: "LOCATION",
    fields: ["transactionId", "quantity", "reasonCode", "reason"],
  },
  "inventory.transferred": {
    category: "INVENTORY",
    entityType: "inventory_item",
    scope: "LOCATION",
    fields: ["transferId", "quantity", "destinationLocationId"],
  },
  "inventory.count-approved": {
    category: "INVENTORY",
    entityType: "inventory_count",
    scope: "LOCATION",
    fields: ["countNumber", "status", "lineCount", "varianceCount"],
  },
  "inventory.po-received": {
    category: "INVENTORY",
    entityType: "purchase_order",
    scope: "LOCATION",
    fields: ["receiptId", "poNumber", "status", "lineCount"],
  },
  // Phase 19: drafts made from the low-stock shortfall. Never submitted.
  "purchasing.suggested-orders-created": {
    category: "INVENTORY",
    entityType: "location",
    scope: "LOCATION",
    fields: ["poNumbers", "lineCount"],
  },

  // Settlements: tender details only as recorded; card data is never stored.
  "settlements.opened": {
    category: "SETTLEMENTS",
    entityType: "settlement",
    scope: "LOCATION",
    fields: ["orderId", "settlementNumber", "status", "amountDue"],
  },
  "settlements.tender-recorded": {
    category: "SETTLEMENTS",
    entityType: "settlement",
    scope: "LOCATION",
    fields: ["tenderId", "tenderType", "amount", "tipAmount", "cashReceived", "changeGiven", "description", "status"],
  },
  "settlements.tender-voided": {
    category: "SETTLEMENTS",
    entityType: "settlement",
    scope: "LOCATION",
    fields: ["tenderId", "tenderType", "amount", "status", "reason"],
  },
  "settlements.completed": {
    category: "SETTLEMENTS",
    entityType: "settlement",
    scope: "LOCATION",
    fields: ["orderId", "status", "amountDue", "businessDate"],
  },
  "settlements.cancelled": {
    category: "SETTLEMENTS",
    entityType: "settlement",
    scope: "LOCATION",
    fields: ["orderId", "status", "reason"],
  },

  // Phase 17 refunds (record only) and cash drawers. References are never copied.
  "settlements.refund-recorded": {
    category: "SETTLEMENTS",
    entityType: "order_refund",
    scope: "LOCATION",
    fields: ["orderId", "orderNumber", "refundNumber", "tenderType", "amount", "taxAmount", "businessDate"],
  },
  "settlements.refund-voided": {
    category: "SETTLEMENTS",
    entityType: "order_refund",
    scope: "LOCATION",
    fields: ["status", "amount", "tenderType", "reason"],
  },
  "drawers.drawer-created": {
    category: "SETTLEMENTS",
    entityType: "cash_drawer",
    scope: "LOCATION",
    fields: ["code", "name", "active"],
  },
  "drawers.drawer-updated": {
    category: "SETTLEMENTS",
    entityType: "cash_drawer",
    scope: "LOCATION",
    fields: ["code", "name", "active"],
  },
  "drawers.setting-changed": {
    category: "SETTLEMENTS",
    entityType: "location",
    scope: "LOCATION",
    fields: ["required"],
  },
  "drawers.session-opened": {
    category: "SETTLEMENTS",
    entityType: "cash_drawer_session",
    scope: "LOCATION",
    fields: ["drawerCode", "sessionNumber", "openingFloat"],
  },
  "drawers.session-closed": {
    category: "SETTLEMENTS",
    entityType: "cash_drawer_session",
    scope: "LOCATION",
    fields: ["sessionNumber", "openingFloat", "expectedAmount", "countedAmount", "variance"],
  },
  "drawers.paid-in": {
    category: "SETTLEMENTS",
    entityType: "cash_drawer_session",
    scope: "LOCATION",
    fields: ["movementId", "amount", "reason"],
  },
  "drawers.paid-out": {
    category: "SETTLEMENTS",
    entityType: "cash_drawer_session",
    scope: "LOCATION",
    fields: ["movementId", "amount", "reason"],
  },

  // Tip pools (Phase 18). Never per-employee amounts (policy D27).
  "tips.rule-changed": {
    category: "SETTLEMENTS",
    entityType: "tip_pool_rule",
    scope: "LOCATION",
    fields: ["active", "positions"],
  },
  "tips.distribution-finalized": {
    category: "SETTLEMENTS",
    entityType: "tip_distribution",
    scope: "LOCATION",
    fields: ["businessDate", "poolTotal", "lineCount"],
  },
  "tips.distribution-voided": {
    category: "SETTLEMENTS",
    entityType: "tip_distribution",
    scope: "LOCATION",
    fields: ["businessDate", "poolTotal", "reason"],
  },

  // Reporting
  "reports.exported": {
    category: "REPORTING",
    entityType: "report",
    scope: "LOCATION",
    fields: ["area", "from", "to", "rowCount"],
  },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export function auditActionDefinition(action: AuditAction): AuditActionDefinition {
  return AUDIT_ACTIONS[action];
}
