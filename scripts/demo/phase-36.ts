import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../../src/db";
import {
  checklistTemplates,
  eventBookings,
  menuItems,
  positions,
  restaurantTables,
  supplierInvoices,
  suppliers,
  temperaturePoints,
} from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { itemLineAmount } from "../../src/modules/inventory/rules/invoice-rules";
import { approveInvoice, createInvoice, disputeInvoice, listInvoiceableReceiptLines } from "../../src/modules/inventory/services/invoice-service";
import { saveBundleConfiguration } from "../../src/modules/menu/services/bundle-service";
import { createItem, createPlacement, listCategories, listMenus } from "../../src/modules/menu/services/catalog-service";
import { changePrice } from "../../src/modules/menu/services/pricing-service";
import { createEvent } from "../../src/modules/reservations/services/event-service";
import { readLocationClock } from "../../src/modules/restaurant/services/access";
import { createChecklistTemplate, setChecklistItem, startChecklistRun } from "../../src/modules/restaurant/services/checklist-service";
import { createTemperaturePoint, recordTemperatureReading } from "../../src/modules/restaurant/services/temperature-service";
import { addDecimals, multiplyExact, roundHalfUp, sumDecimals } from "../../src/shared/decimal/decimal";
import { addDays, dayOfWeek, localToInstant } from "../../src/shared/time/zoned-time";

import { atInstant } from "./clock";

// Phase 36 (D40): checklists, temperature logs, events, supplier invoices and bundles at MAIN,
// through the services a manager would use. Each part runs only while MAIN has none of its kind,
// so a rerun adds nothing. Local dev DB only.

const key = () => `demo-36-${randomUUID()}`;

async function seedChecklists(database: Database, owner: Actor): Promise<string> {
  const [existing] = await database.select({ id: checklistTemplates.id }).from(checklistTemplates).where(eq(checklistTemplates.locationId, owner.locationId)).limit(1);

  if (existing) {
    return "checklists already there";
  }

  const [server] = await database
    .select({ id: positions.id })
    .from(positions)
    .where(and(eq(positions.organizationId, owner.organizationId), eq(positions.code, "SERVER")));
  const opening = await createChecklistTemplate(database, owner, {
    name: "Opening",
    kind: "OPENING",
    requiresSignOff: false,
    positionIds: [],
    items: [
      { text: "Pizza oven on and at temperature by 10:30", required: true },
      { text: "Walk-in and reach-in temperatures logged", required: true },
      { text: "Dough proofed and portioned", required: true },
      { text: "Front door unlocked, music and lights on", required: true },
      { text: "Restrooms checked and stocked", required: false },
    ],
  });

  await createChecklistTemplate(database, owner, {
    name: "Closing",
    kind: "CLOSING",
    requiresSignOff: true,
    positionIds: [],
    items: [
      { text: "Oven decks brushed and turned down", required: true },
      { text: "Cold line wrapped, labelled and dated", required: true },
      { text: "Floors swept and mopped", required: true },
      { text: "Cash drawers closed out", required: true },
      { text: "Back door locked and alarm set", required: true },
    ],
  });
  await createChecklistTemplate(database, owner, {
    name: "Server side work",
    kind: "SIDE_WORK",
    requiresSignOff: true,
    positionIds: server ? [server.id] : [],
    items: [
      { text: "Roll 30 sets of silverware", required: true },
      { text: "Refill parmesan and chili flake shakers", required: true },
      { text: "Restock to-go boxes and pizza boxes", required: true },
      { text: "Wipe menus", required: false },
    ],
  });

  // Today's opening, part done.
  const run = await startChecklistRun(database, owner, { templateId: opening.id });

  for (const item of run.items.slice(0, 2)) {
    await setChecklistItem(database, owner, item.id, { state: "DONE", expectedVersion: item.version });
  }

  return "opening, closing and server side work templates; today's opening checklist part done";
}

async function seedTemperatures(database: Database, owner: Actor, timeZone: string, today: string): Promise<string> {
  const [existing] = await database.select({ id: temperaturePoints.id }).from(temperaturePoints).where(eq(temperaturePoints.locationId, owner.locationId)).limit(1);

  if (existing) {
    return "temperature points already there";
  }

  const point = (name: string, kind: Parameters<typeof createTemperaturePoint>[2]["kind"], minimumValue: string | null, maximumValue: string | null, sortOrder: number) =>
    createTemperaturePoint(database, owner, { name, kind, minimumValue, maximumValue, checkIntervalMinutes: 240, sortOrder });
  const walkIn = await point("Walk-in cooler", "COLD_HOLDING", "33", "41", 10);
  const reachIn = await point("Prep line reach-in", "COLD_HOLDING", "33", "41", 20);
  const freezer = await point("Freezer", "FROZEN", null, "0", 30);
  const hotWell = await point("Sauce hot well", "HOT_HOLDING", "135", null, 40);
  const read = (date: string, time: string, pointId: string, value: string, extra: { correctiveAction?: string; followsUpReadingId?: string } = {}) =>
    atInstant(localToInstant(date, time, timeZone)!, () => recordTemperatureReading(database, owner, { idempotencyKey: key(), pointId, value, ...extra }));
  const yesterday = addDays(today, -1);
  let readings = 0;

  for (const [date, times] of [
    [yesterday, ["10:15", "14:20", "18:30"]],
    [today, ["10:05"]],
  ] as const) {
    for (const time of times) {
      await read(date, time, walkIn.id, time === "14:20" ? "39.5" : "37.0");
      await read(date, time, reachIn.id, "38.0");
      await read(date, time, freezer.id, "-4.0");
      await read(date, time, hotWell.id, "158.0");
      readings += 4;
    }
  }

  // Yesterday evening the walk-in ran warm: corrected, then rechecked.
  const warm = await read(yesterday, "21:00", walkIn.id, "45.5", {
    correctiveAction: "Door had been propped open during the delivery. Closed it, moved dairy to the reach-in for an hour.",
  });

  await read(yesterday, "22:00", walkIn.id, "40.0", { followsUpReadingId: warm.id });
  readings += 2;

  return `4 check points, ${readings} readings over two days (one out of range, rechecked)`;
}

async function seedEvents(database: Database, owner: Actor, today: string): Promise<string> {
  const [existing] = await database.select({ id: eventBookings.id }).from(eventBookings).where(eq(eventBookings.locationId, owner.locationId)).limit(1);

  if (existing) {
    return "events already there";
  }

  let saturday = addDays(today, 1);

  while (dayOfWeek(saturday) !== 6) {
    saturday = addDays(saturday, 1);
  }

  const tables = await database
    .select({ id: restaurantTables.id })
    .from(restaurantTables)
    .where(and(eq(restaurantTables.locationId, owner.locationId), inArray(restaurantTables.tableNumber, ["T12", "T13", "T14"])));
  const base = {
    setupMinutes: 30,
    teardownMinutes: 30,
    spaceScope: "TABLES" as const,
    tableIds: tables.map((table) => table.id),
  };
  let summary: string;

  try {
    await createEvent(database, owner, {
      ...base,
      name: "Rivera rehearsal dinner",
      guestName: "Ana Rivera",
      partySize: 18,
      phone: "(313) 555-0144",
      email: "ana.rivera@example.com",
      localDate: saturday,
      startTime: "18:00",
      endTime: "21:00",
      notes: "Long table across T12 to T14. Toasts around 7:30; keep the music low then.",
      menuNotes: "Family-style: garlic knots, Caesar, three large pizzas per table, cannoli.",
      minimumSpend: "900.00",
      depositAgreed: "200.00",
      depositReceived: "200.00",
      depositReceivedOn: today,
      depositMethod: "EXTERNAL_CARD",
      depositReference: "Square receipt 7781",
      status: "CONFIRMED",
    });
    summary = `a confirmed rehearsal dinner on ${saturday} in the back room`;
  } catch {
    summary = "the back room was already planned next Saturday, so no confirmed event";
  }

  await createEvent(database, owner, {
    ...base,
    name: "Office holiday party (inquiry)",
    guestName: "Lakeside Dental",
    partySize: 30,
    localDate: addDays(saturday, 14),
    startTime: "19:00",
    endTime: "22:00",
    notes: "Asked about a buyout; quoted the back room instead.",
    status: "INQUIRY",
  });

  return `${summary}, and an inquiry two weeks later`;
}

async function seedInvoices(database: Database, owner: Actor, today: string): Promise<string> {
  const [existing] = await database.select({ id: supplierInvoices.id }).from(supplierInvoices).where(eq(supplierInvoices.locationId, owner.locationId)).limit(1);

  if (existing) {
    return "supplier invoices already there";
  }

  const all = await database.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(eq(suppliers.organizationId, owner.organizationId));
  const made: string[] = [];

  for (const supplier of all) {
    if (made.length === 2) {
      break;
    }

    const lines = (await listInvoiceableReceiptLines(database, owner, { supplierId: supplier.id })).slice(0, 3);

    if (lines.length === 0) {
      continue;
    }

    // The first invoice prices one line a little above the receipt (inside tolerance); the
    // second charges for more cases than arrived and is disputed.
    const disputed = made.length === 1;
    const itemLines = lines.map((line, index) => ({
      kind: "ITEM" as const,
      receiptLineId: line.receiptLineId,
      quantity: disputed && index === 0 ? addDecimals(line.receivedQuantity, "1") : line.receivedQuantity,
      unitPrice: !disputed && index === 0 ? roundHalfUp(multiplyExact(line.receiptUnitCost, "1.01"), 4) : line.receiptUnitCost,
    }));
    const freight = "15.00";
    const statedTotal = sumDecimals([...itemLines.map((line) => itemLineAmount(line.quantity, line.unitPrice)), freight], 2);
    const invoice = await createInvoice(database, owner, {
      supplierId: supplier.id,
      supplierInvoiceNumber: `${disputed ? "D" : "A"}-${randomUUID().slice(0, 6).toUpperCase()}`,
      invoiceDate: today,
      dueDate: addDays(today, 30),
      statedTotal,
      notes: null,
      lines: [...itemLines, { kind: "FREIGHT", description: "Delivery", amount: freight }],
    });

    if (disputed) {
      await disputeInvoice(database, owner, invoice.id, { reason: "Billed one case more than arrived; credit requested.", expectedVersion: invoice.version });
      made.push(`${invoice.invoiceNumber} from ${supplier.name} disputed`);
    } else {
      await approveInvoice(database, owner, invoice.id, { expectedVersion: invoice.version });
      made.push(`${invoice.invoiceNumber} from ${supplier.name} approved with a 1% price variance`);
    }
  }

  return made.length > 0 ? made.join("; ") : "no received deliveries to invoice";
}

async function seedBundles(database: Database, owner: Actor, taxCategoryId: string | null): Promise<string> {
  const codes = ["PIZZA_NIGHT_FOR_TWO", "LUNCH_COMBO"];
  const [existing] = await database
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, owner.organizationId), inArray(menuItems.code, codes)))
    .limit(1);

  if (existing) {
    return "bundles already there";
  }

  const items = new Map(
    (await database.select({ id: menuItems.id, code: menuItems.code }).from(menuItems).where(eq(menuItems.organizationId, owner.organizationId))).map((row) => [row.code, row.id]),
  );
  const need = (code: string) => {
    const id = items.get(code);

    if (!id) {
      throw new Error(`The demo menu item ${code} is missing; run the pizza demo menu first.`);
    }

    return id;
  };
  const [mainMenu] = (await listMenus(database, owner)).filter((menu) => menu.code === "MAIN");
  const categories = new Map((await listCategories(database, owner)).map((category) => [category.code, category.id]));
  const make = async (code: string, name: string, description: string, price: string, category: string) => {
    const item = await createItem(database, owner, { code, name, shortName: null, description, itemType: "FOOD", displayOrder: 5, taxCategoryId });

    await changePrice(database, owner, item.id, { locationId: null, price, effectiveFrom: null });
    await createPlacement(database, owner, { menuId: mainMenu!.id, menuCategoryId: categories.get(category)!, menuItemId: item.id, displayOrder: 5 });

    return item;
  };
  const option = (code: string, upcharge = "0") => ({ componentMenuItemId: need(code), upcharge });
  const night = await make("PIZZA_NIGHT_FOR_TWO", "Pizza Night for Two", "A starter, two pizzas and a dessert to share.", "39.00", "PIZZA");

  await saveBundleConfiguration(database, owner, night.id, {
    expectedVersion: night.version,
    slots: [
      { name: "Starter", defaultCourse: 1, minimumChoices: 1, maximumChoices: 1, options: [option("GARLIC_KNOTS"), option("CHEESY_BREAD"), option("CAESAR_SALAD", "2.00")] },
      {
        name: "Pizzas",
        defaultCourse: 2,
        minimumChoices: 2,
        maximumChoices: 2,
        options: [option("CHEESE_PIZZA"), option("PEPPERONI_PIZZA"), option("MARGHERITA_PIZZA"), option("SUPREME_PIZZA", "3.00")],
      },
      { name: "Dessert", defaultCourse: 3, minimumChoices: 1, maximumChoices: 1, options: [option("CANNOLI"), option("TIRAMISU", "1.00")] },
    ],
  });

  const lunch = await make("LUNCH_COMBO", "Lunch Combo", "A sub with its side and a soft drink.", "14.00", "SANDWICHES");

  await saveBundleConfiguration(database, owner, lunch.id, {
    expectedVersion: lunch.version,
    slots: [
      { name: "Sub", defaultCourse: 1, minimumChoices: 1, maximumChoices: 1, options: [option("ITALIAN_SUB"), option("MEATBALL_SUB"), option("TURKEY_CLUB"), option("PHILLY_CHEESESTEAK", "2.00")] },
      { name: "Drink", defaultCourse: 1, minimumChoices: 1, maximumChoices: 1, options: [option("FOUNTAIN_SODA"), option("ICED_TEA"), option("LEMONADE")] },
    ],
  });

  return "Pizza Night for Two (39.00) and Lunch Combo (14.00)";
}

/** Runs each Phase 36 demo part and says what it added. */
export async function seedDemoPhase36(database: Database, owner: Actor): Promise<string[]> {
  const clock = await readLocationClock(database, owner.locationId, new Date());
  const [taxed] = await database
    .select({ taxCategoryId: menuItems.taxCategoryId })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, owner.organizationId), eq(menuItems.code, "CHEESE_PIZZA")));

  return [
    `Checklists: ${await seedChecklists(database, owner)}`,
    `Temperature log: ${await seedTemperatures(database, owner, clock.timeZone, clock.businessDate)}`,
    `Events: ${await seedEvents(database, owner, clock.businessDate)}`,
    `Supplier invoices: ${await seedInvoices(database, owner, clock.localDate)}`,
    `Bundles: ${await seedBundles(database, owner, taxed?.taxCategoryId ?? null)}`,
  ];
}
