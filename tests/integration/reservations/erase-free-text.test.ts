import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import {
  auditEvents,
  freeTextRedactions,
  giftCardPurchasers,
  kitchenTicketItems,
  orderItems,
  orders,
  schedulePeriods,
  shifts,
  waitlistEntries,
} from "@/db/schema";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";
import { createStation, setItemRouting } from "@/modules/menu/services/prep-station-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { createGuestProfile, type ProfileFields } from "@/modules/reservations/services/guest-profile-service";
import { addToWaitlist } from "@/modules/reservations/services/waitlist-service";
import { publishPeriod } from "@/modules/scheduling/services/schedule-service";
import { getGiftCardProgram, sellGiftCard, updateGiftCardProgram } from "@/modules/settlements/services/gift-card-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import {
  eraseGuestProfileWithMentions,
  eraseSearchScope,
  previewGuestMentions,
  type GuestMention,
} from "@/workflows/erase-guest/erase-guest";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { textWithoutIds } from "../../helpers/leak-text";
import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { uniqueCode } from "../../fixtures/menu-fixtures";
import { clearOrderData, newKey, plainItem } from "../../fixtures/order-fixtures";
import { createDraftPeriod, createSchedulingScenario, createShiftFixture } from "../../fixtures/scheduling-fixtures";
import {
  createSettlementScenario,
  MANAGER_SETTLEMENT_PERMISSIONS,
  settlementRow,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";

// Phase 34 policies 11–14: an erase also finds the guest in visit notes, takeout names, order
// item instructions (and their kitchen copies), schedule notes and gift card purchasers;
// redacts only the guest's words in the ticked ones, even where snapshots are frozen; and
// clears the guest's own visit notes outright.

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    return `DB:${readConstraintName(error) ?? (error as Error).message}`;
  }

  return undefined;
}

const fields = (overrides: Partial<ProfileFields> = {}): ProfileFields => ({
  displayName: "Maria Alvarez",
  phone: "(555) 123-4567",
  email: "maria.a@example.com",
  vip: false,
  vipReason: null,
  preferences: null,
  notes: null,
  otherDietaryNeeds: null,
  ...overrides,
});

const ERASER = [
  "guests.view",
  "guests.manage",
  "guests.erase",
  "reservations.view",
  "waitlist.view",
  "waitlist.manage",
  "restaurant.view",
  "orders.view",
  "schedule.view",
  "schedule.edit",
  "schedule.publish",
] as const;

const chooseAll = (mentions: GuestMention[]) => ({
  redactEntryIds: [],
  redactNoteIds: [],
  redactMentions: mentions
    .filter((mention) => mention.kind !== "LOG_ENTRY" && mention.kind !== "NOTE")
    .map((mention) => ({ kind: mention.kind as Exclude<GuestMention["kind"], "LOG_ENTRY" | "NOTE">, id: mention.id })),
});

describe("erase searches visits and schedules (Phase 34)", () => {
  let scenario: Awaited<ReturnType<typeof createSchedulingScenario>>;
  let eraser: Actor;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
    eraser = await actorWith(database(), scenario, [...ERASER]);
  });

  afterAll(async () => {
    await clearEmployeeData(database());
  });

  it("redacts the guest's words in other visits and a published shift's notes, and clears the guest's own notes", async () => {
    const profile = await createGuestProfile(database(), eraser, fields());
    const own = await addToWaitlist(database(), eraser, {
      guestName: "Maria Alvarez",
      partySize: 2,
      notes: "Prefers the booth",
      guestProfileId: profile.id,
    });
    const other = await addToWaitlist(database(), eraser, {
      guestName: "Bob Stone",
      partySize: 4,
      notes: "Friend of Alvarez, seat them together",
      specialRequests: "Text 555-123-4567 when ready",
    });
    const unrelated = await addToWaitlist(database(), eraser, { guestName: "Cy Field", partySize: 2, notes: "High chair" });
    const period = await createDraftPeriod(database(), scenario.owner, { name: "Erase week" });
    const shift = await createShiftFixture(database(), scenario.owner, period, scenario, {
      notes: "Alvarez anniversary dinner, extra server",
      courseOrStationNote: "Station 4",
    });
    const [periodBefore] = await database().select().from(schedulePeriods).where(eq(schedulePeriods.id, period.id));

    await publishPeriod(database(), scenario.owner, period.id, { expectedVersion: periodBefore!.version });

    const [published] = await database().select().from(schedulePeriods).where(eq(schedulePeriods.id, period.id));
    const auth = (await getUserAuthContext(database(), eraser.userId))!;
    const scope = eraseSearchScope(auth, eraser);
    const preview = await previewGuestMentions(database(), eraser, { profileId: profile.id }, scope);
    const kinds = preview.mentions.map((mention) => mention.kind);
    const otherRow = (await database().select().from(waitlistEntries).where(eq(waitlistEntries.id, other.id)))[0]!;

    expect(kinds).toEqual(expect.arrayContaining(["WAITLIST_NOTE", "PARTY_REQUEST", "SHIFT_NOTE"]));
    expect(preview.mentions.map((mention) => mention.id)).not.toContain(unrelated.id);
    // The guest's own visit is cleared outright, so it isn't offered.
    expect(preview.mentions.map((mention) => mention.id)).not.toContain(own.id);
    expect(preview.mentions.find((mention) => mention.kind === "PARTY_REQUEST")!.id).toBe(otherRow.guestPartyId);

    const erased = await eraseGuestProfileWithMentions(
      database(),
      eraser,
      profile.id,
      { expectedVersion: profile.version, reason: "Guest asked", ...chooseAll(preview.mentions) },
      scope,
    );

    expect(erased).toMatchObject({ textRedacted: 3, ownNotesCleared: 1 });

    const [otherAfter] = await database().select().from(waitlistEntries).where(eq(waitlistEntries.id, other.id));
    const [ownAfter] = await database().select().from(waitlistEntries).where(eq(waitlistEntries.id, own.id));
    const [shiftAfter] = await database().select().from(shifts).where(eq(shifts.id, shift.id));
    const [periodAfter] = await database().select().from(schedulePeriods).where(eq(schedulePeriods.id, period.id));
    const party = await database().execute<{ special_requests: string }>(
      sql`SELECT special_requests FROM guest_parties WHERE id = ${otherRow.guestPartyId}`,
    );

    expect(otherAfter!.notes).toBe("Friend of [redacted], seat them together");
    expect([...party][0]!.special_requests).toBe("Text [redacted] when ready");
    expect(ownAfter!.notes).toBeNull();
    expect(shiftAfter).toMatchObject({ notes: "[redacted] anniversary dinner, extra server", courseOrStationNote: "Station 4" });
    expect(periodAfter!.version).toBe(published!.version);

    const records = await database().select().from(freeTextRedactions).where(eq(freeTextRedactions.rowId, shift.id));

    expect(records).toEqual([expect.objectContaining({ tableName: "shifts", columnName: "notes", reason: expect.stringMatching(/^Guest erase/) })]);

    const audit = await database().select().from(auditEvents).where(eq(auditEvents.entityId, profile.id));

    expect(textWithoutIds(audit)).not.toMatch(/Alvarez|555|anniversary|Friend of/i);
  });

  it("doesn't search kinds the eraser can't see, and refuses a crafted choice", async () => {
    const profile = await createGuestProfile(database(), eraser, fields());
    const narrow = await actorWith(database(), scenario, ["guests.view", "guests.erase", "waitlist.view"]);
    const other = await addToWaitlist(database(), eraser, { guestName: "Dee Lane", partySize: 2, notes: "Alvarez's cousin" });
    const unrelated = await addToWaitlist(database(), eraser, { guestName: "Eve Moss", partySize: 2, notes: "Window seat" });
    const auth = (await getUserAuthContext(database(), narrow.userId))!;
    const preview = await previewGuestMentions(database(), narrow, { profileId: profile.id }, eraseSearchScope(auth, narrow));

    expect(preview.mentions.map((mention) => mention.id)).toContain(other.id);
    expect(preview.notSearched.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["SHIFT_NOTE", "ORDER_ITEM_INSTRUCTION", "SESSION_NOTE", "GIFT_CARD_PURCHASER"]),
    );
    expect(await codeOf(eraseGuestProfileWithMentions(
      database(),
      narrow,
      profile.id,
      { expectedVersion: profile.version, reason: "Asked", redactEntryIds: [], redactNoteIds: [], redactMentions: [{ kind: "WAITLIST_NOTE", id: unrelated.id }] },
      eraseSearchScope(auth, narrow),
    ))).toBe("MENTION_NOT_MATCHED");

    const [still] = await database().select().from(waitlistEntries).where(eq(waitlistEntries.id, other.id));

    expect(still!.notes).toBe("Alvarez's cousin");
  });
});

describe("erase searches orders, kitchen tickets and gift card purchasers (Phase 34)", () => {
  let scenario: SettlementScenario;
  let eraser: Actor;

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());
    eraser = await actorWith(database(), scenario, [
      ...ERASER,
      ...MANAGER_SETTLEMENT_PERMISSIONS,
      "gift-cards.view",
      "gift-cards.sell",
      "gift-cards.manage",
      "gift-cards.purchaser.view",
    ]);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function closedTakeout() {
    const item = await plainItem(database(), scenario.owner, "12.00", "Fish tacos");
    const station = await createStation(database(), scenario.owner, { code: uniqueCode("GRL"), name: "Grill", stationType: "KITCHEN", sortOrder: 0 });

    await setItemRouting(database(), scenario.owner, item.id, { prepStationIds: [station.id] });

    const order = await createOrder(database(), scenario.cashier, { orderType: "TAKEOUT", customerName: "M. Alvarez" });
    const added = await addDraftItem(database(), scenario.cashier, order.id, {
      expectedVersion: order.version,
      menuItemId: item.id,
      quantity: 1,
      selections: [],
      specialInstructions: "No onion - Alvarez allergy",
    });
    const sent = await sendOrderItems(database(), scenario.cashier, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() });
    const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);
    const [row] = await database().select().from(orders).where(eq(orders.id, order.id));

    await tender(database(), scenario.cashier, settlementId, { tenderType: "EXTERNAL_CARD", amount: row!.totalDue });
    await completeSettlement(database(), scenario.cashier, settlementId, {
      expectedVersion: (await settlementRow(database(), settlementId)).version,
      idempotencyKey: newKey(),
    });

    const [itemRow] = await database().select().from(orderItems).where(eq(orderItems.orderId, order.id));

    return { orderId: order.id, itemId: itemRow!.id, sentVersion: sent.orderVersion };
  }

  it("redacts a closed check's name and a sent item's instructions word by word, with the kitchen copy, and clears a purchaser", async () => {
    const profile = await createGuestProfile(database(), eraser, fields());
    const { orderId, itemId } = await closedTakeout();
    const program = await getGiftCardProgram(database(), eraser);

    await updateGiftCardProgram(database(), eraser, { enabled: true, maxBalance: "500.00", expectedVersion: program.version });

    const card = await sellGiftCard(database(), eraser, {
      idempotencyKey: newKey(),
      amount: "20.00",
      tenderType: "EXTERNAL_CARD",
      purchaser: { name: "Someone Else", email: "maria.a@example.com" },
    });
    const [before] = await database().select().from(orderItems).where(eq(orderItems.id, itemId));
    const auth = (await getUserAuthContext(database(), eraser.userId))!;
    const scope = eraseSearchScope(auth, eraser);
    const preview = await previewGuestMentions(database(), eraser, { profileId: profile.id }, scope);

    expect(preview.mentions.map((mention) => `${mention.kind}:${mention.id}`)).toEqual(
      expect.arrayContaining([`TAKEOUT_NAME:${orderId}`, `ORDER_ITEM_INSTRUCTION:${itemId}`, `GIFT_CARD_PURCHASER:${card.card.id}`]),
    );

    // Outside the erase, the frozen text still can't change, even to look like a redaction.
    expect(await codeOf(database().execute(sql`UPDATE order_items SET special_instructions = 'No onion - [redacted] allergy' WHERE id = ${itemId}`))).toBe(
      "DB:order_items_frozen",
    );
    expect(await codeOf(database().execute(sql`UPDATE orders SET customer_name = '[redacted]' WHERE id = ${orderId}`))).toBe("DB:orders_closed_frozen");

    await eraseGuestProfileWithMentions(
      database(),
      eraser,
      profile.id,
      { expectedVersion: profile.version, reason: "Guest asked", ...chooseAll(preview.mentions) },
      scope,
    );

    const [after] = await database().select().from(orderItems).where(eq(orderItems.id, itemId));
    const [order] = await database().select().from(orders).where(eq(orders.id, orderId));
    const tickets = await database().select().from(kitchenTicketItems).where(eq(kitchenTicketItems.orderItemId, itemId));
    const [purchaser] = await database().select().from(giftCardPurchasers).where(eq(giftCardPurchasers.giftCardId, card.card.id));

    expect(after!.specialInstructions).toBe("No onion - [redacted] allergy");
    expect(after).toMatchObject({
      unitPriceSnapshot: before!.unitPriceSnapshot,
      lineTotalSnapshot: before!.lineTotalSnapshot,
      recipeVersionId: before!.recipeVersionId,
      status: before!.status,
    });
    expect(order!).toMatchObject({ customerName: "M. [redacted]", status: "CLOSED" });
    expect(tickets.length).toBeGreaterThan(0);

    for (const ticket of tickets) {
      expect(ticket.kitchenInstructionsSnapshot ?? "").not.toMatch(/Alvarez/);
    }

    expect(purchaser).toMatchObject({ name: null, email: null });
    expect(purchaser!.clearedAt).not.toBeNull();

    const records = await database().select().from(freeTextRedactions).where(eq(freeTextRedactions.rowId, itemId));

    expect(records.map((record) => record.columnName)).toContain("special_instructions");
    expect(textWithoutIds(records)).not.toMatch(/Alvarez|onion/i);
  });
});
