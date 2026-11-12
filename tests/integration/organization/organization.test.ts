import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  locations,
  locationSettings,
  organizations,
  auditEvents,
  restaurantAreas,
} from "@/db/schema";
import {
  findAreaLocationId,
  getOrganization,
  listAreas,
  listLocationsWithSettings,
  updateArea,
  updateLocation,
  updateLocationSettings,
  updateOrganization,
} from "@/modules/organization/services/organization-service";
import { NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { actorAt, createOrganizationFixture, createUserFixture } from "../../fixtures/auth-fixtures";

const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

const organizationChanges = {
  name: "Renamed",
  legalName: null,
  phone: null,
  email: null,
  defaultTimezone: "America/Chicago",
  defaultCurrency: "USD",
};

const locationChanges = {
  name: "Renamed location",
  addressLine1: null,
  addressLine2: null,
  city: "Detroit",
  state: "MI",
  postalCode: null,
  country: "US",
  phone: null,
  email: null,
  timezone: "America/Detroit",
};

const settingsChanges = {
  businessDayCutoff: "03:30",
  defaultTableTurnMinutes: 75,
  defaultReservationDurationMinutes: 80,
  defaultWaitQuoteMinutes: 20,
  allowWalkIns: true,
  allowReservations: false,
  allowTakeout: true,
  inventoryEnabled: true,
  schedulingEnabled: true,
  kitchenDisplayEnabled: false,
};

describe("organization domain", () => {
  let fixture: Awaited<ReturnType<typeof createOrganizationFixture>>;

  beforeEach(async () => {
    fixture = await createOrganizationFixture(getDatabase());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("updates the organization and increments its version", async () => {
    const updated = await updateOrganization(
      getDatabase(),
      fixture.organizationId,
      { ...organizationChanges, expectedVersion: 1 },
    );

    expect(updated).toMatchObject({ name: "Renamed", version: 2 });
    expect(
      (await getOrganization(getDatabase(), fixture.organizationId)).name,
    ).toBe("Renamed");
  });

  it("rejects a stale organization version", async () => {
    await updateOrganization(getDatabase(), fixture.organizationId, {
      ...organizationChanges,
      expectedVersion: 1,
    });

    await expect(
      updateOrganization(getDatabase(), fixture.organizationId, {
        ...organizationChanges,
        name: "Stale",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    expect(
      (await getOrganization(getDatabase(), fixture.organizationId)).name,
    ).toBe("Renamed");
  });

  it("lets exactly one of two simultaneous location updates win", async () => {
    const update = (name: string) =>
      updateLocation(getDatabase(), fixture.locationA, {
        ...locationChanges,
        name,
        expectedVersion: 1,
      });

    const results = await Promise.allSettled([update("First"), update("Second")]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  const ownerAt = async (locationId: string) => {
    const owner = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.ownerRole, locationId }],
    });

    return actorAt(getDatabase(), owner.id, locationId, "locations.manage");
  };

  it("updates settings, storing the cutoff as a time, and audits only what changed", async () => {
    const actor = await ownerAt(fixture.locationA);
    const updated = await updateLocationSettings(
      getDatabase(),
      actor,
      fixture.locationA,
      { ...settingsChanges, expectedVersion: 1 },
    );

    expect(updated).toMatchObject({
      businessDayCutoff: "03:30:00",
      defaultTableTurnMinutes: 75,
      allowReservations: false,
      version: 2,
    });

    const [audit] = await getDatabase()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, fixture.locationA));

    expect(audit).toMatchObject({
      action: "organization.location-settings-changed",
      category: "ORGANIZATION",
      locationId: fixture.locationA,
    });
    expect(audit!.after).toMatchObject({ businessDayCutoff: "03:30:00", allowReservations: false });
    expect(Object.keys(audit!.after as object)).not.toContain("allowWalkIns");
  });

  it("rejects a stale settings version", async () => {
    const actor = await ownerAt(fixture.locationA);

    await expect(
      updateLocationSettings(getDatabase(), actor, fixture.locationA, {
        ...settingsChanges,
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("applies the documented settings defaults", async () => {
    const [row] = await listLocationsWithSettings(getDatabase(), [
      fixture.locationA,
    ]);

    expect(row?.settings).toMatchObject({
      businessDayCutoff: "04:00:00",
      defaultTableTurnMinutes: 90,
      defaultReservationDurationMinutes: 90,
      defaultWaitQuoteMinutes: 15,
      allowWalkIns: true,
      allowReservations: true,
      allowTakeout: true,
      inventoryEnabled: true,
      schedulingEnabled: true,
      kitchenDisplayEnabled: true,
    });
  });

  it("lists only the requested locations, and nothing for none", async () => {
    const rows = await listLocationsWithSettings(getDatabase(), [
      fixture.locationB,
    ]);

    expect(rows.map((row) => row.location.id)).toEqual([fixture.locationB]);
    expect(await listLocationsWithSettings(getDatabase(), [])).toEqual([]);
  });

  describe("restaurant areas", () => {
    async function createArea(code: string, displayOrder: number) {
      const [area] = await getDatabase()
        .insert(restaurantAreas)
        .values({
          locationId: fixture.locationA,
          code,
          name: code,
          areaType: "DINING",
          displayOrder,
        })
        .returning({ id: restaurantAreas.id });

      return area!.id;
    }

    it("lists by display order and updates one area", async () => {
      await createArea("SECOND", 2);
      const firstId = await createArea("FIRST", 1);

      expect(
        (await listAreas(getDatabase(), fixture.locationA)).map(
          (area) => area.code,
        ),
      ).toEqual(["FIRST", "SECOND"]);

      expect(
        await updateArea(getDatabase(), firstId, {
          name: "Patio",
          displayOrder: 9,
          active: false,
        }),
      ).toMatchObject({ name: "Patio", displayOrder: 9, active: false });
    });

    it("finds an area's own location for authorization", async () => {
      const id = await createArea("MAIN_ROOM", 1);

      expect(await findAreaLocationId(getDatabase(), id)).toBe(fixture.locationA);
    });

    it("reports an unknown area", async () => {
      await expect(
        findAreaLocationId(getDatabase(), ABSENT_ID),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        updateArea(getDatabase(), ABSENT_ID, {
          name: "x",
          displayOrder: 0,
          active: true,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("makes PostgreSQL enforce unique codes and valid types", async () => {
      await createArea("TAKEN", 1);

      await expect(createArea("TAKEN", 2)).rejects.toMatchObject({
        cause: { code: "23505" },
      });
      await expect(
        getDatabase().insert(restaurantAreas).values({
          locationId: fixture.locationA,
          code: "BAD_TYPE",
          name: "Bad",
          areaType: "PATIO",
        }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  describe("PostgreSQL constraints", () => {
    it("rejects a duplicate location code within an organization", async () => {
      const code = `CODE_${randomUUID()}`;
      const values = {
        organizationId: fixture.organizationId,
        name: "Location",
        locationCode: code,
        timezone: "America/Detroit",
      };

      await getDatabase().insert(locations).values(values);

      await expect(
        getDatabase().insert(locations).values(values),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    });

    it("allows the same location code in another organization", async () => {
      const other = await createOrganizationFixture(getDatabase());
      const code = `CODE_${randomUUID()}`;
      const values = { name: "Location", locationCode: code, timezone: "UTC" };

      await getDatabase()
        .insert(locations)
        .values({ ...values, organizationId: fixture.organizationId });

      await expect(
        getDatabase()
          .insert(locations)
          .values({ ...values, organizationId: other.organizationId }),
      ).resolves.toBeDefined();
    });

    it("rejects non-positive settings minutes", async () => {
      await expect(
        getDatabase()
          .update(locationSettings)
          .set({ defaultWaitQuoteMinutes: 0 })
          .where(eq(locationSettings.locationId, fixture.locationA)),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });

    it("rejects a malformed currency", async () => {
      await expect(
        getDatabase()
          .update(organizations)
          .set({ defaultCurrency: "usd" })
          .where(eq(organizations.id, fixture.organizationId)),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });

    it("refuses to delete an organization with locations, cascading nothing", async () => {
      await expect(
        getDatabase()
          .delete(organizations)
          .where(eq(organizations.id, fixture.organizationId)),
      ).rejects.toMatchObject({ cause: { code: "23503" } });

      expect(
        await listLocationsWithSettings(getDatabase(), [fixture.locationA]),
      ).toHaveLength(1);
    });
  });
});
