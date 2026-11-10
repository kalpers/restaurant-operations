import { describe, expect, it } from "vitest";

import { AuthorizationError } from "@/shared/errors/app-error";

import type { AuthContext } from "../types";
import {
  getPermissionsAt,
  hasPermission,
  requirePermission,
} from "./permission-service";
import { assertActorHolds } from "./security-rules";

const context: AuthContext = {
  userId: "user-1",
  email: "person@example.com",
  active: true,
  mustChangePassword: false,
  locations: [
    {
      locationId: "location-a",
      locationCode: "A",
      locationName: "A",
      organizationId: "organization-1",
      roles: [{ id: "role-1", code: "SERVER", name: "Server" }],
      permissions: ["orders.create"],
    },
    {
      locationId: "location-b",
      locationCode: "B",
      locationName: "B",
      organizationId: "organization-1",
      roles: [{ id: "role-2", code: "HOST", name: "Host" }],
      permissions: ["reservations.view"],
    },
  ],
};

describe("hasPermission", () => {
  it("allows a permission held at that location", () => {
    expect(hasPermission(context, "orders.create", "location-a")).toBe(true);
  });

  it("doesn't carry a permission to another location", () => {
    expect(hasPermission(context, "orders.create", "location-b")).toBe(false);
  });

  it("denies at a location with no assignment", () => {
    expect(hasPermission(context, "orders.create", "location-c")).toBe(false);
    expect(getPermissionsAt(context, "location-c")).toEqual([]);
  });
});

describe("requirePermission", () => {
  it("returns the actor scoped to the location", () => {
    const actor = requirePermission(context, {
      permission: "orders.create",
      locationId: "location-a",
    });

    expect(actor.userId).toBe("user-1");
    expect(actor.locationId).toBe("location-a");
    expect(actor.organizationId).toBe("organization-1");
    expect([...actor.permissions]).toEqual(["orders.create"]);
  });

  it("throws when the permission is held only elsewhere", () => {
    expect(() =>
      requirePermission(context, {
        permission: "orders.create",
        locationId: "location-b",
      }),
    ).toThrow(AuthorizationError);
  });

  it("throws when no location could be resolved", () => {
    expect(() =>
      requirePermission(context, { permission: "orders.create", locationId: "" }),
    ).toThrow(AuthorizationError);
  });
});

describe("assertActorHolds", () => {
  const actor = {
    userId: "user-1",
    organizationId: "organization-1",
    locationId: "location-a",
    permissions: new Set(["orders.create", "orders.submit"]),
  };

  it("allows a subset of what the actor holds", () => {
    expect(() => assertActorHolds(actor, ["orders.create"])).not.toThrow();
    expect(() => assertActorHolds(actor, [])).not.toThrow();
  });

  it("rejects anything the actor doesn't hold", () => {
    expect(() =>
      assertActorHolds(actor, ["orders.create", "admin.roles.manage"]),
    ).toThrow(AuthorizationError);
  });
});
