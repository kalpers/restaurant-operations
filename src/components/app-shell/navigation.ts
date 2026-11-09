import type { PermissionCode } from "@/modules/auth/permission-catalog";

export type NavigationItem = {
  href: string;
  label: string;
  /** Null means any signed-in user. */
  permission: PermissionCode | null;
};

const NAVIGATION: readonly NavigationItem[] = [
  { href: "/dashboard", label: "Dashboard", permission: null },
  { href: "/employees", label: "Employees", permission: "employees.view" },
  { href: "/employees/positions", label: "Positions", permission: "employees.positions.manage" },
  { href: "/employees/certification-types", label: "Certification types", permission: "hr.certifications.manage" },
  { href: "/my-schedule", label: "My schedule", permission: "schedule.view" },
  { href: "/scheduling", label: "Scheduling", permission: "schedule.view" },
  { href: "/scheduling/requests", label: "Scheduling requests", permission: "schedule.time-off.approve" },
  { href: "/scheduling/availability", label: "Availability", permission: "schedule.availability.manage" },
  { href: "/scheduling/staffing", label: "Staffing & rules", permission: "schedule.templates.manage" },
  { href: "/restaurant/floor", label: "Floor", permission: "restaurant.view" },
  { href: "/host/reservations", label: "Reservations", permission: "reservations.view" },
  { href: "/host/waitlist", label: "Waitlist", permission: "waitlist.view" },
  { href: "/orders", label: "Orders", permission: "orders.view" },
  { href: "/orders/discounts", label: "Discounts", permission: "orders.discount.manage" },
  { href: "/kitchen", label: "Kitchen", permission: "kitchen.view" },
  { href: "/bar", label: "Bar", permission: "bar.view" },
  { href: "/expo", label: "Expo", permission: "kitchen.view" },
  { href: "/menu", label: "Menu", permission: "menu.view" },
  { href: "/menu/manage", label: "Manage menu", permission: "menu.edit" },
  { href: "/menu/modifiers", label: "Modifiers", permission: "menu.modifiers.manage" },
  { href: "/menu/stations", label: "Prep stations", permission: "prep-stations.manage" },
  { href: "/recipes", label: "Recipes", permission: "recipes.view" },
  { href: "/inventory", label: "Inventory", permission: "inventory.view" },
  { href: "/inventory/counts", label: "Inventory counts", permission: "inventory.count" },
  { href: "/inventory/items", label: "Inventory items", permission: "inventory.configure" },
  { href: "/purchasing/orders", label: "Purchase orders", permission: "purchasing.view" },
  { href: "/purchasing/suppliers", label: "Suppliers", permission: "suppliers.manage" },
  { href: "/restaurant/tables", label: "Tables", permission: "restaurant.tables.manage" },
  { href: "/restaurant/sections", label: "Sections", permission: "restaurant.sections.manage" },
  { href: "/reports", label: "Reports", permission: "reports.view" },
  { href: "/admin/organization", label: "Organization", permission: "organization.view" },
  { href: "/admin/locations", label: "Locations", permission: "locations.view" },
  { href: "/admin/areas", label: "Areas", permission: "locations.view" },
  { href: "/admin/users", label: "Users", permission: "admin.users.view" },
  { href: "/admin/roles", label: "Roles", permission: "admin.roles.view" },
  { href: "/admin/permissions", label: "Permissions", permission: "admin.roles.view" },
];

/** Usability only. Every page and API enforces its own permission on the server. */
export function visibleNavigation(
  permissions: readonly PermissionCode[],
): NavigationItem[] {
  return NAVIGATION.filter(
    (item) => item.permission === null || permissions.includes(item.permission),
  );
}
