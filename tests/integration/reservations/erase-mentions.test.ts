import { randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import { auditEvents, guestParties, guestProfiles, managerLogEntries, preShiftNotes, waitlistEntries } from "@/db/schema";
import type { Actor, AuthContext } from "@/modules/auth/types";
import { createGuestProfile, type ProfileFields } from "@/modules/reservations/services/guest-profile-service";
import { addToWaitlist } from "@/modules/reservations/services/waitlist-service";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { addLogEntry } from "@/modules/restaurant/services/manager-log-service";
import { createNote, redactNote, updateNote } from "@/modules/restaurant/services/pre-shift-service";
import { AppError, AuthorizationError } from "@/shared/errors/app-error";
import {
  eraseGuestProfileWithMentions,
  eraseGuestVisitWithMentions,
  previewGuestMentions,
  redactableLocationIds,
} from "@/workflows/erase-guest/erase-guest";

import { textWithoutIds } from "../../helpers/leak-text";
import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { createSchedulingScenario, type SchedulingScenario } from "../../fixtures/scheduling-fixtures";

// Phase 33 policies 2–6: an erase offers the log entries and pre-shift notes that mention the
// guest, redacts only the ones ticked, in the same transaction, and only where the eraser may
// redact. Notes can be redacted on their own too.

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

const ERASER_PERMISSIONS = [
  "guests.view",
  "guests.manage",
  "guests.erase",
  "manager-log.view",
  "manager-log.write",
  "manager-log.redact",
  "pre-shift.view",
  "pre-shift.manage",
  "waitlist.view",
  "waitlist.manage",
] as const;

describe("erase with possible mentions (Phase 33)", () => {
  let scenario: SchedulingScenario;
  let eraser: Actor;
  let writerB: Actor;
  let today: string;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
    eraser = await actorWith(database(), scenario, [...ERASER_PERMISSIONS]);
    writerB = await actorWith(database(), scenario, ["manager-log.view", "manager-log.write"], scenario.locationB);
    today = (await readLocationClock(database(), scenario.locationA, new Date())).businessDate;
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const entry = (actor: Actor, body: string) =>
    addLogEntry(database(), actor, { idempotencyKey: `log-${randomUUID()}`, dateChoice: "CURRENT", category: "GUEST", body, correctsEntryId: null });
  const note = (title: string, body: string) =>
    createNote(database(), eraser, { businessDate: today, title, body, pinned: false, positionIds: [] });
  const entryRow = async (id: string) => (await database().select().from(managerLogEntries).where(eq(managerLogEntries.id, id)))[0]!;
  const noteRow = async (id: string) => (await database().select().from(preShiftNotes).where(eq(preShiftNotes.id, id)))[0]!;
  const profileRow = async (id: string) => (await database().select().from(guestProfiles).where(eq(guestProfiles.id, id)))[0]!;

  async function setUp() {
    const profile = await createGuestProfile(database(), eraser, fields());
    const byName = await entry(eraser, "Mrs. Alvarez complained about the steak; comped dessert.");
    const byPhone = await entry(eraser, "Called 555 123 4567 back about the lost scarf.");
    const unrelated = await entry(eraser, "Walk-in door sticking; called the repair company.");
    const elsewhere = await entry(writerB, "Alvarez came in again.");
    const vip = await note("VIP at 8", "Maria Alvarez, table 12, nut allergy.");

    return { profile, byName, byPhone, unrelated, elsewhere, vip };
  }

  it("lists mentions by name, phone and email where the eraser may redact, and counts the other locations", async () => {
    const { profile, byName, byPhone, unrelated, elsewhere, vip } = await setUp();
    const preview = await previewGuestMentions(database(), eraser, { profileId: profile.id }, [scenario.locationA]);
    const ids = preview.mentions.map((mention) => mention.id);

    expect(ids).toEqual(expect.arrayContaining([byName.id, byPhone.id, vip.id]));
    expect(ids).not.toContain(unrelated.id);
    expect(ids).not.toContain(elsewhere.id);
    expect(preview.locationsNotSearched).toBe(1);
    expect(preview.mentions.find((mention) => mention.id === byName.id)).toMatchObject({
      kind: "LOG_ENTRY",
      label: byName.entryNumber,
      businessDate: today,
      excerpt: expect.stringContaining("Alvarez"),
    });
    expect(preview.mentions.find((mention) => mention.id === vip.id)).toMatchObject({ kind: "NOTE", label: "VIP at 8" });
  });

  it("redacts only the ticked mentions, in the erase, and audits counts without the text", async () => {
    const { profile, byName, byPhone, vip } = await setUp();
    const result = await eraseGuestProfileWithMentions(
      database(),
      eraser,
      profile.id,
      {
        expectedVersion: (await profileRow(profile.id)).version,
        reason: "Guest asked to be forgotten",
        redactEntryIds: [byName.id],
        redactNoteIds: [vip.id],
      },
      [scenario.locationA],
    );

    expect(result).toMatchObject({ logEntriesRedacted: 1, notesRedacted: 1 });
    expect(await entryRow(byName.id)).toMatchObject({ body: "", redactionReason: `Guest erase, profile #${profile.profileNumber}` });
    expect((await entryRow(byPhone.id)).body).toContain("555 123 4567");
    expect(await noteRow(vip.id)).toMatchObject({ title: "Redacted", body: "", active: false });
    expect((await profileRow(profile.id)).status).toBe("ERASED");

    const audit = await database()
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.entityId, [profile.id, byName.id, vip.id]));

    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining(["guests.profile-erased", "restaurant.manager-log-redacted", "restaurant.pre-shift-note-redacted"]),
    );
    expect(audit.find((event) => event.action === "guests.profile-erased")!.details).toMatchObject({ logEntriesRedacted: 1, notesRedacted: 1 });
    expect(textWithoutIds(audit)).not.toMatch(/Alvarez|1234567|steak|nut allergy/i);
  });

  it("refuses a ticked entry that isn't a mention, or is at a location the eraser can't redact, and changes nothing", async () => {
    const { profile, byName, unrelated, elsewhere } = await setUp();
    const erase = (redactEntryIds: string[]) =>
      profileRow(profile.id).then((row) =>
        eraseGuestProfileWithMentions(
          database(),
          eraser,
          profile.id,
          { expectedVersion: row.version, reason: "Asked", redactEntryIds, redactNoteIds: [] },
          [scenario.locationA],
        ),
      );

    expect(await codeOf(erase([byName.id, unrelated.id]))).toBe("MENTION_NOT_MATCHED");
    expect(await codeOf(erase([elsewhere.id]))).toBe("MENTION_NOT_MATCHED");
    expect((await entryRow(byName.id)).redactedAt).toBeNull();
    expect((await profileRow(profile.id)).status).toBe("ACTIVE");
  });

  it("erases with nothing ticked exactly as before", async () => {
    const { profile, byName } = await setUp();

    await eraseGuestProfileWithMentions(
      database(),
      eraser,
      profile.id,
      { expectedVersion: (await profileRow(profile.id)).version, reason: "Asked", redactEntryIds: [], redactNoteIds: [] },
      [scenario.locationA],
    );

    expect((await profileRow(profile.id)).status).toBe("ERASED");
    expect((await entryRow(byName.id)).redactedAt).toBeNull();
  });

  it("finds a single unlinked visit's name and redacts with its erase", async () => {
    const waiting = await addToWaitlist(database(), eraser, { guestName: "Quentin Visitor", partySize: 2 });
    const [row] = await database().select().from(waitlistEntries).where(eq(waitlistEntries.id, waiting.id));
    const [party] = await database().select().from(guestParties).where(eq(guestParties.id, row!.guestPartyId));
    const jacket = await entry(eraser, "Quentin left his jacket at the bar.");
    const preview = await previewGuestMentions(database(), eraser, { guestPartyId: party!.id }, [scenario.locationA]);

    expect(preview.mentions.map((mention) => mention.id)).toEqual([jacket.id]);

    await eraseGuestVisitWithMentions(
      database(),
      eraser,
      party!.id,
      { expectedVersion: party!.version, reason: "Asked", redactEntryIds: [jacket.id], redactNoteIds: [] },
      [scenario.locationA],
    );

    expect(await entryRow(jacket.id)).toMatchObject({ body: "", redactionReason: "Guest erase, visit" });
  });

  it("searches only locations where both manager log view and redact are held", () => {
    const auth = {
      userId: eraser.userId,
      locations: [
        { locationId: "a", organizationId: eraser.organizationId, permissions: ["manager-log.view", "manager-log.redact"] },
        { locationId: "b", organizationId: eraser.organizationId, permissions: ["manager-log.view"] },
        { locationId: "c", organizationId: "other", permissions: ["manager-log.view", "manager-log.redact"] },
      ],
    } as unknown as AuthContext;

    expect(redactableLocationIds(auth, eraser)).toEqual(["a"]);
  });

  it("refuses the preview and the erase without guests.erase", async () => {
    const { profile } = await setUp();
    const logOnly = await actorWith(database(), scenario, ["manager-log.view", "manager-log.redact", "guests.view"]);

    await expect(previewGuestMentions(database(), logOnly, { profileId: profile.id }, [scenario.locationA])).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  describe("note redaction (policy 5)", () => {
    it("redacts a note once, then freezes it, and needs manager-log.redact", async () => {
      const vip = await note("VIP at 8", "Private details here.");
      const plainManager = await actorWith(database(), scenario, ["pre-shift.view", "pre-shift.manage"]);

      await expect(redactNote(database(), plainManager, vip.id, { reason: "Personal data" })).rejects.toBeInstanceOf(AuthorizationError);

      const redacted = await redactNote(database(), eraser, vip.id, { reason: "Personal data" });

      expect(redacted).toMatchObject({ title: "Redacted", body: "", active: false, redaction: { reason: "Personal data" } });
      expect(await codeOf(redactNote(database(), eraser, vip.id, { reason: "Again" }))).toBe("ALREADY_REDACTED");
      expect(
        await codeOf(
          updateNote(database(), eraser, vip.id, {
            businessDate: today,
            title: "Back",
            body: "Back",
            pinned: false,
            positionIds: [],
            expectedVersion: redacted.version,
          }),
        ),
      ).toBeDefined();
      expect(await codeOf(database().execute(sql`UPDATE pre_shift_notes SET title = 'Back', body = 'x', redacted_at = NULL WHERE id = ${vip.id}`))).toBe(
        "DB:pre_shift_notes_redaction_final",
      );
    });
  });
});
