/**
 * The one authoritative list of permission codes, used by seeds, authorization,
 * navigation and tests. Codes are stable: role grants and future audit records depend
 * on them. A code here does not imply the feature exists yet.
 */
export const PERMISSION_CATALOG = [
  { code: "admin.users.view", name: "View users", category: "Administration" },
  { code: "admin.users.manage", name: "Manage users", category: "Administration" },
  { code: "admin.roles.view", name: "View roles and permissions", category: "Administration" },
  { code: "admin.roles.manage", name: "Manage roles and permissions", category: "Administration" },

  { code: "organization.view", name: "View organization", category: "Organization" },
  { code: "organization.manage", name: "Manage organization", category: "Organization" },
  { code: "locations.view", name: "View locations and areas", category: "Organization" },
  { code: "locations.manage", name: "Manage locations and areas", category: "Organization" },

  { code: "employees.view", name: "View employees", category: "Employees / HR" },
  { code: "employees.edit", name: "Edit employees", category: "Employees / HR" },
  { code: "hr.view", name: "View HR records", category: "Employees / HR" },
  { code: "hr.compensation.view", name: "View compensation", category: "Employees / HR" },
  { code: "hr.compensation.edit", name: "Edit compensation", category: "Employees / HR" },

  { code: "schedule.view", name: "View schedules", category: "Scheduling" },
  { code: "schedule.edit", name: "Edit schedules", category: "Scheduling" },
  { code: "schedule.generate", name: "Generate draft schedules", category: "Scheduling" },
  { code: "schedule.publish", name: "Publish schedules", category: "Scheduling" },

  { code: "restaurant.view", name: "View tables and seating", category: "Restaurant / Seating" },
  { code: "restaurant.manage", name: "Manage tables and seating", category: "Restaurant / Seating" },

  { code: "reservations.view", name: "View reservations", category: "Reservations" },
  { code: "reservations.manage", name: "Manage reservations", category: "Reservations" },

  { code: "menu.view", name: "View menu", category: "Menu" },
  { code: "menu.edit", name: "Edit menu", category: "Menu" },

  { code: "inventory.view", name: "View inventory", category: "Inventory" },
  { code: "inventory.receive", name: "Receive inventory", category: "Inventory" },
  { code: "inventory.adjust", name: "Adjust inventory", category: "Inventory" },
  { code: "inventory.count", name: "Count inventory", category: "Inventory" },

  { code: "orders.create", name: "Create orders", category: "Orders" },
  { code: "orders.submit", name: "Submit orders", category: "Orders" },
  { code: "orders.void", name: "Void order items", category: "Orders" },
  { code: "orders.close", name: "Close orders", category: "Orders" },

  { code: "settlements.complete", name: "Complete settlements", category: "Settlements" },

  { code: "kitchen.view", name: "View kitchen and bar tickets", category: "Kitchen" },
  { code: "kitchen.manage", name: "Manage kitchen and bar tickets", category: "Kitchen" },

  { code: "reports.view", name: "View reports", category: "Reports" },
  { code: "reports.sales", name: "View sales reports", category: "Reports" },
  { code: "reports.orders", name: "View order reports", category: "Reports" },
  { code: "reports.inventory", name: "View inventory reports", category: "Reports" },
  { code: "reports.fulfillment", name: "View fulfillment reports", category: "Reports" },
  { code: "reports.labor", name: "View labor reports", category: "Reports" },
  { code: "reports.settlements", name: "View settlement reports", category: "Reports" },
  { code: "reports.seating", name: "View seating reports", category: "Reports" },
  { code: "reports.export", name: "Export reports", category: "Reports" },

  { code: "audit.view", name: "View audit history", category: "Audit" },
] as const;

export type PermissionCode = (typeof PERMISSION_CATALOG)[number]["code"];

export const ALL_PERMISSION_CODES: readonly PermissionCode[] =
  PERMISSION_CATALOG.map((permission) => permission.code);
