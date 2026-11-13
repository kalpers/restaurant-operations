import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireTestDatabaseUrl } from "@/config/tooling-env";
import type { Database } from "@/db";
import { VALIDATION_LABOR_SEED_KEY, VALIDATION_SEED_KEY } from "@/db/demo/validation-fixture";
import { applyMigrations } from "@/db/maintenance/apply-migrations";
import * as schema from "@/db/schema";
import { seeds } from "@/db/seeds/registry";
import { runSeeds } from "@/db/seeds/run-seeds";
import { bootstrapOwner } from "@/modules/auth/services/owner-bootstrap";
import { getUserAuthContext, requirePermission } from "@/modules/auth/services/permission-service";
import { normalizeEmail } from "@/modules/auth/email";

import { assertLocalDevelopment } from "../../../scripts/local-seed-guard";
import { seedValidationFixture } from "../../../scripts/validation-fixture";
import { seedValidationLaborTips } from "../../../scripts/validation-labor";
import { seedValidationMenuStock } from "../../../scripts/validation-menu-stock";
import { seedValidationGuestsAllergens } from "../../../scripts/validation-guests-allergens";
import { seedValidationLots } from "../../../scripts/validation-lots";
import { seedValidationServicePolish } from "../../../scripts/validation-service-polish";
import { dropDatabase, recreateEmptyDatabase } from "../../helpers/prepare-test-database";

const VALIDATION_DATABASE = "restaurant_ops_test_validation_seed";

/** Rows per table that the fixture touches, to prove a second run adds none. */
const COUNTED = [
  "employees",
  "employee_position_compensation",
  "schedule_periods",
  "shifts",
  "shift_assignments",
  "server_section_assignments",
  "reservations",
  "guest_parties",
  "table_sessions",
  "orders",
  "order_items",
  "order_item_modifiers",
  "order_item_inventory_consumption",
  "inventory_transactions",
  "kitchen_tickets",
  "order_settlements",
  "settlement_tenders",
  "audit_events",
  "seed_runs",
  "time_entries",
  "time_entry_adjustments",
  "tip_pool_rules",
  "tip_distributions",
  "tip_distribution_lines",
  "menu_item_outages",
  "inventory_stock_alerts",
  "notifications",
  "purchase_orders",
  "purchase_order_lines",
  // Phase 21 additions (Phase 22 policy 24).
  "guest_profiles",
  "guest_profile_allergies",
  "guest_profile_merges",
  "inventory_item_allergens",
  "ingredient_allergen_reviews",
  "menu_item_allergens",
  "menu_item_allergen_reviews",
] as const;

/**
 * The opt-in validation fixture (docs/Phase-13-Validation-Seed-Data.md), on a database of
 * its own built exactly as a developer would: migrate, seed, bootstrap the Owner, then
 * `db:seed:validation` twice.
 */
describe("Phase 13: opt-in validation seed", () => {
  let client: postgres.Sql;
  let database: Database;

  const counts = async () => {
    const result: Record<string, number> = {};

    for (const table of COUNTED) {
      const [row] = await client.unsafe<{ total: number }[]>(`SELECT count(*)::int AS total FROM ${table}`);

      result[table] = row!.total;
    }

    return result;
  };

  const owner = async () => {
    const [user] = await database
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.normalizedEmail, normalizeEmail("validation-owner@example.test")));
    const [main] = await database.select().from(schema.locations).where(eq(schema.locations.locationCode, "MAIN"));

    return requirePermission((await getUserAuthContext(database, user!.id))!, {
      permission: "employees.create",
      locationId: main!.id,
    });
  };

  let first: Awaited<ReturnType<typeof seedValidationFixture>>;
  let afterFirst: Record<string, number>;
  let second: Awaited<ReturnType<typeof seedValidationFixture>>;
  let afterSecond: Record<string, number>;
  let laborFirst: Awaited<ReturnType<typeof seedValidationLaborTips>>;
  let laborSecond: Awaited<ReturnType<typeof seedValidationLaborTips>>;
  let signalsFirst: Awaited<ReturnType<typeof seedValidationMenuStock>>;
  let signalsSecond: Awaited<ReturnType<typeof seedValidationMenuStock>>;
  let polishFirst: Awaited<ReturnType<typeof seedValidationServicePolish>>;
  let polishSecond: Awaited<ReturnType<typeof seedValidationServicePolish>>;
  let guestsFirst: Awaited<ReturnType<typeof seedValidationGuestsAllergens>>;
  let guestsSecond: Awaited<ReturnType<typeof seedValidationGuestsAllergens>>;
  let lotsFirst: Awaited<ReturnType<typeof seedValidationLots>>;
  let lotsSecond: Awaited<ReturnType<typeof seedValidationLots>>;

  beforeAll(async () => {
    const url = await recreateEmptyDatabase(requireTestDatabaseUrl(), VALIDATION_DATABASE);

    await applyMigrations(url);
    client = postgres(url, { max: 4, onnotice: () => {} });
    database = drizzle(client, { schema });
    await runSeeds(database, seeds);
    await bootstrapOwner(database, { email: "validation-owner@example.test", password: "correct horse battery staple" });

    first = await seedValidationFixture(database, await owner());
    laborFirst = await seedValidationLaborTips(database, await owner());
    signalsFirst = await seedValidationMenuStock(database, await owner());
    polishFirst = await seedValidationServicePolish(database, await owner());
    guestsFirst = await seedValidationGuestsAllergens(database, await owner());
    lotsFirst = await seedValidationLots(database, await owner());
    afterFirst = await counts();
    second = await seedValidationFixture(database, await owner());
    laborSecond = await seedValidationLaborTips(database, await owner());
    signalsSecond = await seedValidationMenuStock(database, await owner());
    polishSecond = await seedValidationServicePolish(database, await owner());
    guestsSecond = await seedValidationGuestsAllergens(database, await owner());
    lotsSecond = await seedValidationLots(database, await owner());
    afterSecond = await counts();
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await dropDatabase(requireTestDatabaseUrl(), VALIDATION_DATABASE);
  });

  it("builds the fixture once and skips it on the second run", () => {
    expect(first).toEqual({ skipped: false, employees: 4, schedule: true, dineIn: true, takeout: true, upcoming: true });
    expect(second).toEqual({ skipped: true });
    expect(afterSecond).toEqual(afterFirst);
  });

  it("adds the Phase 21 allergen tags, declared allergen and guest profiles once", async () => {
    expect(guestsFirst).toEqual({ skipped: false, ingredientsTagged: 13, declared: 1, profiles: 3 });
    expect(guestsSecond).toEqual({ skipped: true });

    const profiles = await client<{ display_name: string; status: string; vip: boolean }[]>`
      SELECT display_name, status, vip FROM guest_profiles WHERE display_name LIKE 'Phase 21 Validation%' ORDER BY display_name`;

    expect(profiles).toEqual([
      { display_name: "Phase 21 Validation Milk", status: "ACTIVE", vip: false },
      { display_name: "Phase 21 Validation Milk (duplicate)", status: "MERGED", vip: false },
      { display_name: "Phase 21 Validation Peanut", status: "ACTIVE", vip: true },
    ]);

    // The merge kept the more severe milk allergy on the kept profile.
    const [milk] = await client<{ severity: string }[]>`
      SELECT a.severity FROM guest_profile_allergies a
      JOIN guest_profiles p ON p.id = a.guest_profile_id
      WHERE p.display_name = 'Phase 21 Validation Milk'`;

    expect(milk).toEqual({ severity: "SEVERE" });

    const tags = await client<{ code: string; allergen: string }[]>`
      SELECT i.code, al.code AS allergen FROM inventory_item_allergens t
      JOIN inventory_items i ON i.id = t.inventory_item_id
      JOIN allergens al ON al.id = t.allergen_id
      WHERE i.code IN ('BRIOCHE_BUN', 'AMERICAN_CHEESE', 'SWISS_CHEESE') ORDER BY i.code, al.code`;

    expect(tags.map((row) => `${row.code}:${row.allergen}`)).toEqual([
      "AMERICAN_CHEESE:MILK",
      "BRIOCHE_BUN:EGGS",
      "BRIOCHE_BUN:SESAME",
      "BRIOCHE_BUN:WHEAT",
      "SWISS_CHEESE:MILK",
    ]);
  });

  it("adds the Phase 23 lot-tracked bacon and its dated lot once", async () => {
    expect(lotsFirst).toEqual({ skipped: false, tracked: true });
    expect(lotsSecond).toEqual({ skipped: true });

    const lots = await client<{ origin: string; dated: boolean }[]>`
      SELECT l.origin, l.expires_on IS NOT NULL AS dated FROM inventory_lots l
      JOIN inventory_items i ON i.id = l.inventory_item_id WHERE i.code = 'BACON' ORDER BY l.sequence_number`;

    expect(lots.some((lot) => lot.origin === "FOUND" && lot.dated)).toBe(true);
  });

  it("adds the Phase 20 modifier 86 once", async () => {
    expect(polishFirst).toEqual({ skipped: false, modifierOut: true });
    expect(polishSecond).toEqual({ skipped: true });

    const rows = await client<{ code: string; status: string }[]>`
      SELECT m.code, o.status FROM modifier_outages o JOIN modifiers m ON m.id = o.modifier_id`;

    expect(rows).toEqual([{ code: "EXTRA_BACON", status: "ACTIVE" }]);
  });

  it("adds the Phase 19 86, low-stock alert and suggested draft once", async () => {
    expect(signalsFirst).toMatchObject({ skipped: false, outage: true, alert: true });
    expect(signalsFirst.skipped === false && signalsFirst.drafts).toBeGreaterThanOrEqual(1);
    expect(signalsSecond).toEqual({ skipped: true });

    const outages = await client<{ code: string; status: string }[]>`
      SELECT m.code, o.status FROM menu_item_outages o JOIN menu_items m ON m.id = o.menu_item_id`;

    expect(outages).toEqual([{ code: "BUFFALO_WINGS", status: "ACTIVE" }]);

    const alerts = await client<{ code: string; status: string }[]>`
      SELECT i.code, a.status FROM inventory_stock_alerts a JOIN inventory_items i ON i.id = a.inventory_item_id`;

    expect(alerts).toEqual([{ code: "PICKLE_CHIPS", status: "OPEN" }]);

    const drafts = await client<{ status: string }[]>`
      SELECT po.status FROM purchase_orders po WHERE po.notes = 'Suggested from low stock.'`;

    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(drafts.every((row) => row.status === "DRAFT")).toBe(true);
  });

  it("adds the Phase 18 time entry, tip pool and distribution once", async () => {
    expect(laborFirst).toEqual({ skipped: false, entry: true, pool: true, distribution: "finalized" });
    expect(laborSecond).toEqual({ skipped: true });

    const lines = await client<{ position: string; hours: string; status: string }[]>`
      SELECT l.position_code_snapshot AS position, l.worked_hours::text AS hours, d.status
      FROM tip_distribution_lines l JOIN tip_distributions d ON d.id = l.distribution_id`;

    // Corrected to four hours ago until a minute ago: 3 h 59 min.
    expect(lines).toEqual([{ position: "SERVER", hours: "3.9833", status: "FINALIZED" }]);
    expect(
      await database.select().from(schema.seedRuns).where(eq(schema.seedRuns.seedKey, VALIDATION_LABOR_SEED_KEY)),
    ).toHaveLength(1);
  });

  it("records the fixture's seed key", async () => {
    const rows = await database.select().from(schema.seedRuns).where(eq(schema.seedRuns.seedKey, VALIDATION_SEED_KEY));

    expect(rows).toHaveLength(1);
  });

  it("publishes the 2030 validation week with four filled shifts", async () => {
    const [period] = await database
      .select()
      .from(schema.schedulePeriods)
      .where(eq(schema.schedulePeriods.name, "Phase 13 Validation Week 2030"));
    const assigned = await client<{ total: number }[]>`
      SELECT count(*)::int AS total FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
      WHERE s.schedule_period_id = ${period!.id} AND a.status = 'ACTIVE'`;

    expect(period).toMatchObject({ status: "PUBLISHED", startDate: "2030-10-05", endDate: "2030-10-11" });
    expect(assigned[0]!.total).toBe(4);
  });

  it("closes both canonical-burger checks, each settled for exactly the order amount", async () => {
    const rows = await client<{ customer: string | null; status: string; subtotal: string; total_due: string; snapshot: string; tendered: string; settlement: string }[]>`
      SELECT o.customer_name AS customer, o.status, o.subtotal::text, o.total_due::text, s.order_amount_snapshot::text AS snapshot,
             s.tendered_amount::text AS tendered, s.status AS settlement
      FROM orders o JOIN order_settlements s ON s.order_id = o.id
      ORDER BY o.order_type`;
    const instructions = await client<{ text: string }[]>`SELECT kitchen_instructions_snapshot AS text FROM order_items`;

    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row).toMatchObject({ status: "CLOSED", settlement: "COMPLETED" });
      // Phase 17: settlement reconciles to the total due (subtotal plus tax).
      expect(row.snapshot).toBe(row.total_due);
      expect(row.tendered).toBe(row.total_due);
    }

    expect(instructions.map((row) => row.text)).toEqual([
      expect.stringMatching(/Cook medium/),
      expect.stringMatching(/Cook medium/),
    ]);
  });

  it("keeps every inventory balance equal to the ledger, the burgers included", async () => {
    const mismatched = await client`
      SELECT b.inventory_item_id
      FROM inventory_balances b
      LEFT JOIN LATERAL (
        SELECT t.quantity_after FROM inventory_transactions t
        WHERE t.inventory_item_id = b.inventory_item_id AND t.location_id = b.location_id
        ORDER BY t.sequence DESC LIMIT 1
      ) last ON true
      WHERE last.quantity_after IS DISTINCT FROM b.quantity_on_hand`;
    const consumed = await client<{ total: number }[]>`
      SELECT count(*)::int AS total FROM inventory_transactions WHERE transaction_type = 'CONSUME'`;

    expect(mismatched).toEqual([]);
    expect(consumed[0]!.total).toBeGreaterThan(0);
  });

  it("leaves the upcoming party CONFIRMED and planned on T02, with no session", async () => {
    const [row] = await client<{ status: string; tables: string[]; sessions: number }[]>`
      SELECT r.status,
             array(SELECT t.table_number FROM reservation_table_assignments a
                   JOIN restaurant_tables t ON t.id = a.restaurant_table_id
                   WHERE a.reservation_id = r.id) AS tables,
             (SELECT count(*)::int FROM table_sessions s WHERE s.guest_party_id = r.guest_party_id) AS sessions
      FROM reservations r JOIN guest_parties p ON p.id = r.guest_party_id
      WHERE p.guest_name = 'Phase 13 Validation Party'`;

    expect(row).toEqual({ status: "CONFIRMED", tables: ["T02"], sessions: 0 });
  });

  it("left every table it used clean and every session completed", async () => {
    const open = await database
      .select()
      .from(schema.tableSessions)
      .where(sql`${schema.tableSessions.status} <> 'COMPLETED'`);
    const dirty = await database
      .select()
      .from(schema.restaurantTables)
      .where(eq(schema.restaurantTables.condition, "DIRTY"));

    expect(open).toEqual([]);
    expect(dirty).toEqual([]);
  });

  it("refuses to run against a database that isn't on this machine", () => {
    const original = process.env.DATABASE_URL;

    try {
      process.env.DATABASE_URL = "postgresql://user:pass@db.example.com:5432/restaurant_ops";
      expect(() => assertLocalDevelopment("Validation data")).toThrow(/local development database only/);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });
});
