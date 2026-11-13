import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { requireTestDatabaseUrl } from "@/config/tooling-env";
import {
  applyMigrations,
  MIGRATIONS_FOLDER,
  rebuildFromMigrations,
} from "@/db/maintenance/apply-migrations";

import {
  dropDatabase,
  recreateEmptyDatabase,
} from "../../helpers/prepare-test-database";

const RECONSTRUCTION_DATABASE = "restaurant_ops_test_reconstruction";

const EXPECTED_TABLES = [
  "drizzle.__drizzle_migrations",
  "public.allergens",
  "public.audit_events",
  "public.cash_drawer_movements",
  "public.cash_drawer_sessions",
  "public.cash_drawers",
  "public.certification_types",
  "public.discount_definitions",
  "public.employee_addresses",
  "public.employee_availability",
  "public.employee_availability_exceptions",
  "public.employee_certifications",
  "public.employee_disciplinary_actions",
  "public.employee_documents",
  "public.employee_emergency_contacts",
  "public.employee_locations",
  "public.employee_notes",
  "public.employee_performance_reviews",
  "public.employee_position_compensation",
  "public.employee_positions",
  "public.employee_scheduling_preferences",
  "public.employee_status_history",
  "public.employees",
  "public.guest_messages",
  "public.guest_parties",
  "public.guest_party_allergies",
  "public.guest_party_message_consents",
  "public.guest_profile_allergies",
  "public.guest_profile_merges",
  "public.guest_profile_number_counters",
  "public.guest_profiles",
  "public.idempotency_records",
  "public.ingredient_allergen_reviews",
  "public.inventory_balances",
  "public.inventory_count_lines",
  "public.inventory_counts",
  "public.inventory_item_allergens",
  "public.inventory_item_locations",
  "public.inventory_item_unit_conversions",
  "public.inventory_items",
  "public.inventory_lot_movements",
  "public.inventory_lots",
  "public.inventory_stock_alerts",
  "public.inventory_transactions",
  "public.inventory_transfer_lines",
  "public.inventory_transfers",
  "public.kitchen_remake_consumption",
  "public.kitchen_remakes",
  "public.kitchen_ticket_item_status_history",
  "public.kitchen_ticket_items",
  "public.kitchen_tickets",
  "public.location_settings",
  "public.locations",
  "public.login_throttles",
  "public.menu_availability",
  "public.menu_categories",
  "public.menu_item_allergen_reviews",
  "public.menu_item_allergens",
  "public.menu_item_modifier_groups",
  "public.menu_item_outages",
  "public.menu_item_placements",
  "public.menu_item_prep_routing",
  "public.menu_item_prices",
  "public.menu_item_stock_overrides",
  "public.menu_items",
  "public.menu_locations",
  "public.menus",
  "public.message_suppressions",
  "public.modifier_group_modifiers",
  "public.modifier_groups",
  "public.modifier_inventory_effects",
  "public.modifier_outages",
  "public.modifiers",
  "public.notifications",
  "public.online_booking_periods",
  "public.online_booking_settings",
  "public.order_allergies",
  "public.order_discounts",
  "public.order_item_allergens",
  "public.order_item_discounts",
  "public.order_item_inventory_consumption",
  "public.order_item_modifiers",
  "public.order_item_shares",
  "public.order_item_status_history",
  "public.order_item_transfers",
  "public.order_item_voids",
  "public.order_items",
  "public.order_number_counters",
  "public.order_refund_items",
  "public.order_refunds",
  "public.order_send_batches",
  "public.order_settlements",
  "public.order_status_history",
  "public.order_tax_lines",
  "public.orders",
  "public.organizations",
  "public.outbox_events",
  "public.party_status_history",
  "public.permissions",
  "public.positions",
  "public.prep_stations",
  "public.public_throttles",
  "public.purchase_order_lines",
  "public.purchase_order_receipt_lines",
  "public.purchase_order_receipts",
  "public.purchase_orders",
  "public.recipe_version_ingredients",
  "public.recipe_versions",
  "public.recipes",
  "public.reservation_hold_overrides",
  "public.reservation_manage_links",
  "public.reservation_table_assignments",
  "public.reservations",
  "public.restaurant_areas",
  "public.restaurant_tables",
  "public.role_permissions",
  "public.roles",
  "public.schedule_generation_runs",
  "public.schedule_periods",
  "public.scheduling_rules",
  "public.seed_runs",
  "public.server_section_assignments",
  "public.server_section_tables",
  "public.server_sections",
  "public.settlement_status_history",
  "public.settlement_tenders",
  "public.shift_assignments",
  "public.shift_swap_requests",
  "public.shifts",
  "public.staffing_template_requirements",
  "public.staffing_templates",
  "public.supplier_item_cost_history",
  "public.supplier_items",
  "public.suppliers",
  "public.table_condition_history",
  "public.table_session_overrides",
  "public.table_session_tables",
  "public.table_sessions",
  "public.tax_categories",
  "public.tax_rates",
  "public.time_entries",
  "public.time_entry_adjustments",
  "public.time_entry_breaks",
  "public.time_off_requests",
  "public.tip_declarations",
  "public.tip_distribution_lines",
  "public.tip_distributions",
  "public.tip_pool_rule_positions",
  "public.tip_pool_rules",
  "public.unit_conversions",
  "public.units_of_measure",
  "public.user_roles",
  "public.users",
  "public.waitlist_entries",
  "public.waitlist_table_assignments",
];

const journal = JSON.parse(
  readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
) as { entries: unknown[] };

// Each upgrade test rebuilds a database and replays every migration, which takes
// close to Vitest's 5 s default on a busy machine.
describe("reconstruction from checked-in migrations", { timeout: 30_000 }, () => {
  let databaseUrl: string;

  async function query<Row extends Record<string, unknown>>(
    statement: string,
  ): Promise<Row[]> {
    const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

    try {
      return (await client.unsafe(statement)) as unknown as Row[];
    } finally {
      await client.end();
    }
  }

  const listTables = () =>
    query<{ table_name: string }>(`
      SELECT schemaname || '.' || tablename AS table_name
      FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1
    `).then((rows) => rows.map((row) => row.table_name));

  const countAppliedMigrations = () =>
    query<{ total: string }>(
      "SELECT count(*) AS total FROM drizzle.__drizzle_migrations",
    ).then((rows) => Number(rows[0]?.total));

  beforeEach(async () => {
    databaseUrl = await recreateEmptyDatabase(
      requireTestDatabaseUrl(),
      RECONSTRUCTION_DATABASE,
    );
  });

  afterAll(async () => {
    await dropDatabase(requireTestDatabaseUrl(), RECONSTRUCTION_DATABASE);
  });

  it("starts from a database with no tables", async () => {
    expect(await listTables()).toEqual([]);
  });

  it("creates exactly the expected tables and none from later phases", async () => {
    await applyMigrations(databaseUrl);

    expect(await listTables()).toEqual(EXPECTED_TABLES);
  });

  it("keeps organization and security data from cascading on delete", async () => {
    await applyMigrations(databaseUrl);

    const foreignKeys = await query<{ conname: string; confdeltype: string }>(`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    `);

    expect(foreignKeys.length).toBeGreaterThan(0);
    // 'r' is RESTRICT.
    expect(foreignKeys.filter((key) => key.confdeltype !== "r")).toEqual([]);
  });

  it("creates the overlap protections that the schema language can't express", async () => {
    await applyMigrations(databaseUrl);

    const constraints = await query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE contype = 'x' AND connamespace = 'public'::regnamespace
      ORDER BY conname
    `);

    expect(constraints.map((row) => row.conname)).toEqual([
      "employee_locations_no_overlap",
      "employee_position_compensation_no_overlap",
      "employee_positions_no_overlap",
      "menu_availability_no_overlap",
      "menu_item_outages_no_overlap",
      "menu_item_prices_no_overlap",
      "modifier_outages_no_overlap",
      "recipe_versions_no_overlap",
      "schedule_periods_no_overlap",
      "tax_rates_no_overlap",
      "time_entries_no_overlap",
    ]);
  });

  it("names every foreign key within PostgreSQL's limit, unambiguously", async () => {
    await applyMigrations(databaseUrl);

    const names = await query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    `);

    // A truncated name is exactly 63 characters; the generated ones here are shorter.
    expect(names.filter((row) => row.conname.length >= 63)).toEqual([]);
  });

  it("gives positions no wage column", async () => {
    await applyMigrations(databaseUrl);

    const columns = await query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'positions'
    `);

    expect(columns.map((row) => row.column_name).sort()).toEqual([
      "active",
      "code",
      "created_at",
      "description",
      "id",
      "name",
      "organization_id",
      "updated_at",
      "version",
    ]);
  });

  it("applies every migration in the journal", async () => {
    await applyMigrations(databaseUrl);

    expect(journal.entries.length).toBeGreaterThan(0);
    expect(await countAppliedMigrations()).toBe(journal.entries.length);
  });

  it("creates seed_runs with the project's column conventions", async () => {
    await applyMigrations(databaseUrl);

    const columns = await query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'seed_runs'
      ORDER BY ordinal_position
    `);

    expect(columns).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "seed_key", data_type: "text", is_nullable: "NO" },
      {
        column_name: "applied_at",
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      },
    ]);
  });

  it("makes seed keys unique", async () => {
    await applyMigrations(databaseUrl);

    const constraints = await query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.seed_runs'::regclass AND contype = 'u'
    `);

    expect(constraints).toEqual([{ conname: "seed_runs_seed_key_unique" }]);
  });

  it("does nothing when migrations are applied again", async () => {
    await applyMigrations(databaseUrl);
    await query("INSERT INTO seed_runs (seed_key) VALUES ('fixture.kept')");

    await applyMigrations(databaseUrl);

    expect(await countAppliedMigrations()).toBe(journal.entries.length);
    expect(await query("SELECT seed_key FROM seed_runs")).toEqual([
      { seed_key: "fixture.kept" },
    ]);
  });

  it("upgrades a Phase 5 database in place, keeping its data", async () => {
    await upgradeFromMigrationIndex(7);
  });

  it("upgrades a Phase 6 database in place, keeping its data", async () => {
    await upgradeFromMigrationIndex(8);
  });

  it("upgrades a Phase 7 database in place, keeping its data", async () => {
    await upgradeFromMigrationIndex(10);
    expect(
      await query("SELECT allow_negative_inventory FROM location_settings"),
    ).toEqual([{ allow_negative_inventory: false }]);
    expect(await query("SELECT * FROM inventory_transactions")).toEqual([]);
  });

  it("upgrades a Phase 8 database in place, keeping its data", async () => {
    await upgradeFromMigrationIndex(12);
    expect(await query("SELECT * FROM orders")).toEqual([]);
    expect(await query("SELECT * FROM idempotency_records")).toEqual([]);
    expect(
      await query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_transactions' AND column_name = 'reverses_transaction_id'",
      ),
    ).toEqual([{ column_name: "reverses_transaction_id" }]);
  });

  it("upgrades a Phase 9 database in place, keeping its data and backfilling no tickets", async () => {
    await upgradeFromMigrationIndex(14);
    expect(await query("SELECT * FROM kitchen_tickets")).toEqual([]);
    expect(await query("SELECT * FROM kitchen_ticket_items")).toEqual([]);
    expect(await query("SELECT * FROM outbox_events")).toEqual([]);
    expect(await query("SELECT * FROM notifications")).toEqual([]);
  });

  it("upgrades a Phase 10 database in place, with no settlement history and the order guards", async () => {
    await upgradeFromMigrationIndex(18);
    expect(await query("SELECT * FROM order_settlements")).toEqual([]);
    expect(await query("SELECT * FROM settlement_tenders")).toEqual([]);
    expect(await query("SELECT * FROM settlement_status_history")).toEqual([]);
    expect(
      await query(
        "SELECT tgname FROM pg_trigger WHERE tgname IN ('orders_settlement_guard_trigger', 'order_settlements_guard_trigger', 'settlement_tenders_guard_trigger') ORDER BY tgname",
      ),
    ).toEqual([
      { tgname: "order_settlements_guard_trigger" },
      { tgname: "orders_settlement_guard_trigger" },
      { tgname: "settlement_tenders_guard_trigger" },
    ]);
  });

  it("upgrades a Phase 12 database in place, with an empty append-only audit trail", async () => {
    await upgradeFromMigrationIndex(21);
    expect(await query("SELECT * FROM audit_events")).toEqual([]);
    expect(
      await query(
        "SELECT tgname FROM pg_trigger WHERE tgname LIKE 'audit_events_%' ORDER BY tgname",
      ),
    ).toEqual([
      { tgname: "audit_events_append_only_trigger" },
      { tgname: "audit_events_no_truncate_trigger" },
    ]);
  });

  it("upgrades a Phase 15 database in place, keeping published outbox history deletable only", async () => {
    await upgradeFromMigrationIndex(23);
    expect(await query("SELECT * FROM login_throttles")).toEqual([]);
    expect(
      await query("SELECT must_change_password, password_changed_at FROM users"),
    ).toEqual([{ must_change_password: false, password_changed_at: null }]);

    await query(`
      INSERT INTO outbox_events (organization_id, event_type, aggregate_type, aggregate_id, payload, occurred_at, published_at)
      SELECT id, 'order.closed', 'order', gen_random_uuid(), '{}'::jsonb, now(), now() FROM organizations
      UNION ALL
      SELECT id, 'order.closed', 'order', gen_random_uuid(), '{}'::jsonb, now(), NULL FROM organizations
    `);
    await expect(query("DELETE FROM outbox_events WHERE published_at IS NULL")).rejects.toThrow(
      /Only a published outbox event can be deleted/,
    );
    await query("DELETE FROM outbox_events WHERE published_at IS NOT NULL");
    expect(await query("SELECT count(*)::int AS total FROM outbox_events")).toEqual([{ total: 1 }]);
    await expect(
      query("UPDATE outbox_events SET failed_at = now(), published_at = now()"),
    ).rejects.toThrow(/outbox_events_published_or_failed/);
    await query("UPDATE outbox_events SET failed_at = now()");
    await expect(query("DELETE FROM outbox_events")).rejects.toThrow(/Only a published outbox event can be deleted/);
  });

  it("upgrades a Phase 16 database in place: existing locations keep cash without a drawer, and tax is off", async () => {
    await upgradeFromMigrationIndex(25);
    expect(await query("SELECT tax_enabled, cash_drawer_required FROM location_settings")).toEqual([
      { tax_enabled: false, cash_drawer_required: false },
    ]);

    for (const table of [
      "tax_categories",
      "tax_rates",
      "order_tax_lines",
      "order_item_transfers",
      "cash_drawers",
      "cash_drawer_sessions",
      "cash_drawer_movements",
      "order_refunds",
      "order_refund_items",
    ]) {
      expect(await query(`SELECT * FROM ${table}`)).toEqual([]);
    }

    expect(
      await query(
        "SELECT column_default FROM information_schema.columns WHERE table_name = 'location_settings' AND column_name = 'cash_drawer_required'",
      ),
    ).toEqual([{ column_default: "true" }]);
    expect(
      await query(
        "SELECT tgname FROM pg_trigger WHERE tgname IN ('kitchen_tickets_guard_trigger', 'kitchen_tickets_append_only_trigger', 'order_refunds_guard_trigger', 'cash_drawer_sessions_guard_trigger', 'order_items_batch_order_guard_trigger') ORDER BY tgname",
      ),
    ).toEqual([
      { tgname: "cash_drawer_sessions_guard_trigger" },
      { tgname: "kitchen_tickets_guard_trigger" },
      { tgname: "order_items_batch_order_guard_trigger" },
      { tgname: "order_refunds_guard_trigger" },
    ]);
  });

  it("upgrades a Phase 17 database in place: time clock and tips start empty, overtime defaults apply", async () => {
    // 0000-0034 are Phase 17 and earlier; 0035 and 0036 are Phase 18.
    await upgradeFromMigrationIndex(34);

    for (const table of [
      "time_entries",
      "time_entry_breaks",
      "time_entry_adjustments",
      "tip_pool_rules",
      "tip_pool_rule_positions",
      "tip_distributions",
      "tip_distribution_lines",
    ]) {
      expect(await query(`SELECT * FROM ${table}`)).toEqual([]);
    }

    expect(
      await query(
        "SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'scheduling_rules' AND column_name IN ('overtime_multiplier', 'late_clock_in_grace_minutes') ORDER BY column_name",
      ),
    ).toEqual([
      { column_name: "late_clock_in_grace_minutes", column_default: "5", is_nullable: "NO" },
      { column_name: "overtime_multiplier", column_default: "1.50", is_nullable: "NO" },
    ]);
    expect(
      await query(
        "SELECT tgname FROM pg_trigger WHERE tgname IN ('time_entries_guard_trigger', 'time_entry_breaks_guard_trigger', 'time_entry_adjustments_append_only_trigger', 'tip_distributions_guard_trigger', 'tip_distribution_lines_append_only_trigger') ORDER BY tgname",
      ),
    ).toEqual([
      { tgname: "time_entries_guard_trigger" },
      { tgname: "time_entry_adjustments_append_only_trigger" },
      { tgname: "time_entry_breaks_guard_trigger" },
      { tgname: "tip_distribution_lines_append_only_trigger" },
      { tgname: "tip_distributions_guard_trigger" },
    ]);
  });

  it("upgrades a Phase 18 database in place: 86 list and alerts start empty, auto-86 is off", async () => {
    // 0000-0036 are Phase 18 and earlier; 0037 and 0038 are Phase 19.
    await upgradeFromMigrationIndex(36);

    for (const table of ["menu_item_outages", "menu_item_stock_overrides", "inventory_stock_alerts"]) {
      expect(await query(`SELECT * FROM ${table}`)).toEqual([]);
    }

    expect(
      await query(
        "SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'location_settings' AND column_name = 'auto_86_from_stock'",
      ),
    ).toEqual([{ column_default: "false", is_nullable: "NO" }]);
    expect(
      await query(
        "SELECT tgname FROM pg_trigger WHERE tgname IN ('menu_item_outages_guard', 'menu_item_stock_overrides_guard', 'inventory_stock_alerts_guard', 'notifications_guard_trigger') ORDER BY tgname",
      ),
    ).toEqual([
      { tgname: "inventory_stock_alerts_guard" },
      { tgname: "menu_item_outages_guard" },
      { tgname: "menu_item_stock_overrides_guard" },
      { tgname: "notifications_guard_trigger" },
    ]);
  });

  it("upgrades a Phase 19 database in place: new Phase 20 tables start empty, defaults apply", async () => {
    // 0000-0038 are Phase 19 and earlier; 0039-0047 are Phase 20.
    await upgradeFromMigrationIndex(38);

    for (const table of ["modifier_outages", "order_item_shares", "tip_declarations"]) {
      expect(await query(`SELECT * FROM ${table}`)).toEqual([]);
    }

    expect(await query("SELECT running_low_portions FROM location_settings")).toEqual([{ running_low_portions: 5 }]);
    expect(
      await query(
        "SELECT column_name, column_default FROM information_schema.columns WHERE (table_name, column_name) IN (('orders', 'included_tax_total'), ('orders', 'tax_exempt'), ('tax_rates', 'price_includes_tax'), ('order_refunds', 'tip_amount')) ORDER BY column_name",
      ),
    ).toEqual([
      { column_name: "included_tax_total", column_default: "0.00" },
      { column_name: "price_includes_tax", column_default: "false" },
      { column_name: "tax_exempt", column_default: "false" },
      { column_name: "tip_amount", column_default: "0.00" },
    ]);
    expect(
      await query(
        "SELECT tgname FROM pg_trigger WHERE tgname IN ('modifier_outages_guard', 'order_item_shares_guard_trigger', 'order_item_shares_order_open_trigger') ORDER BY tgname",
      ),
    ).toEqual([
      { tgname: "modifier_outages_guard" },
      { tgname: "order_item_shares_guard_trigger" },
      { tgname: "order_item_shares_order_open_trigger" },
    ]);
  });

  async function upgradeFromMigrationIndex(lastIndex: number): Promise<void> {
    // Apply only the migrations Phase 5 shipped, from a copy with a shortened journal.
    const oldFolder = mkdtempSync(path.join(tmpdir(), "old-migrations-"));

    try {
      cpSync(MIGRATIONS_FOLDER, oldFolder, { recursive: true });

      const journalPath = path.join(oldFolder, "meta", "_journal.json");
      const full = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { idx: number }[];
      };

      writeFileSync(
        journalPath,
        JSON.stringify({
          ...full,
          entries: full.entries.filter((entry) => entry.idx <= lastIndex),
        }),
      );

      const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

      try {
        await migrate(drizzle(client), { migrationsFolder: oldFolder });
      } finally {
        await client.end();
      }
    } finally {
      rmSync(oldFolder, { recursive: true, force: true });
    }

    expect(await countAppliedMigrations()).toBe(lastIndex + 1);
    await query(`
      WITH org AS (
        INSERT INTO organizations (name, default_timezone, default_currency)
        VALUES ('Upgrade Org', 'America/Detroit', 'USD') RETURNING id
      ), loc AS (
        INSERT INTO locations (organization_id, name, location_code, timezone)
        SELECT id, 'Upgrade Location', 'UPGRADE', 'America/Detroit' FROM org RETURNING id
      ), settings AS (
        INSERT INTO location_settings (location_id) SELECT id FROM loc RETURNING location_id
      ), usr AS (
        INSERT INTO users (email, normalized_email, password_hash)
        VALUES ('upgrade@example.test', 'upgrade@example.test', 'x') RETURNING id
      ), area AS (
        INSERT INTO restaurant_areas (location_id, code, name, area_type)
        SELECT id, 'DINING_ROOM', 'Dining', 'DINING' FROM loc RETURNING id, location_id
      ), tbl AS (
        INSERT INTO restaurant_tables (location_id, restaurant_area_id, table_number, capacity)
        SELECT location_id, id, 'U1', 4 FROM area RETURNING id
      )
      INSERT INTO table_sessions (location_id, party_size, created_by_user_id)
      SELECT loc.id, 3, usr.id FROM loc, usr
    `);

    await applyMigrations(databaseUrl);

    expect(await countAppliedMigrations()).toBe(journal.entries.length);
    expect(
      await query(
        "SELECT reservation_pre_hold_minutes AS pre, reservation_post_grace_minutes AS post FROM location_settings",
      ),
    ).toEqual([{ pre: 15, post: 15 }]);
    expect(
      await query("SELECT party_size, guest_party_id, status FROM table_sessions"),
    ).toEqual([{ party_size: 3, guest_party_id: null, status: "ACTIVE" }]);
    expect(await query("SELECT * FROM reservations")).toEqual([]);
    expect(await query("SELECT * FROM guest_parties")).toEqual([]);
    expect(await query("SELECT * FROM menu_items")).toEqual([]);
  }

  it("rebuilds to the same state, removing all data and extra tables", async () => {
    await applyMigrations(databaseUrl);
    await query("INSERT INTO seed_runs (seed_key) VALUES ('fixture.removed')");
    await query("CREATE TABLE public.left_behind (id INTEGER)");

    await rebuildFromMigrations(databaseUrl);

    expect(await listTables()).toEqual(EXPECTED_TABLES);
    expect(await query("SELECT seed_key FROM seed_runs")).toEqual([]);
    expect(await countAppliedMigrations()).toBe(journal.entries.length);
    // It builds the whole schema twice, so it needs more than the default 5 seconds.
  }, 30_000);
});
