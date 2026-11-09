import { describe, expect, it } from "vitest";

import { ALL_PERMISSION_CODES } from "@/modules/auth/permission-catalog";

import { visibleNavigation } from "./navigation";

const labels = (permissions: Parameters<typeof visibleNavigation>[0]) =>
  visibleNavigation(permissions).map((item) => item.label);

describe("visibleNavigation", () => {
  it("shows only the dashboard with no permissions", () => {
    expect(labels([])).toEqual(["Dashboard"]);
  });

  it("shows an item for the permission that guards it", () => {
    expect(labels(["admin.users.view"])).toEqual(["Dashboard", "Users"]);
  });

  it("shows the menu to anyone who can view it, and management only with its permissions", () => {
    expect(labels(["menu.view"])).toEqual(["Dashboard", "Menu"]);
    expect(labels(["menu.view", "menu.edit", "recipes.view"])).toEqual([
      "Dashboard",
      "Menu",
      "Manage menu",
      "Recipes",
    ]);
  });

  it("shows two items that share a permission", () => {
    expect(labels(["locations.view"])).toEqual([
      "Dashboard",
      "Locations",
      "Areas",
    ]);
  });

  it("shows everything with every permission", () => {
    expect(labels(ALL_PERMISSION_CODES)).toEqual([
      "Dashboard",
      "Employees",
      "Positions",
      "Certification types",
      "My schedule",
      "Scheduling",
      "Scheduling requests",
      "Availability",
      "Staffing & rules",
      "Floor",
      "Reservations",
      "Waitlist",
      "Orders",
      "Discounts",
      "Kitchen",
      "Bar",
      "Expo",
      "Menu",
      "Manage menu",
      "Modifiers",
      "Prep stations",
      "Recipes",
      "Inventory",
      "Inventory counts",
      "Inventory items",
      "Purchase orders",
      "Suppliers",
      "Tables",
      "Sections",
      "Organization",
      "Locations",
      "Areas",
      "Users",
      "Roles",
      "Permissions",
    ]);
  });
});
