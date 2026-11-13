import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { CURRENT_LOCATION_COOKIE } from "@/modules/auth/guards";
import { ConflictError } from "@/shared/errors/app-error";
import { LOCATION_HEADER } from "@/shared/http/location-header";

import { createOrganizationFixture, createUserFixture } from "../../fixtures/auth-fixtures";

// Phase 23 (policy 4): the request says which location its page shows. The tests stand in
// for the request's session, cookie and headers.
const request = vi.hoisted(() => ({
  userId: null as string | null,
  cookie: undefined as string | undefined,
  header: null as string | null,
}));

vi.mock("@/modules/auth/session", () => ({
  getSessionIdentity: async () => (request.userId ? { userId: request.userId } : null),
  getSessionUserId: async () => request.userId,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === CURRENT_LOCATION_COOKIE && request.cookie ? { value: request.cookie } : undefined,
  }),
  headers: async () => new Headers(request.header ? { [LOCATION_HEADER]: request.header } : {}),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const { requireApiActor, requireApiPermission } = await import("@/modules/auth/guards");

describe("location header", () => {
  let fixture: Awaited<ReturnType<typeof createOrganizationFixture>>;
  let both: string;
  let onlyA: string;

  beforeAll(async () => {
    fixture = await createOrganizationFixture(getDatabase());
    both = (
      await createUserFixture(getDatabase(), {
        assignments: [
          { roleId: fixture.ownerRole, locationId: fixture.locationA },
          { roleId: fixture.ownerRole, locationId: fixture.locationB },
        ],
      })
    ).id;
    onlyA = (
      await createUserFixture(getDatabase(), {
        assignments: [{ roleId: fixture.ownerRole, locationId: fixture.locationA }],
      })
    ).id;
  });

  beforeEach(() => {
    request.userId = both;
    request.cookie = fixture.locationB;
    request.header = null;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("acts at the cookie's location when the page shows the same one", async () => {
    request.header = fixture.locationB;

    expect((await requireApiActor()).locationId).toBe(fixture.locationB);
    expect((await requireApiPermission("orders.create")).locationId).toBe(fixture.locationB);
  });

  it("refuses a request from a page left at another location", async () => {
    request.header = fixture.locationA;

    await expect(requireApiActor()).rejects.toMatchObject({ code: "LOCATION_CHANGED", httpStatus: 409 });
    await expect(requireApiPermission("orders.create")).rejects.toBeInstanceOf(ConflictError);
  });

  it("uses the cookie as before when no page location is sent", async () => {
    expect((await requireApiActor()).locationId).toBe(fixture.locationB);
  });

  it("never reaches a location through the header", async () => {
    request.userId = onlyA;
    request.cookie = undefined;
    request.header = fixture.locationB;

    await expect(requireApiActor()).rejects.toMatchObject({ code: "LOCATION_CHANGED" });

    request.header = fixture.locationA;
    expect((await requireApiActor()).locationId).toBe(fixture.locationA);
  });
});
