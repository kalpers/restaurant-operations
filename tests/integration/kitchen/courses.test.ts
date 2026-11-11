import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import { kitchenTickets } from "@/db/schema";
import { getExpoView, getStationQueue, fulfillmentForOrder } from "@/modules/kitchen/queries/kitchen-queries";
import { fireCourse, heldCoursesForOrder } from "@/modules/kitchen/services/course-fire-service";
import { transitionTicketItem } from "@/modules/kitchen/services/fulfillment-service";
import { AppError } from "@/shared/errors/app-error";
import { remakeOrderItem } from "@/workflows/remake-order-item/remake-order-item";
import { voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import { actorWith } from "../../fixtures/employee-fixtures";
import {
  COOK_PERMISSIONS,
  createKitchenScenario,
  sendOrder,
  ticketItemsForOrder,
  ticketsForOrder,
  type KitchenScenario,
} from "../../fixtures/kitchen-fixtures";
import {
  clearOrderData,
  MANAGER_ORDER_PERMISSIONS,
  newKey,
  onHand,
  orderRow,
  SERVER_ORDER_PERMISSIONS,
} from "../../fixtures/order-fixtures";

const database = () => getDatabase();

async function constraintOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return readConstraintName(error);
  }

  return undefined;
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : `DB:${(error as Error).message}`;
  }

  return undefined;
}

describe("courses and hold/fire (Phase 17 policy D)", () => {
  let scenario: KitchenScenario;
  let firer: Awaited<ReturnType<typeof actorWith>>;

  beforeEach(async () => {
    scenario = await createKitchenScenario(database());
    firer = await actorWith(database(), scenario.base, [...SERVER_ORDER_PERMISSIONS, "orders.fire", "kitchen.view"]);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  /** Fries (course 1) and the canonical burger (course 2), sent with Send & hold. */
  async function sendAndHold(key = newKey()) {
    return sendOrder(
      database(),
      scenario,
      [
        { menuItemId: scenario.fries.id, courseNumber: 1 },
        { menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.canonicalSelections, courseNumber: 2 },
      ],
      { fire: "FIRST_COURSE", key },
    );
  }

  it("holds later courses with their stock already consumed, and keeps them off the station queues", async () => {
    const { order } = await sendAndHold();
    const tickets = await ticketsForOrder(database(), order.id);
    const fry = tickets.find((ticket) => ticket.prepStationId === scenario.stations.fry.id)!;
    const grill = tickets.find((ticket) => ticket.prepStationId === scenario.stations.grill.id)!;

    expect(fry).toMatchObject({ courseNumber: 1, heldAt: null });
    expect(fry.firedAt).toEqual(fry.submittedAt);
    expect(grill).toMatchObject({ courseNumber: 2, firedAt: null, firedByUserId: null });
    expect(grill.heldAt).toEqual(grill.submittedAt);

    // SEND consumed the burger's stock, held or not (canonical transaction unchanged).
    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("92.0000");

    const queue = await getStationQueue(database(), scenario.cook, { stationType: "KITCHEN" });

    expect(queue.active.map((ticket) => ticket.id)).toContain(fry.id);
    expect(queue.active.map((ticket) => ticket.id)).not.toContain(grill.id);

    const expo = (await getExpoView(database(), scenario.cook)).orders.find((entry) => entry.orderId === order.id)!;

    expect(expo.heldCourses).toEqual([2]);
    expect(expo.items.find((item) => item.name === "Bacon Cheeseburger")).toMatchObject({ held: true, courseNumber: 2 });
    expect(await heldCoursesForOrder(database(), order.id)).toEqual([2]);
    expect((await fulfillmentForOrder(database(), order.id)).get(grill.id)).toBeUndefined();
  });

  it("refuses to start held work, in the service and in the database", async () => {
    const { order } = await sendAndHold();
    const work = (await ticketItemsForOrder(database(), order.id)).find(
      (item) => item.prepStationId === scenario.stations.grill.id,
    )!;

    expect(
      await codeOf(transitionTicketItem(database(), scenario.cook, work.id, "start", { expectedVersion: work.version })),
    ).toBe("TICKET_HELD");
    expect(
      await constraintOf(
        database().execute(
          sql`UPDATE kitchen_ticket_items SET status = 'PREPARING', started_at = now(), started_by_user_id = ${scenario.cook.userId} WHERE id = ${work.id}`,
        ),
      ),
    ).toBe("kitchen_ticket_items_held");
    expect(
      await codeOf(
        remakeOrderItem(database(), scenario.cook, order.id, work.orderItemId, { reason: "x", idempotencyKey: newKey() }),
      ),
    ).toBe("TICKET_HELD");
  });

  it("fires a course once; firing again writes nothing", async () => {
    const { order } = await sendAndHold();
    const fired = await fireCourse(database(), firer, order.id, 2);

    expect(fired.firedTicketIds).toHaveLength(1);

    const [grill] = await database()
      .select()
      .from(kitchenTickets)
      .where(eq(kitchenTickets.id, fired.firedTicketIds[0]!));

    expect(grill).toMatchObject({ firedByUserId: firer.userId });
    expect(grill!.firedAt).not.toBeNull();
    expect((await fireCourse(database(), firer, order.id, 2)).firedTicketIds).toEqual([]);
    expect(await heldCoursesForOrder(database(), order.id)).toEqual([]);

    const queue = await getStationQueue(database(), scenario.cook, { stationType: "KITCHEN" });
    const onQueue = queue.active.find((ticket) => ticket.id === grill!.id)!;

    expect(onQueue.courseNumber).toBe(2);

    const work = onQueue.items[0]!;
    const started = await transitionTicketItem(database(), scenario.cook, work.id, "start", {
      expectedVersion: work.version,
    });

    expect(started.status).toBe("PREPARING");

    // A fired ticket can't be fired again or changed otherwise.
    expect(
      await codeOf(database().execute(sql`UPDATE kitchen_tickets SET fired_at = now() WHERE id = ${grill!.id}`)),
    ).toMatch(/^DB:/);
  });

  it("requires orders.fire and an open order", async () => {
    const { order } = await sendAndHold();
    const cook = await actorWith(database(), scenario.base, COOK_PERMISSIONS);

    expect(await codeOf(fireCourse(database(), cook, order.id, 2))).toBe("PERMISSION_DENIED");
  });

  it("voids a held item as unprepared and reverses its stock", async () => {
    const { order, sent } = await sendAndHold();
    const manager = await actorWith(database(), scenario.base, [...MANAGER_ORDER_PERMISSIONS, ...COOK_PERMISSIONS]);
    const burgerItemId = sent.itemIds[1]!;

    await voidOrderItem(database(), manager, order.id, burgerItemId, {
      reason: "Guest left early",
      disposition: "UNPREPARED",
      expectedVersion: (await orderRow(database(), order.id)).version,
    });

    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("100.0000");
    expect(
      (await ticketItemsForOrder(database(), order.id)).find((item) => item.orderItemId === burgerItemId)!.status,
    ).toBe("CANCELLED");
  });

  it("creates no extra held ticket when SEND is retried", async () => {
    const key = newKey();
    const { order } = await sendAndHold(key);

    expect(await ticketsForOrder(database(), order.id)).toHaveLength(2);
    // The fixture's retry would need the same request; the unique (batch, station, course)
    // index is the final guard.
    const [grill] = (await ticketsForOrder(database(), order.id)).filter((ticket) => ticket.firedAt === null);

    expect(
      await codeOf(
        database().execute(sql`
          INSERT INTO kitchen_tickets (organization_id, location_id, prep_station_id, order_id, send_batch_id,
            attempt_number, business_date, submitted_at, station_code_snapshot, station_name_snapshot,
            station_type_snapshot, order_number_snapshot, order_type_snapshot, batch_number_snapshot,
            course_number, held_at)
          SELECT organization_id, location_id, prep_station_id, order_id, send_batch_id, attempt_number,
            business_date, submitted_at, station_code_snapshot, station_name_snapshot, station_type_snapshot,
            order_number_snapshot, order_type_snapshot, batch_number_snapshot, course_number, held_at
          FROM kitchen_tickets WHERE id = ${grill!.id}`),
      ),
    ).toMatch(/^DB:/);
  });

  it("sends everything at once by default, one ticket per station and course", async () => {
    const { order } = await sendOrder(database(), scenario, [
      { menuItemId: scenario.fries.id, courseNumber: 1 },
      { menuItemId: scenario.fries.id, courseNumber: 3 },
    ]);
    const tickets = await ticketsForOrder(database(), order.id);

    expect(tickets.map((ticket) => [ticket.courseNumber, ticket.firedAt !== null]).sort()).toEqual([
      [1, true],
      [3, true],
    ]);
  });
});
