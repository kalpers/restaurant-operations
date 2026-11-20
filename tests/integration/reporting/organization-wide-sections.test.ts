import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import { runCrossLocationReport } from "@/modules/reporting/services/cross-location-service";
import { runReport } from "@/modules/reporting/services/report-service";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { getGiftCardProgram, sellGiftCard, updateGiftCardProgram } from "@/modules/settlements/services/gift-card-service";

import { createHrScenario } from "../../fixtures/employee-fixtures";

// Phase 33 policy 16: organization-wide balances are titled "(all locations)" in each location's
// report and shown once, apart from the table and its total, in "All my locations".

const database = () => getDatabase();

describe("organization-wide report sections (Phase 33)", () => {
  let scenario: Awaited<ReturnType<typeof createHrScenario>>;
  let ownerAuth: NonNullable<Awaited<ReturnType<typeof getUserAuthContext>>>;
  let today: string;

  beforeAll(async () => {
    scenario = await createHrScenario(database());

    const program = await getGiftCardProgram(database(), scenario.owner);

    await updateGiftCardProgram(database(), scenario.owner, { enabled: true, maxBalance: "500.00", expectedVersion: program.version });
    await sellGiftCard(database(), scenario.owner, { idempotencyKey: randomUUID(), amount: "20.00", tenderType: "EXTERNAL_CARD" });
    await sellGiftCard(database(), scenario.ownerAtB, { idempotencyKey: randomUUID(), amount: "30.00", tenderType: "EXTERNAL_CARD" });
    ownerAuth = (await getUserAuthContext(database(), scenario.ownerUser.id))!;
    today = (await readLocationClock(database(), scenario.locationA, new Date())).businessDate;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("titles the organization's figures in each location's report and shows the same one at both", async () => {
    const filters = (locationId: string) => ({ locationId, from: today, to: today });
    const atA = await runReport(database(), scenario.owner, "settlements", filters(scenario.locationA));
    const atB = await runReport(database(), scenario.ownerAtB, "settlements", filters(scenario.locationB));
    const outstanding = (report: typeof atA) => report.sections.find((section) => section.key === "giftCardOutstanding")!;

    expect(outstanding(atA).title).toBe("Outstanding gift card balances (all locations)");
    expect(outstanding(atA).rows).toEqual([{ cards: 2, balance: "50.00" }]);
    expect(outstanding(atB).rows).toEqual(outstanding(atA).rows);

    const sales = await runReport(database(), scenario.owner, "sales", filters(scenario.locationA));

    expect(sales.sections.find((section) => section.key === "loyaltyOutstanding")!.title).toBe("Outstanding loyalty points (all locations)");
  });

  it("shows organization-wide balances once in a comparison, out of the table's total", async () => {
    const report = await runCrossLocationReport(database(), ownerAuth, "settlements", { from: today, to: today });
    const organization = report.sections.filter((section) => section.key.startsWith("organization-"));

    expect(report.sections[0]!.key).toBe("by-location");
    expect(organization).toHaveLength(1);
    expect(organization[0]).toMatchObject({ key: "organization-giftCardOutstanding", rows: [{ cards: 2, balance: "50.00" }] });
    expect(Object.keys(report.sections[0]!.rows.at(-1)!)).not.toContain("balance");

    const sales = await runCrossLocationReport(database(), ownerAuth, "sales", { from: today, to: today });

    expect(sales.sections.map((section) => section.key)).toEqual(["by-location", "organization-loyaltyOutstanding"]);

    const labor = await runCrossLocationReport(database(), ownerAuth, "labor", { from: today, to: today });

    expect(labor.sections.map((section) => section.key)).toEqual(["by-location"]);
  });
});
