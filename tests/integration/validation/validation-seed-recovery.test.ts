import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireTestDatabaseUrl } from "@/config/tooling-env";
import type { Database } from "@/db";
import { VALIDATION_DINER, VALIDATION_TAKEOUT } from "@/db/demo/validation-fixture";
import { applyMigrations } from "@/db/maintenance/apply-migrations";
import * as schema from "@/db/schema";
import { seeds } from "@/db/seeds/registry";
import { runSeeds } from "@/db/seeds/run-seeds";
import { normalizeEmail } from "@/modules/auth/email";
import { bootstrapOwner } from "@/modules/auth/services/owner-bootstrap";
import { getUserAuthContext, requirePermission } from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";
import { recordAdjustment } from "@/modules/inventory/services/stock-operations";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { checkInReservation, createReservation } from "@/modules/reservations/services/reservation-service";
import { getFloorStatus } from "@/modules/restaurant/services/floor-service";
import { openSettlement, recordTender } from "@/modules/settlements/services/settlement-service";
import { localDateOf, localTimeOf } from "@/shared/time/zoned-time";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { seatReservationParty } from "@/workflows/seat-guest-party/seat-guest-party";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { seedDemoKitchen } from "../../../scripts/demo-kitchen";
import { seedValidationFixture } from "../../../scripts/validation-fixture";
import { dropDatabase, recreateEmptyDatabase } from "../../helpers/prepare-test-database";

const RECOVERY_DATABASE = "restaurant_ops_test_validation_recovery";

/**
 * A dev database where demo service history used up the burger's stock and an earlier
 * validation run stopped after seating (refused for stock at SEND), with the check settled in
 * the app since but the guests never marked as gone. The fixture finishes that visit and
 * records the missing stock as found, instead of refusing.
 */
describe("validation seed on a dev database whose stock ran out", () => {
  let client: postgres.Sql;
  let database: Database;
  let actor: Actor;
  let first: Awaited<ReturnType<typeof seedValidationFixture>>;
  let second: Awaited<ReturnType<typeof seedValidationFixture>>;
  let stuckOrderId: string;

  const itemByCode = async (code: string) => {
    const [row] = await database.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.code, code));

    return row!;
  };

  const onHand = async (inventoryItemId: string) => {
    const [row] = await database
      .select({ quantity: schema.inventoryBalances.quantityOnHand })
      .from(schema.inventoryBalances)
      .where(and(eq(schema.inventoryBalances.inventoryItemId, inventoryItemId), eq(schema.inventoryBalances.locationId, actor.locationId)));

    return row?.quantity ?? "0.0000";
  };

  beforeAll(async () => {
    const url = await recreateEmptyDatabase(requireTestDatabaseUrl(), RECOVERY_DATABASE);

    await applyMigrations(url);
    client = postgres(url, { max: 4, onnotice: () => {} });
    database = drizzle(client, { schema });
    await runSeeds(database, seeds);
    await bootstrapOwner(database, { email: "recovery-owner@example.test", password: "correct horse battery staple" });

    const [user] = await database
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.normalizedEmail, normalizeEmail("recovery-owner@example.test")));
    const [main] = await database.select().from(schema.locations).where(eq(schema.locations.locationCode, "MAIN"));

    actor = requirePermission((await getUserAuthContext(database, user!.id))!, { permission: "employees.create", locationId: main!.id });

    // MAIN takes card tenders without a drawer, so the stuck check needs none.
    await seedDemoKitchen(database, actor);

    // The stuck visit: seated, fries sent and settled, the guests never marked as gone.
    const soon = new Date(Date.now() + 10 * 60_000);
    const reservation = await createReservation(database, actor, {
      guestName: VALIDATION_DINER,
      partySize: 2,
      source: "PHONE",
      expectedDurationMinutes: 60,
      localDate: localDateOf(soon, main!.timezone),
      localTime: localTimeOf(soon, main!.timezone),
      status: "CONFIRMED",
    });
    const checkedIn = await checkInReservation(database, actor, reservation.id, { expectedVersion: reservation.version });
    const table = (await getFloorStatus(database, actor)).find(
      (candidate) => candidate.area.type === "DINING" && candidate.availability === "AVAILABLE" && candidate.capacity >= 2,
    )!;
    const seated = await seatReservationParty(database, actor, {
      reservationId: reservation.id,
      expectedVersion: checkedIn.version,
      tableIds: [table.id],
      serverEmployeeId: null,
    });
    const order = await createOrder(database, actor, { orderType: "DINE_IN", tableSessionId: seated.id });
    const [fries] = await database.select().from(schema.menuItems).where(eq(schema.menuItems.code, "FRENCH_FRIES"));
    const drafted = await addDraftItem(database, actor, order.id, {
      expectedVersion: order.version,
      menuItemId: fries!.id,
      quantity: 1,
      selections: [],
      specialInstructions: null,
    });

    await sendOrderItems(database, actor, order.id, { expectedVersion: drafted.orderVersion, idempotencyKey: randomUUID() });

    const opened = await openSettlement(database, actor, order.id);
    const tendered = await recordTender(database, actor, opened.settlementId, {
      idempotencyKey: randomUUID(),
      expectedVersion: opened.settlementVersion,
      tenderType: "EXTERNAL_CARD",
      outcome: "RECORDED",
      amount: opened.orderAmountSnapshot,
      tipAmount: null,
      receivedAmount: null,
      externalReference: null,
      providerName: null,
      cardBrand: null,
      cardLastFour: null,
      authorizationReference: null,
      otherDescription: null,
      failureReason: null,
    });

    await completeSettlement(database, actor, opened.settlementId, {
      expectedVersion: tendered.settlementVersion,
      idempotencyKey: randomUUID(),
    });
    stuckOrderId = order.id;

    // Demo history used up the beef and the buns.
    for (const code of ["GROUND_BEEF", "BRIOCHE_BUN"]) {
      const item = await itemByCode(code);
      const quantity = await onHand(item.id);

      if (Number(quantity) > 0) {
        await recordAdjustment(database, actor, {
          inventoryItemId: item.id,
          quantity,
          unitOfMeasureId: item.baseUnitId,
          direction: "DECREASE",
          reasonCode: "DATA_CORRECTION",
          notes: "Test: demo history used it up",
        });
      }
    }

    first = await seedValidationFixture(database, actor);
    second = await seedValidationFixture(database, actor);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await dropDatabase(requireTestDatabaseUrl(), RECOVERY_DATABASE);
  });

  it("finishes the earlier visit instead of refusing, and skips on the second run", async () => {
    expect(first).toMatchObject({ skipped: false, dineIn: true, takeout: true });
    expect(second).toEqual({ skipped: true });

    const [diner] = await database
      .select({ reservation: schema.reservations.status, party: schema.guestParties.status })
      .from(schema.reservations)
      .innerJoin(schema.guestParties, eq(schema.guestParties.id, schema.reservations.guestPartyId))
      .where(eq(schema.guestParties.guestName, VALIDATION_DINER));

    expect(diner).toEqual({ reservation: "COMPLETED", party: "COMPLETED" });
    expect(
      (await database.select().from(schema.kitchenTicketItems).where(eq(schema.kitchenTicketItems.orderId, stuckOrderId))).map(
        (item) => item.status,
      ),
    ).toEqual(["COMPLETED"]);
    expect(await client`SELECT count(*)::int AS n FROM table_sessions WHERE status = 'ACTIVE'`).toEqual([{ n: 0 }]);
    expect(await client`SELECT count(*)::int AS n FROM restaurant_tables WHERE condition = 'DIRTY'`).toEqual([{ n: 0 }]);
  });

  it("records the missing burger stock as found, then sells the takeout burger", async () => {
    const [takeout] = await database
      .select({ status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.customerName, VALIDATION_TAKEOUT));

    expect(takeout).toEqual({ status: "CLOSED" });

    const found = await client<{ code: string; quantity: string }[]>`
      SELECT ii.code, it.quantity::text AS quantity
      FROM inventory_transactions it JOIN inventory_items ii ON ii.id = it.inventory_item_id
      WHERE it.transaction_type = 'ADJUST_INCREASE' AND it.reason_code = 'FOUND_STOCK'
        AND it.notes = 'Phase 13 validation fixture: stock for the canonical burger'
      ORDER BY ii.code`;

    expect(found.map((row) => row.code)).toEqual(["BRIOCHE_BUN", "GROUND_BEEF"]);

    // Exactly what one burger needed: both are back to nothing after the sale.
    expect(await onHand((await itemByCode("GROUND_BEEF")).id)).toBe("0.0000");
    expect(await onHand((await itemByCode("BRIOCHE_BUN")).id)).toBe("0.0000");
  });

  it("keeps every inventory balance equal to the ledger", async () => {
    // The same check as the main validation test: each balance equals its latest ledger row.
    const mismatched = await client`
      SELECT b.inventory_item_id
      FROM inventory_balances b
      LEFT JOIN LATERAL (
        SELECT t.quantity_after FROM inventory_transactions t
        WHERE t.inventory_item_id = b.inventory_item_id AND t.location_id = b.location_id
        ORDER BY t.sequence DESC LIMIT 1
      ) last ON true
      WHERE last.quantity_after IS DISTINCT FROM b.quantity_on_hand`;

    expect(mismatched).toEqual([]);
  });
});
