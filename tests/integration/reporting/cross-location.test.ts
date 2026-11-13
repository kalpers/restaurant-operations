import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { locations, locationSettings, userRoles } from "@/db/schema";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import { recordWaste } from "@/modules/inventory/services/stock-operations";
import { createTransfer, sendTransfer } from "@/modules/inventory/services/transfer-service";
import { runCrossLocationReport } from "@/modules/reporting/services/cross-location-service";
import { runReport } from "@/modules/reporting/services/report-service";

import { actorAt, createRoleFixture, createUserFixture } from "../../fixtures/auth-fixtures";
import { createHrScenario } from "../../fixtures/employee-fixtures";
import { post, stockedItem, unitId } from "../../fixtures/inventory-fixtures";
import { newKey } from "../../fixtures/order-fixtures";

const database = () => getDatabase();
const DAY = "2026-11-10";

describe("reports across locations (Phase 23)", () => {
  let scenario: Awaited<ReturnType<typeof createHrScenario>>;
  let ownerAuth: NonNullable<Awaited<ReturnType<typeof getUserAuthContext>>>;

  beforeAll(async () => {
    scenario = await createHrScenario(database());
    // B keeps a different clock: another time zone and a later cutoff.
    await database().update(locations).set({ timezone: "America/Los_Angeles" }).where(eq(locations.id, scenario.locationB));
    await database().update(locationSettings).set({ businessDayCutoff: "05:00:00" }).where(eq(locationSettings.locationId, scenario.locationB));

    const each = await unitId(database(), "EACH");
    const item = await stockedItem(database(), scenario.owner, { baseUnitId: each, alsoAt: [scenario.ownerAtB] });

    for (const actor of [scenario.owner, scenario.ownerAtB]) {
      await post(database(), actor, { inventoryItemId: item.id, type: "RECEIVE", quantity: "20", unitOfMeasureId: each, incomingTotalCost: "40" });
    }

    // 22:00 Detroit on the 10th; 21:00 Los Angeles on the 10th (both the 10th's business date).
    await recordWaste(database(), scenario.owner, {
      inventoryItemId: item.id, quantity: "2", unitOfMeasureId: each, reasonCode: "SPOILAGE", notes: null, occurredAt: new Date("2026-11-11T03:00:00Z"),
    });
    await recordWaste(database(), scenario.ownerAtB, {
      inventoryItemId: item.id, quantity: "3", unitOfMeasureId: each, reasonCode: "SPOILAGE", notes: null, occurredAt: new Date("2026-11-11T05:00:00Z"),
    });

    // Sent from A on the 10th and still in transit.
    const draft = await createTransfer(database(), scenario.owner, {
      toLocationId: scenario.locationB,
      notes: null,
      lines: [{ inventoryItemId: item.id, quantity: "5", unitOfMeasureId: each }],
    });
    await sendTransfer(database(), scenario.owner, draft.id, { expectedVersion: draft.version, idempotencyKey: newKey() }, new Date("2026-11-10T18:00:00Z"));

    ownerAuth = (await getUserAuthContext(database(), scenario.ownerUser.id))!;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("totals equal the per-location reports, each on its own business dates", async () => {
    const report = await runCrossLocationReport(database(), ownerAuth, "inventory", { from: DAY, to: DAY });
    const [section] = report.sections;
    const codeOf = async (locationId: string) =>
      (await database().select({ code: locations.locationCode }).from(locations).where(eq(locations.id, locationId)))[0]!.code;
    const codeA = await codeOf(scenario.locationA);
    const codeB = await codeOf(scenario.locationB);
    const rowA = section!.rows.find((row) => row.locationCode === codeA);
    const rowB = section!.rows.find((row) => row.locationCode === codeB);
    const total = section!.rows.at(-1);

    const single = async (actor: typeof scenario.owner) =>
      runReport(database(), actor, "inventory", { locationId: actor.locationId, from: DAY, to: DAY });
    const atA = await single(scenario.owner);
    const atB = await single(scenario.ownerAtB);

    expect(rowA).toMatchObject({ wasteEntries: atA.sections.find((entry) => entry.key === "waste")!.rows.length, wasteCost: "4.0000", inTransit: "10.0000" });
    expect(rowB).toMatchObject({ wasteEntries: atB.sections.find((entry) => entry.key === "waste")!.rows.length, wasteCost: "6.0000", inTransit: "0.0000" });
    expect(total).toMatchObject({ location: "All locations", wasteEntries: 2, wasteCost: "10.0000", inTransit: "10.0000" });

    // The in-transit section is in the single-location report too.
    expect(atA.sections.find((entry) => entry.key === "in-transit")!.rows).toEqual([
      expect.objectContaining({ lines: 1, value: "10.0000" }),
    ]);
  });

  it("works out an average check from the summed figures and leaves average minutes out of the total", async () => {
    const report = await runCrossLocationReport(database(), ownerAuth, "sales", { from: DAY, to: DAY });
    const total = report.sections[0]!.rows.at(-1)!;

    expect(total).toMatchObject({ netSales: "0.00", closedOrders: 0, averageCheck: null });
    const seating = await runCrossLocationReport(database(), ownerAuth, "seating", { from: DAY, to: DAY });
    expect(seating.sections[0]!.rows.at(-1)!.averageDuration).toBeNull();
  });

  it("leaves out locations without the permission, refuses one location, and hides costs not visible everywhere", async () => {
    const reportsOnly = await createRoleFixture(database(), scenario.organizationId, ["reports.view", "reports.inventory"]);
    const withCost = await createRoleFixture(database(), scenario.organizationId, ["reports.view", "reports.inventory", "inventory.cost.view"]);
    const user = await createUserFixture(database(), {
      assignments: [
        { roleId: withCost, locationId: scenario.locationA },
        { roleId: reportsOnly, locationId: scenario.locationB },
      ],
    });
    const auth = (await getUserAuthContext(database(), user.id))!;
    const report = await runCrossLocationReport(database(), auth, "inventory", { from: DAY, to: DAY });

    expect(report.sections[0]!.columns.map((column) => column.key)).not.toContain("wasteCost");
    expect(report.notes.join(" ")).toContain("hidden");

    const one = await createUserFixture(database(), { assignments: [{ roleId: withCost, locationId: scenario.locationA }] });
    await expect(
      runCrossLocationReport(database(), (await getUserAuthContext(database(), one.id))!, "inventory", { from: DAY, to: DAY }),
    ).rejects.toMatchObject({ code: "NOT_ENOUGH_LOCATIONS" });
  });

  it("keeps a closed location in the comparison for someone who could see it", async () => {
    const closing = await createHrScenario(database());
    const auth = async () => (await getUserAuthContext(database(), closing.ownerUser.id))!;

    expect((await runCrossLocationReport(database(), await auth(), "tips", { from: DAY, to: DAY })).sections[0]!.rows).toHaveLength(3);

    await database().update(locations).set({ active: false }).where(eq(locations.id, closing.locationB));
    const rows = (await runCrossLocationReport(database(), await auth(), "tips", { from: DAY, to: DAY })).sections[0]!.rows;
    expect(rows).toHaveLength(3);
    expect(String(rows.at(-2)!.location)).toContain("(closed)");

    // Removing the assignment there removes it from the comparison too.
    await database().update(userRoles).set({ active: false }).where(eq(userRoles.locationId, closing.locationB));
    await expect(runCrossLocationReport(database(), await auth(), "tips", { from: DAY, to: DAY })).rejects.toMatchObject({
      code: "NOT_ENOUGH_LOCATIONS",
    });
    expect(await actorAt(database(), closing.ownerUser.id, closing.locationA)).toBeTruthy();
  });
});
