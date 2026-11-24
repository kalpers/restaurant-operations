import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { checklistRunItems, eventBookings, freeTextRedactions, supplierInvoices, suppliers, temperatureReadings } from "@/db/schema";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";
import { changeEventStatus, createEvent } from "@/modules/reservations/services/event-service";
import { createGuestProfile } from "@/modules/reservations/services/guest-profile-service";
import {
  completeChecklistRun,
  createChecklistTemplate,
  setChecklistItem,
  startChecklistRun,
} from "@/modules/restaurant/services/checklist-service";
import { createTemperaturePoint, recordTemperatureReading } from "@/modules/restaurant/services/temperature-service";
import {
  eraseGuestProfileWithMentions,
  eraseSearchScope,
  previewGuestMentions,
  type GuestMention,
} from "@/workflows/erase-guest/erase-guest";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { createSchedulingScenario } from "../../fixtures/scheduling-fixtures";

// Phase 36 policy 3: every new staff-typed free-text field joins the guest erase search, under
// its kind's view permission, with word-level redaction recorded in `free_text_redactions`.

const database = () => getDatabase();

const profileFields = {
  displayName: "Maria Alvarez",
  phone: "(555) 123-4567",
  email: "maria.a@example.com",
  vip: false,
  vipReason: null,
  preferences: null,
  notes: null,
  otherDietaryNeeds: null,
};

const chooseAll = (mentions: GuestMention[]) => ({
  redactEntryIds: [],
  redactNoteIds: [],
  redactMentions: mentions
    .filter((mention) => mention.kind !== "LOG_ENTRY" && mention.kind !== "NOTE")
    .map((mention) => ({ kind: mention.kind as Exclude<GuestMention["kind"], "LOG_ENTRY" | "NOTE">, id: mention.id })),
});

describe("erase searches Phase 36 free text", () => {
  let scenario: Awaited<ReturnType<typeof createSchedulingScenario>>;
  let eraser: Actor;

  beforeEach(async () => {
    await clearEmployeeData(database());
    scenario = await createSchedulingScenario(database());
    eraser = await actorWith(database(), scenario, [
      "guests.view",
      "guests.manage",
      "guests.erase",
      "checklists.view",
      "checklists.complete",
      "checklists.manage",
      "food-safety.view",
      "food-safety.record",
      "food-safety.manage",
      "events.view",
      "events.manage",
      "purchasing.view",
    ]);
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  it("redacts the guest's words in a completed checklist's notes and skip reasons", async () => {
    const profile = await createGuestProfile(database(), eraser, profileFields);
    const template = await createChecklistTemplate(database(), eraser, {
      name: "Closing",
      kind: "CLOSING",
      requiresSignOff: false,
      positionIds: [],
      items: [
        { text: "Lost and found", required: true },
        { text: "Call back", required: false },
        { text: "Wipe menus", required: true },
      ],
    });
    const run = await startChecklistRun(database(), eraser, { templateId: template.id });
    const [lost, call, wipe] = run.items;

    await setChecklistItem(database(), eraser, lost!.id, { state: "DONE", note: "Scarf left by Alvarez, table 12", expectedVersion: 1 });
    await setChecklistItem(database(), eraser, call!.id, { state: "SKIPPED", skipReason: "Couldn't reach 555-123-4567", expectedVersion: 1 });
    await setChecklistItem(database(), eraser, wipe!.id, { state: "DONE", note: "All wiped", expectedVersion: 1 });
    await completeChecklistRun(database(), eraser, run.id, { expectedVersion: run.version });

    const auth = (await getUserAuthContext(database(), eraser.userId))!;
    const scope = eraseSearchScope(auth, eraser);
    const preview = await previewGuestMentions(database(), eraser, { profileId: profile.id }, scope);
    const checklist = preview.mentions.filter((mention) => mention.kind === "CHECKLIST_NOTE");

    expect(checklist.map((mention) => mention.id).sort()).toEqual([lost!.id, call!.id].sort());
    expect(checklist[0]!.label).toBe("Checklist note (Closing)");

    const erased = await eraseGuestProfileWithMentions(
      database(),
      eraser,
      profile.id,
      { expectedVersion: profile.version, reason: "Guest asked", ...chooseAll(preview.mentions) },
      scope,
    );

    expect(erased).toMatchObject({ textRedacted: 2 });

    const rows = new Map((await database().select().from(checklistRunItems)).map((row) => [row.id, row]));

    expect(rows.get(lost!.id)).toMatchObject({ note: "Scarf left by [redacted], table 12", state: "DONE" });
    expect(rows.get(call!.id)).toMatchObject({ skipReason: "Couldn't reach [redacted]", state: "SKIPPED" });
    expect(rows.get(wipe!.id)!.note).toBe("All wiped");

    const records = await database().select().from(freeTextRedactions).where(eq(freeTextRedactions.tableName, "checklist_run_items"));

    expect(records.map((record) => record.columnName).sort()).toEqual(["note", "skip_reason"]);
  });

  it("redacts the guest's words in a temperature reading's corrective action, which is otherwise append-only", async () => {
    const profile = await createGuestProfile(database(), eraser, profileFields);
    const point = await createTemperaturePoint(database(), eraser, {
      name: "Hot well",
      kind: "HOT_HOLDING",
      minimumValue: "135",
      maximumValue: null,
      checkIntervalMinutes: null,
      sortOrder: 0,
    });
    const reading = await recordTemperatureReading(database(), eraser, {
      idempotencyKey: `erase-${Date.now()}`,
      pointId: point.id,
      value: "120",
      correctiveAction: "Reheated soup after Maria Alvarez complained",
    });
    const auth = (await getUserAuthContext(database(), eraser.userId))!;
    const scope = eraseSearchScope(auth, eraser);
    const preview = await previewGuestMentions(database(), eraser, { profileId: profile.id }, scope);
    const found = preview.mentions.filter((mention) => mention.kind === "TEMPERATURE_ACTION");

    expect(found.map((mention) => mention.id)).toEqual([reading.id]);
    expect(found[0]!.label).toBe("Temperature corrective action (Hot well)");

    await eraseGuestProfileWithMentions(
      database(),
      eraser,
      profile.id,
      { expectedVersion: profile.version, reason: "Guest asked", ...chooseAll(preview.mentions) },
      scope,
    );

    const [after] = await database().select().from(temperatureReadings).where(eq(temperatureReadings.id, reading.id));

    expect(after).toMatchObject({ correctiveAction: "Reheated soup after [redacted] complained", value: "120.0", inRange: false });
  });

  it("clears the guest's own event outright and redacts their words in another event, even a cancelled one", async () => {
    const profile = await createGuestProfile(database(), eraser, profileFields);
    const base = {
      partySize: 20,
      localDate: "2026-12-31",
      startTime: "18:00",
      endTime: "22:00",
      setupMinutes: 0,
      teardownMinutes: 0,
      spaceScope: "LOCATION" as const,
    };
    const own = await createEvent(database(), eraser, {
      ...base,
      name: "Alvarez anniversary",
      guestName: "Maria Alvarez",
      guestProfileId: profile.id,
      notes: "Maria Alvarez wants the window",
      menuNotes: "No shellfish",
    });
    const other = await createEvent(database(), eraser, {
      ...base,
      localDate: "2027-01-02",
      name: "Stone retirement",
      guestName: "Bob Stone",
      notes: "Friend of Alvarez is giving a toast",
    });
    const cancelled = await changeEventStatus(database(), eraser, other.id, { status: "CANCELLED", reason: "Moved; Alvarez asked for March", expectedVersion: other.version });
    const auth = (await getUserAuthContext(database(), eraser.userId))!;
    const scope = eraseSearchScope(auth, eraser);
    const preview = await previewGuestMentions(database(), eraser, { profileId: profile.id }, scope);
    const found = preview.mentions.filter((mention) => mention.kind === "EVENT_TEXT");

    // The guest's own event is cleared, so it isn't offered.
    expect(found.map((mention) => mention.id)).toEqual([other.id]);

    await eraseGuestProfileWithMentions(
      database(),
      eraser,
      profile.id,
      { expectedVersion: profile.version, reason: "Guest asked", ...chooseAll(preview.mentions) },
      scope,
    );

    const rows = new Map((await database().select().from(eventBookings)).map((row) => [row.id, row]));

    expect(rows.get(own.id)).toMatchObject({ name: `Event ${own.eventNumber}`, notes: null, menuNotes: null });
    expect(rows.get(other.id)).toMatchObject({
      name: "Stone retirement",
      notes: "Friend of [redacted] is giving a toast",
      cancelReason: "Moved; [redacted] asked for March",
      status: "CANCELLED",
    });
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("redacts the guest's words in an approved supplier invoice's notes", async () => {
    const profile = await createGuestProfile(database(), eraser, profileFields);
    const [supplier] = await database()
      .insert(suppliers)
      .values({ organizationId: scenario.organizationId, code: `ERASE_${Date.now()}`, name: "Erase Foods" })
      .returning({ id: suppliers.id });
    const [invoice] = await database()
      .insert(supplierInvoices)
      .values({
        organizationId: scenario.organizationId,
        locationId: scenario.locationA,
        supplierId: supplier!.id,
        sequenceNumber: 1,
        invoiceNumber: "INV-000001",
        supplierInvoiceNumber: "E-1",
        invoiceDate: "2026-11-20",
        statedTotal: "10.00",
        notes: "Catering order for Maria Alvarez's party",
        status: "APPROVED",
        approvedAt: new Date(),
        approvedByUserId: eraser.userId,
        createdByUserId: eraser.userId,
        updatedByUserId: eraser.userId,
      })
      .returning({ id: supplierInvoices.id });
    const auth = (await getUserAuthContext(database(), eraser.userId))!;
    const scope = eraseSearchScope(auth, eraser);
    const preview = await previewGuestMentions(database(), eraser, { profileId: profile.id }, scope);

    expect(preview.mentions.filter((mention) => mention.kind === "INVOICE_NOTE").map((mention) => mention.id)).toEqual([invoice!.id]);

    await eraseGuestProfileWithMentions(
      database(),
      eraser,
      profile.id,
      { expectedVersion: profile.version, reason: "Guest asked", ...chooseAll(preview.mentions) },
      scope,
    );

    const [after] = await database().select().from(supplierInvoices).where(eq(supplierInvoices.id, invoice!.id));

    expect(after).toMatchObject({ notes: "Catering order for [redacted]'s party", status: "APPROVED", statedTotal: "10.00" });
  });

  it("doesn't search checklist notes without checklists.view", async () => {
    const narrow = await actorWith(database(), scenario, ["guests.view", "guests.erase"]);
    const profile = await createGuestProfile(database(), eraser, profileFields);
    const auth = (await getUserAuthContext(database(), narrow.userId))!;
    const preview = await previewGuestMentions(database(), narrow, { profileId: profile.id }, eraseSearchScope(auth, narrow));

    expect(preview.notSearched.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["CHECKLIST_NOTE", "TEMPERATURE_ACTION", "EVENT_TEXT", "INVOICE_NOTE"]));
  });
});
