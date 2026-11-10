import { describe, expect, it } from "vitest";

import { actionLabel, diffAuditFields, displayValue, entityHref, entityLabel, shortId } from "./audit-format";

describe("diffAuditFields", () => {
  it("marks changed fields and keeps unchanged ones", () => {
    expect(diffAuditFields({ status: "OPEN", version: 1 }, { status: "COMPLETED", version: 1 })).toEqual([
      { field: "status", before: "OPEN", after: "COMPLETED", changed: true },
      { field: "version", before: "1", after: "1", changed: false },
    ]);
  });

  it("shows fields added or removed between the two sides", () => {
    expect(diffAuditFields({ a: "x" }, { b: "y" })).toEqual([
      { field: "a", before: "x", after: null, changed: true },
      { field: "b", before: null, after: "y", changed: true },
    ]);
  });

  it("lists a create (no before) without marking anything as changed", () => {
    expect(diffAuditFields(null, { roleCode: "SERVER" })).toEqual([
      { field: "roleCode", before: null, after: "SERVER", changed: false },
    ]);
  });

  it("lists a delete (no after)", () => {
    expect(diffAuditFields({ status: "ACTIVE" }, null)).toEqual([
      { field: "status", before: "ACTIVE", after: null, changed: false },
    ]);
  });

  it("wraps a payload that isn't an object", () => {
    expect(diffAuditFields("x", "y")).toEqual([{ field: "value", before: "x", after: "y", changed: true }]);
  });

  it("returns nothing for two empty sides", () => {
    expect(diffAuditFields(null, null)).toEqual([]);
  });
});

describe("displayValue", () => {
  it("formats recorded values for reading", () => {
    expect(displayValue(true)).toBe("Yes");
    expect(displayValue(false)).toBe("No");
    expect(displayValue(null)).toBe("—");
    expect(displayValue(["a", "b"])).toBe("a, b");
    expect(displayValue([])).toBe("None");
    expect(displayValue("12.50")).toBe("12.50");
    expect(displayValue({ x: 1 })).toBe('{"x":1}');
  });
});

describe("labels", () => {
  it("turns action codes into readable labels", () => {
    expect(actionLabel("settlements.completed")).toBe("Settlements · Completed");
    expect(actionLabel("auth.sign-in-failed")).toBe("Auth · Sign in failed");
    expect(actionLabel("admin.role-permissions-replaced")).toBe("Admin · Role permissions replaced");
  });

  it("names entity types", () => {
    expect(entityLabel("inventory_count")).toBe("Inventory count");
  });

  it("links an entity only when it has a page", () => {
    expect(entityHref("order", "abc")).toBe("/orders/abc");
    expect(entityHref("settlement", "abc")).toBeNull();
    expect(entityHref("order", null)).toBeNull();
  });

  it("shortens an ID for display", () => {
    expect(shortId("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe("0f8fad5b");
  });
});
