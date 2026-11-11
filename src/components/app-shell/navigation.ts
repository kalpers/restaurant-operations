import type { PermissionCode } from "@/modules/auth/permission-catalog";

export type NavigationGroupId = "insights" | "service" | "back-of-house" | "people" | "admin";

/** Icon names resolved to components on the client (components can't cross the server boundary). */
export type NavigationIcon =
  | "dashboard"
  | "reports"
  | "audit"
  | "floor"
  | "reservations"
  | "waitlist"
  | "orders"
  | "discounts"
  | "kitchen"
  | "bar"
  | "expo"
  | "menu"
  | "menu-manage"
  | "modifiers"
  | "stations"
  | "recipes"
  | "inventory"
  | "counts"
  | "items"
  | "purchase-orders"
  | "suppliers"
  | "my-schedule"
  | "scheduling"
  | "timeline"
  | "requests"
  | "availability"
  | "staffing"
  | "employees"
  | "positions"
  | "certifications"
  | "organization"
  | "locations"
  | "areas"
  | "users"
  | "roles"
  | "permissions"
  | "system"
  | "tables"
  | "sections"
  | "drawers"
  | "taxes"
  | "my-time"
  | "time-clock"
  | "tips"
  | "eighty-six"
  | "suggested-orders";

export type NavigationItem = {
  href: string;
  label: string;
  /** Null means any signed-in user. */
  permission: PermissionCode | null;
  group: NavigationGroupId;
  icon: NavigationIcon;
};

export type NavigationGroup = {
  id: NavigationGroupId;
  label: string;
  items: NavigationItem[];
};

const GROUP_LABELS: Record<NavigationGroupId, string> = {
  insights: "Insights",
  service: "Service",
  "back-of-house": "Back of house",
  people: "People",
  admin: "Admin",
};

const GROUP_ORDER: readonly NavigationGroupId[] = ["insights", "service", "back-of-house", "people", "admin"];

const NAVIGATION: readonly NavigationItem[] = [
  { href: "/dashboard", label: "Dashboard", permission: null, group: "insights", icon: "dashboard" },
  { href: "/reports", label: "Reports", permission: "reports.view", group: "insights", icon: "reports" },
  { href: "/audit", label: "Audit", permission: "audit.view", group: "insights", icon: "audit" },

  { href: "/restaurant/floor", label: "Floor", permission: "restaurant.view", group: "service", icon: "floor" },
  { href: "/host/reservations", label: "Reservations", permission: "reservations.view", group: "service", icon: "reservations" },
  { href: "/host/waitlist", label: "Waitlist", permission: "waitlist.view", group: "service", icon: "waitlist" },
  { href: "/orders", label: "Orders", permission: "orders.view", group: "service", icon: "orders" },
  { href: "/kitchen", label: "Kitchen", permission: "kitchen.view", group: "service", icon: "kitchen" },
  { href: "/bar", label: "Bar", permission: "bar.view", group: "service", icon: "bar" },
  { href: "/expo", label: "Expo", permission: "kitchen.view", group: "service", icon: "expo" },
  { href: "/orders/discounts", label: "Discounts", permission: "orders.discount.manage", group: "service", icon: "discounts" },
  { href: "/cash-drawers", label: "Cash drawers", permission: "drawers.view", group: "service", icon: "drawers" },
  { href: "/menu/86", label: "86 board", permission: "menu.view", group: "service", icon: "eighty-six" },

  { href: "/menu", label: "Menu", permission: "menu.view", group: "back-of-house", icon: "menu" },
  { href: "/menu/manage", label: "Manage menu", permission: "menu.edit", group: "back-of-house", icon: "menu-manage" },
  { href: "/menu/modifiers", label: "Modifiers", permission: "menu.modifiers.manage", group: "back-of-house", icon: "modifiers" },
  { href: "/menu/stations", label: "Prep stations", permission: "prep-stations.manage", group: "back-of-house", icon: "stations" },
  { href: "/recipes", label: "Recipes", permission: "recipes.view", group: "back-of-house", icon: "recipes" },
  { href: "/inventory", label: "Inventory", permission: "inventory.view", group: "back-of-house", icon: "inventory" },
  { href: "/inventory/counts", label: "Inventory counts", permission: "inventory.count", group: "back-of-house", icon: "counts" },
  { href: "/inventory/items", label: "Inventory items", permission: "inventory.configure", group: "back-of-house", icon: "items" },
  { href: "/purchasing/orders", label: "Purchase orders", permission: "purchasing.view", group: "back-of-house", icon: "purchase-orders" },
  { href: "/purchasing/suggested", label: "Suggested orders", permission: "purchasing.manage", group: "back-of-house", icon: "suggested-orders" },
  { href: "/purchasing/suppliers", label: "Suppliers", permission: "suppliers.manage", group: "back-of-house", icon: "suppliers" },

  { href: "/my-schedule", label: "My schedule", permission: "schedule.view", group: "people", icon: "my-schedule" },
  { href: "/my-time", label: "My time", permission: "timeclock.punch", group: "people", icon: "my-time" },
  { href: "/scheduling", label: "Scheduling", permission: "schedule.view", group: "people", icon: "scheduling" },
  { href: "/scheduling/timeline", label: "Timeline", permission: "schedule.view", group: "people", icon: "timeline" },
  { href: "/scheduling/time-clock", label: "Time clock", permission: "timeclock.view", group: "people", icon: "time-clock" },
  { href: "/tips", label: "Tips", permission: "tips.manage", group: "people", icon: "tips" },
  { href: "/scheduling/requests", label: "Scheduling requests", permission: "schedule.time-off.approve", group: "people", icon: "requests" },
  { href: "/scheduling/availability", label: "Availability", permission: "schedule.availability.manage", group: "people", icon: "availability" },
  { href: "/scheduling/staffing", label: "Staffing & rules", permission: "schedule.templates.manage", group: "people", icon: "staffing" },
  { href: "/employees", label: "Employees", permission: "employees.view", group: "people", icon: "employees" },
  { href: "/employees/positions", label: "Positions", permission: "employees.positions.manage", group: "people", icon: "positions" },
  { href: "/employees/certification-types", label: "Certification types", permission: "hr.certifications.manage", group: "people", icon: "certifications" },

  { href: "/admin/organization", label: "Organization", permission: "organization.view", group: "admin", icon: "organization" },
  { href: "/admin/locations", label: "Locations", permission: "locations.view", group: "admin", icon: "locations" },
  { href: "/admin/areas", label: "Areas", permission: "locations.view", group: "admin", icon: "areas" },
  { href: "/restaurant/tables", label: "Tables", permission: "restaurant.tables.manage", group: "admin", icon: "tables" },
  { href: "/restaurant/sections", label: "Sections", permission: "restaurant.sections.manage", group: "admin", icon: "sections" },
  { href: "/admin/users", label: "Users", permission: "admin.users.view", group: "admin", icon: "users" },
  { href: "/admin/roles", label: "Roles", permission: "admin.roles.view", group: "admin", icon: "roles" },
  { href: "/admin/permissions", label: "Permissions", permission: "admin.roles.view", group: "admin", icon: "permissions" },
  { href: "/admin/taxes", label: "Taxes", permission: "tax.view", group: "admin", icon: "taxes" },
  { href: "/admin/system", label: "System health", permission: "admin.system.view", group: "admin", icon: "system" },
];

/** Usability only. Every page and API enforces its own permission on the server. */
export function visibleNavigation(
  permissions: readonly PermissionCode[],
): NavigationItem[] {
  return NAVIGATION.filter(
    (item) => item.permission === null || permissions.includes(item.permission),
  );
}

/** The visible links in their groups; a group with no visible link is left out. */
export function visibleNavigationGroups(permissions: readonly PermissionCode[]): NavigationGroup[] {
  const visible = visibleNavigation(permissions);

  return GROUP_ORDER.map((id) => ({
    id,
    label: GROUP_LABELS[id],
    items: visible.filter((item) => item.group === id),
  })).filter((group) => group.items.length > 0);
}

/**
 * The link to mark as current: the longest href that is the path or a parent of it,
 * so /orders/123 marks Orders and /orders/discounts marks Discounts only.
 */
export function activeHref(pathname: string, items: readonly Pick<NavigationItem, "href">[]): string | null {
  let best: string | null = null;

  for (const { href } of items) {
    const matches = pathname === href || pathname.startsWith(`${href}/`);

    if (matches && (best === null || href.length > best.length)) {
      best = href;
    }
  }

  return best;
}
