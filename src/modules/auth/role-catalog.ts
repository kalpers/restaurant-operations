import { ALL_PERMISSION_CODES, type PermissionCode } from "./permission-catalog";

/**
 * Identifies the Owner role for its data invariants (immutable, at least one active
 * holder). Authorization decisions never use it: they check permissions.
 */
export const OWNER_ROLE_CODE = "OWNER";

export type RoleDefinition = {
  code: string;
  name: string;
  description: string;
  permissions: readonly PermissionCode[];
};

const GENERAL_MANAGER_EXCLUDED: readonly PermissionCode[] = [
  "admin.roles.manage",
  "organization.manage",
  "hr.compensation.edit",
];

const SERVER_PERMISSIONS: readonly PermissionCode[] = [
  "restaurant.view",
  "menu.view",
  "orders.create",
  "orders.submit",
  "schedule.view",
  "settlements.complete",
];

/** The starting role-permission matrix. Later changes use a new versioned seed. */
export const ROLE_CATALOG: readonly RoleDefinition[] = [
  {
    code: OWNER_ROLE_CODE,
    name: "Owner",
    description: "Every application permission.",
    permissions: ALL_PERMISSION_CODES,
  },
  {
    code: "GENERAL_MANAGER",
    name: "General Manager",
    description:
      "Runs the restaurant, without role definitions, organization settings or compensation edits.",
    permissions: ALL_PERMISSION_CODES.filter(
      (code) => !GENERAL_MANAGER_EXCLUDED.includes(code),
    ),
  },
  {
    code: "MANAGER",
    name: "Manager",
    description: "Day-to-day operations, without HR records or security administration.",
    permissions: [
      "admin.users.view",
      "organization.view",
      "locations.view",
      "employees.view",
      "schedule.view",
      "schedule.edit",
      "schedule.generate",
      "schedule.publish",
      "restaurant.view",
      "restaurant.manage",
      "reservations.view",
      "reservations.manage",
      "menu.view",
      "menu.edit",
      "inventory.view",
      "inventory.receive",
      "inventory.adjust",
      "inventory.count",
      "orders.create",
      "orders.submit",
      "orders.void",
      "orders.close",
      "settlements.complete",
      "kitchen.view",
      "kitchen.manage",
      "reports.view",
      "reports.sales",
      "reports.orders",
      "reports.inventory",
      "reports.fulfillment",
      "reports.settlements",
      "reports.seating",
    ],
  },
  {
    code: "SERVER",
    name: "Server",
    description: "Takes and settles orders for guests.",
    permissions: SERVER_PERMISSIONS,
  },
  {
    code: "BARTENDER",
    name: "Bartender",
    description: "Takes orders and fulfills bar tickets.",
    permissions: [...SERVER_PERMISSIONS, "kitchen.view", "kitchen.manage"],
  },
  {
    code: "HOST",
    name: "Host",
    description: "Manages seating, reservations and the waitlist.",
    permissions: [
      "restaurant.view",
      "restaurant.manage",
      "reservations.view",
      "reservations.manage",
      "schedule.view",
    ],
  },
  {
    code: "COOK",
    name: "Cook",
    description: "Fulfills kitchen tickets.",
    permissions: ["kitchen.view", "kitchen.manage", "menu.view", "schedule.view"],
  },
  {
    code: "WAIT_STAFF",
    name: "Wait Staff",
    description: "Support staff who run food and clear tables, without order entry.",
    permissions: ["restaurant.view", "menu.view", "kitchen.view", "schedule.view"],
  },
  {
    code: "INVENTORY_MANAGER",
    name: "Inventory Manager",
    description: "Receives, adjusts and counts inventory.",
    permissions: [
      "inventory.view",
      "inventory.receive",
      "inventory.adjust",
      "inventory.count",
      "menu.view",
      "schedule.view",
      "reports.view",
      "reports.inventory",
    ],
  },
];
