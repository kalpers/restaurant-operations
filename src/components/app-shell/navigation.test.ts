import { describe, expect, it } from "vitest";

import { ALL_PERMISSION_CODES } from "@/modules/auth/permission-catalog";

import { activeHref, visibleNavigation, visibleNavigationGroups } from "./navigation";

const labels = (permissions: Parameters<typeof visibleNavigation>[0]) =>
  visibleNavigation(permissions).map((item) => item.label);

const groups = (permissions: Parameters<typeof visibleNavigationGroups>[0]) =>
  visibleNavigationGroups(permissions).map((group) => [group.label, group.items.map((item) => item.label)]);

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
    expect(labels(["locations.view"])).toEqual(["Dashboard", "Locations", "Areas"]);
  });

  it("has a unique href for every item", () => {
    const hrefs = visibleNavigation(ALL_PERMISSION_CODES).map((item) => item.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs).toHaveLength(38);
  });
});

describe("visibleNavigationGroups", () => {
  it("drops groups with no visible link", () => {
    expect(groups([])).toEqual([["Insights", ["Dashboard"]]]);
    expect(groups(["orders.view", "kitchen.view"])).toEqual([
      ["Insights", ["Dashboard"]],
      ["Service", ["Orders", "Kitchen", "Expo"]],
    ]);
  });

  it("groups everything with every permission", () => {
    expect(groups(ALL_PERMISSION_CODES)).toEqual([
      ["Insights", ["Dashboard", "Reports", "Audit"]],
      ["Service", ["Floor", "Reservations", "Waitlist", "Orders", "Kitchen", "Bar", "Expo", "Discounts"]],
      [
        "Back of house",
        [
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
        ],
      ],
      [
        "People",
        [
          "My schedule",
          "Scheduling",
          "Timeline",
          "Scheduling requests",
          "Availability",
          "Staffing & rules",
          "Employees",
          "Positions",
          "Certification types",
        ],
      ],
      ["Admin", ["Organization", "Locations", "Areas", "Tables", "Sections", "Users", "Roles", "Permissions"]],
    ]);
  });
});

describe("activeHref", () => {
  const items = visibleNavigation(ALL_PERMISSION_CODES);

  it("marks the page itself", () => {
    expect(activeHref("/orders", items)).toBe("/orders");
  });

  it("marks the parent of a detail page", () => {
    expect(activeHref("/orders/7d1c2c2e", items)).toBe("/orders");
    expect(activeHref("/scheduling/1234", items)).toBe("/scheduling");
  });

  it("prefers the most specific link", () => {
    expect(activeHref("/orders/discounts", items)).toBe("/orders/discounts");
    expect(activeHref("/scheduling/timeline", items)).toBe("/scheduling/timeline");
  });

  it("doesn't match a prefix that isn't a path segment", () => {
    expect(activeHref("/menus", items)).toBeNull();
  });
});
