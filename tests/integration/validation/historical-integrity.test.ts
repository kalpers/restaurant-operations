import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  inventoryTransactions,
  orderItemInventoryConsumption,
  orderItemModifiers,
  orderItems,
  orders,
  settlements,
  settlementTenders,
} from "@/db/schema";
import { changeCompensation } from "@/modules/employees/services/compensation-service";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { changePrice } from "@/modules/menu/services/pricing-service";
import { addModifierEffect } from "@/modules/menu/services/modifier-effect-service";
import { addIngredient } from "@/modules/recipes/services/ingredient-service";
import { createDraftRevision, publishRevision } from "@/modules/recipes/services/recipe-service";
import { runReport } from "@/modules/reporting/services/report-service";
import { REPORT_AREAS } from "@/modules/reporting/types";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  DAY,
  localInstant,
  runRestaurantDay,
  startFakeClock,
  stopFakeClock,
  SUNDAY,
  type RestaurantDay,
} from "../../fixtures/restaurant-day";

const database = () => getDatabase();

/**
 * README rule 4: history is never recalculated from current configuration. After the
 * simulated day, every configuration a report could be tempted to read is changed through
 * its own service, effective before the day (the real clock is years earlier than the
 * simulated 2030 day), and nothing about the day may move.
 */
describe("Phase 13: historical integrity after configuration changes", () => {
  let day: RestaurantDay;

  const allReports = () =>
    Promise.all(
      REPORT_AREAS.map((area) =>
        runReport(database(), day.actors.reporter, area, { locationId: day.scenario.locationA, from: DAY, to: DAY }),
      ),
    );

  const facts = async () => {
    const orderIds = [day.orders.garcia.id, day.orders.takeout.id, day.orders.late.id];
    const items = await database().select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
    const itemIds = items.map((item) => item.id);
    const settlementRows = await database().select().from(settlements).where(inArray(settlements.orderId, orderIds));

    return {
      orders: await database().select().from(orders).where(inArray(orders.id, orderIds)),
      items,
      modifiers: await database().select().from(orderItemModifiers).where(inArray(orderItemModifiers.orderItemId, itemIds)),
      consumption: await database()
        .select()
        .from(orderItemInventoryConsumption)
        .where(inArray(orderItemInventoryConsumption.orderItemId, itemIds)),
      ledger: await database()
        .select()
        .from(inventoryTransactions)
        .where(inArray(inventoryTransactions.locationId, [day.scenario.locationA])),
      settlements: settlementRows,
      tenders: await database()
        .select()
        .from(settlementTenders)
        .where(inArray(settlementTenders.settlementId, settlementRows.map((row) => row.id))),
    };
  };

  let reportsBefore: Awaited<ReturnType<typeof allReports>>;
  let factsBefore: Awaited<ReturnType<typeof facts>>;

  beforeAll(async () => {
    startFakeClock();

    try {
      day = await runRestaurantDay(database());
    } finally {
      stopFakeClock();
    }

    reportsBefore = await allReports();
    factsBefore = await facts();

    const { owner, burger } = day.scenario;

    // A new burger price, effective now: years before the simulated day.
    await changePrice(database(), owner, burger.menuItem.id, { locationId: null, price: "21.00", effectiveFrom: null });

    // A new recipe revision: double bacon, effective now.
    const draft = await createDraftRevision(database(), owner, burger.recipe.id, {
      yieldQuantity: "1",
      yieldUnitId: day.scenario.units.each,
      preparationNotes: "Double bacon",
    });
    const added = await addIngredient(database(), owner, burger.recipe.id, draft.id, {
      inventoryItemId: burger.stock.bacon.id,
      quantity: "4",
      unitOfMeasureId: day.scenario.units.each,
      preparationNote: null,
      sortOrder: 0,
      expectedVersion: draft.version,
    });

    await publishRevision(database(), owner, burger.recipe.id, draft.id, {
      effectiveFrom: null,
      expectedVersion: added.revisionVersion,
    });

    // Extra Pickles now also adds an onion slice.
    await addModifierEffect(database(), owner, burger.modifiers.extraPickles.id, {
      menuItemId: burger.menuItem.id,
      inventoryItemId: burger.stock.onion.id,
      effectType: "ADD",
      quantity: "1",
      unitOfMeasureId: day.scenario.units.each,
    });

    // A raise for the server from Sunday: the shift date's rate still applies to Saturday.
    await changeCompensation(database(), owner, {
      employeeId: day.employees.server,
      positionId: day.scenario.server,
      compensationType: "HOURLY",
      hourlyRate: "30.00",
      annualSalary: null,
      effectiveFrom: SUNDAY,
      changeReason: null,
    });
  }, 120_000);

  afterAll(async () => {
    stopFakeClock();
    await clearEmployeeData(database());
    await closeDatabase();
  });

  it("current configuration would now price the day's burger differently", async () => {
    // Asked as of the moment the canonical burger was sent, the menu now says 21.00.
    const menu = await getOperationalMenu(database(), day.actors.server, localInstant(DAY, "19:20"));

    expect(JSON.stringify(menu)).toContain('"price":"21.00"');
  });

  it("leaves every snapshot, ledger row, settlement and tender exactly as it was", async () => {
    expect(await facts()).toEqual(factsBefore);
  });

  it("gives identical reports for the day in every area", async () => {
    expect(await allReports()).toEqual(reportsBefore);
  });
});
