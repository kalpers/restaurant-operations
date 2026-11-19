import { describe, expect, it } from "vitest";

import { ALL_PERMISSION_CODES } from "@/modules/auth/permission-catalog";

import {
  activeHref,
  isNavGroupOpen,
  parseNavGroupsCookie,
  serializeNavGroupsCookie,
  setAllNavGroups,
  toggleNavGroup,
  visibleNavigation,
  visibleNavigationGroups,
  type NavGroupState,
} from "./navigation";

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
    expect(labels(["menu.view"])).toEqual(["Dashboard", "86 board", "Menu"]);
    expect(labels(["menu.view", "menu.edit", "recipes.view"])).toEqual([
      "Dashboard",
      "86 board",
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
    expect(hrefs).toHaveLength(52);
  });
});

describe("visibleNavigationGroups", () => {
  it("drops groups with no visible link", () => {
    expect(groups([])).toEqual([["Insights", ["Dashboard"]]]);
    expect(groups(["orders.view", "kitchen.view"])).toEqual([
      ["Insights", ["Dashboard"]],
      ["Service", ["Orders", "Kitchen", "Expo", "Prep list"]],
    ]);
  });

  it("groups everything with every permission", () => {
    expect(groups(ALL_PERMISSION_CODES)).toEqual([
      ["Insights", ["Dashboard", "Reports", "Exports", "Audit"]],
      ["Service", ["Floor", "Reservations", "Waitlist", "Guests", "Loyalty", "Orders", "Kitchen", "Bar", "Expo", "Prep list", "Discounts", "Cash drawers", "86 board"]],
      [
        "Back of house",
        [
          "Menu",
          "Manage menu",
          "Happy hour",
          "Modifiers",
          "Prep stations",
          "Recipes",
          "Allergens",
          "Inventory",
          "Inventory counts",
          "Inventory items",
          "Purchase orders",
          "Suggested orders",
          "Suppliers",
        ],
      ],
      [
        "People",
        [
          "My schedule",
          "My time",
          "Scheduling",
          "Timeline",
          "Time clock",
          "Tips",
          "Scheduling requests",
          "Availability",
          "Staffing & rules",
          "Employees",
          "Positions",
          "Certification types",
        ],
      ],
      ["Admin", ["Organization", "Locations", "Areas", "Tables", "Sections", "Users", "Roles", "Permissions", "Taxes", "System health"]],
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

describe("nav group memory (Phase 27)", () => {
  it("parses and serializes the cookie, ignoring anything unexpected", () => {
    expect(parseNavGroupsCookie("insights_1.back-of-house_0")).toEqual({ insights: true, "back-of-house": false });
    expect(serializeNavGroupsCookie({ people: false, insights: true })).toBe("insights_1.people_0");
    expect(parseNavGroupsCookie(serializeNavGroupsCookie({ admin: true, service: false }))).toEqual({
      admin: true,
      service: false,
    });

    for (const bad of [undefined, null, "", "nope", "insights_2", "unknown_1", "insights:1", "x".repeat(201)]) {
      expect(parseNavGroupsCookie(bad)).toEqual({});
    }

    expect(parseNavGroupsCookie("unknown_1.people_1")).toEqual({ people: true });
  });

  const open = (state: NavGroupState, groupId: "service" | "people", holdsCurrent: boolean, pathname: string) =>
    isNavGroupOpen({ groupId, holdsCurrent, pathname, memory: state.memory, currentChoice: state.currentChoice });

  it("opens the current page's group on arrival even if remembered closed, and follows memory elsewhere", () => {
    const state: NavGroupState = { memory: { service: false, people: true }, currentChoice: null };

    expect(open(state, "service", true, "/orders")).toBe(true);
    expect(open(state, "people", false, "/orders")).toBe(true);
    expect(open({ memory: {}, currentChoice: null }, "people", false, "/orders")).toBe(false);
  });

  it("keeps a toggle of the current group on that page only, and remembers it", () => {
    const closed = toggleNavGroup({ memory: {}, currentChoice: null }, {
      groupId: "service",
      holdsCurrent: true,
      pathname: "/orders",
      open: false,
    });

    expect(closed.memory).toEqual({ service: false });
    expect(open(closed, "service", true, "/orders")).toBe(false);
    // Arriving on another page of the same group opens it again.
    expect(open(closed, "service", true, "/kitchen")).toBe(true);
    // From a page in another group it stays closed.
    expect(open(closed, "service", false, "/employees")).toBe(false);
  });

  it("expands all, and collapses all but the current page's group", () => {
    const ids = ["insights", "service", "people"] as const;
    const expanded = setAllNavGroups(ids, { open: true, pathname: "/orders" });

    expect(expanded.memory).toEqual({ insights: true, service: true, people: true });
    expect(open(expanded, "people", false, "/orders")).toBe(true);

    const collapsed = setAllNavGroups(ids, { open: false, pathname: "/orders" });

    expect(collapsed.memory).toEqual({ insights: false, service: false, people: false });
    expect(open(collapsed, "service", true, "/orders")).toBe(true);
    expect(open(collapsed, "people", false, "/orders")).toBe(false);
  });
});
