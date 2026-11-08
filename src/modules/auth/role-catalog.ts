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

/** What anyone on staff can do for themselves in Scheduling. */
const SCHEDULE_SELF_SERVICE: readonly PermissionCode[] = [
  "schedule.view",
  "schedule.availability.self",
  "schedule.time-off.request",
  "schedule.swap.request",
];

/** Clearing up after a party, which floor staff do during service. */
const SESSION_CLOSE_OUT: readonly PermissionCode[] = [
  "restaurant.complete-session",
  "restaurant.clean-table",
];

const SERVER_PERMISSIONS: readonly PermissionCode[] = [
  "restaurant.view",
  ...SESSION_CLOSE_OUT,
  "menu.view",
  "orders.create",
  "orders.submit",
  ...SCHEDULE_SELF_SERVICE,
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
    description:
      "Day-to-day operations and management-level HR records, without restricted HR or security administration.",
    permissions: [
      "admin.users.view",
      "organization.view",
      "locations.view",
      "employees.view",
      "hr.view",
      "hr.certifications.view",
      "hr.certifications.manage",
      "hr.performance.view",
      "hr.performance.manage",
      "hr.notes.view",
      "hr.notes.manage",
      "schedule.view",
      "schedule.edit",
      "schedule.generate",
      "schedule.publish",
      "schedule.availability.self",
      "schedule.availability.manage",
      "schedule.time-off.request",
      "schedule.time-off.approve",
      "schedule.swap.request",
      "schedule.swap.approve",
      "schedule.templates.manage",
      "schedule.rules.manage",
      "restaurant.view",
      "restaurant.tables.manage",
      "restaurant.sections.manage",
      "restaurant.seat",
      "restaurant.move",
      "restaurant.complete-session",
      "restaurant.cancel-session",
      "restaurant.clean-table",
      "restaurant.condition.manage",
      "restaurant.server.assign",
      "restaurant.capacity.override",
      "restaurant.schedule.override",
      "reservations.view",
      "reservations.manage",
      "reservations.override-hold",
      "waitlist.view",
      "waitlist.manage",
      "waitlist.notify",
      "waitlist.seat",
      "menu.view",
      "menu.edit",
      "menu.pricing.view",
      "menu.pricing.edit",
      "menu.modifiers.manage",
      "prep-stations.manage",
      "recipes.view",
      "recipes.edit",
      "inventory.view",
      "inventory.receive",
      "inventory.adjust",
      "inventory.count",
      "inventory.count.approve",
      "inventory.waste",
      "inventory.transfer",
      "inventory.configure",
      "inventory.cost.view",
      "purchasing.view",
      "purchasing.manage",
      "purchasing.submit",
      "suppliers.manage",
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
      "restaurant.seat",
      "restaurant.move",
      "restaurant.server.assign",
      ...SESSION_CLOSE_OUT,
      "reservations.view",
      "reservations.manage",
      "waitlist.view",
      "waitlist.manage",
      "waitlist.notify",
      "waitlist.seat",
      ...SCHEDULE_SELF_SERVICE,
    ],
  },
  {
    code: "COOK",
    name: "Cook",
    description: "Fulfills kitchen tickets.",
    permissions: [
      "kitchen.view",
      "kitchen.manage",
      "menu.view",
      "inventory.view",
      "inventory.waste",
      ...SCHEDULE_SELF_SERVICE,
    ],
  },
  {
    code: "WAIT_STAFF",
    name: "Wait Staff",
    description: "Support staff who run food and clear tables, without order entry.",
    permissions: [
      "restaurant.view",
      "restaurant.clean-table",
      "menu.view",
      "kitchen.view",
      ...SCHEDULE_SELF_SERVICE,
    ],
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
      "inventory.count.approve",
      "inventory.waste",
      "inventory.transfer",
      "inventory.configure",
      "inventory.cost.view",
      "purchasing.view",
      "purchasing.manage",
      "purchasing.submit",
      "suppliers.manage",
      "menu.view",
      ...SCHEDULE_SELF_SERVICE,
      "reports.view",
      "reports.inventory",
    ],
  },
];
