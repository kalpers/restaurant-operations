import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, guestParties, guestPartyAllergies, guestProfileMerges, guestProfiles, waitlistEntries } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { getGuestVisits } from "@/modules/reservations/queries/guest-visits";
import {
  createGuestProfile,
  eraseGuestProfile,
  getGuestProfile,
  linkPartyToProfile,
  mergeGuestProfiles,
  searchGuestProfiles,
  setGuestProfileAllergies,
  unlinkPartyProfile,
  updateGuestProfile,
  type ProfileFields,
} from "@/modules/reservations/services/guest-profile-service";
import { loadPartyGuestFacts, recordPartyAllergy } from "@/modules/reservations/services/party-allergy-service";
import { addToWaitlist } from "@/modules/reservations/services/waitlist-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { allergenList, type AllergenList } from "../../fixtures/allergen-fixtures";
import { actorWith, clearRestaurantData } from "../../fixtures/employee-fixtures";
import { clearOrderData, createOrderScenario, type OrderScenario } from "../../fixtures/order-fixtures";

// Phase 21 policies 1-5, 7, 8, 19, 20: guest profiles, linking, visit allergies, merge, erase,
// the contact tier and the audit trail.

const database = () => getDatabase();

const fields = (overrides: Partial<ProfileFields> = {}): ProfileFields => ({
  displayName: "Ana Guest",
  phone: "(555) 010-0199",
  email: "Ana@Example.com",
  vip: false,
  vipReason: null,
  preferences: "Window seat",
  notes: null,
  otherDietaryNeeds: null,
  ...overrides,
});

describe("guest profiles (Phase 21)", () => {
  let scenario: OrderScenario;
  let list: AllergenList;
  let host: Actor;
  let server: Actor;

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    list = await allergenList(database(), scenario.owner);
    host = await actorWith(database(), scenario, [
      "waitlist.view",
      "waitlist.manage",
      "guests.view",
      "guests.contact.view",
      "guests.manage",
    ]);
    server = await actorWith(database(), scenario, ["orders.view", "orders.edit", "guests.view"]);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function walkIn(guestProfileId: string | null = null) {
    const entry = await addToWaitlist(database(), host, { guestName: "Ana Guest", partySize: 2, guestProfileId });
    const [row] = await database().select().from(waitlistEntries).where(eq(waitlistEntries.id, entry.id));
    const [party] = await database().select().from(guestParties).where(eq(guestParties.id, row!.guestPartyId));

    return party!;
  }

  it("numbers profiles, normalizes contact details and hides them without the contact permission", async () => {
    const first = await createGuestProfile(database(), host, fields());
    const second = await createGuestProfile(database(), host, fields({ displayName: "Ben Guest", phone: null, email: null }));

    expect(second.profileNumber).toBe(first.profileNumber + 1);

    const [row] = await database().select().from(guestProfiles).where(eq(guestProfiles.id, first.id));

    expect(row).toMatchObject({ phoneNormalized: "5550100199", emailNormalized: "ana@example.com" });
    expect(await searchGuestProfiles(database(), host, "0100199")).toEqual([
      expect.objectContaining({ id: first.id, phone: "(555) 010-0199", email: "Ana@Example.com" }),
    ]);

    // A server can find a guest by name but sees no contact details and can't search by phone.
    const byName = await searchGuestProfiles(database(), server, "ana");

    expect(byName.map((entry) => entry.id)).toEqual([first.id]);
    expect(byName[0]).not.toHaveProperty("phone");
    expect(await searchGuestProfiles(database(), server, "0100199")).toEqual([]);
    expect(await getGuestProfile(database(), server, first.id)).not.toHaveProperty("email");
  });

  it("refuses card-like text, a stale version and a user without guests.manage", async () => {
    await expect(createGuestProfile(database(), host, fields({ notes: "card 4111111111111111" }))).rejects.toMatchObject({
      code: "LOOKS_LIKE_CARD_NUMBER",
    });

    const profile = await createGuestProfile(database(), host, fields());

    await updateGuestProfile(database(), host, { ...fields({ vip: true, vipReason: "Regular" }), profileId: profile.id, expectedVersion: 1 });
    await expect(
      updateGuestProfile(database(), host, { ...fields(), profileId: profile.id, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(createGuestProfile(database(), server, fields())).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("copies profile allergies onto a linked visit, follows profile edits and drops them on unlink", async () => {
    const profile = await createGuestProfile(database(), host, {
      ...fields(),
      allergies: [{ allergenId: list.PEANUTS.id, severity: "SEVERE", note: "Carries an EpiPen" }],
    });
    const party = await walkIn();
    const facts = async () => (await loadPartyGuestFacts(database(), [party.id])).get(party.id)!;
    const linked = await linkPartyToProfile(database(), host, {
      guestPartyId: party.id,
      guestProfileId: profile.id,
      expectedPartyVersion: party.version,
    });

    expect((await facts()).allergies.map((entry) => `${entry.code}:${entry.source}`)).toEqual(["PEANUTS:PROFILE"]);

    // A server adds one for tonight only.
    await recordPartyAllergy(database(), server, {
      guestPartyId: party.id,
      expectedPartyVersion: linked.version,
      allergenId: list.SESAME.id,
      severity: "ALLERGY",
      note: null,
      saveToProfile: false,
    });

    await setGuestProfileAllergies(database(), host, {
      profileId: profile.id,
      expectedVersion: 1,
      allergies: [
        { allergenId: list.PEANUTS.id, severity: "SEVERE", note: null },
        { allergenId: list.MILK.id, severity: "ALLERGY", note: null },
      ],
    });
    expect((await facts()).allergies.map((entry) => `${entry.code}:${entry.source}`).sort()).toEqual([
      "MILK:PROFILE",
      "PEANUTS:PROFILE",
      "SESAME:RECORDED",
    ]);

    const [current] = await database().select().from(guestParties).where(eq(guestParties.id, party.id));

    await unlinkPartyProfile(database(), host, { guestPartyId: party.id, expectedPartyVersion: current!.version });
    expect((await facts()).allergies.map((entry) => `${entry.code}:${entry.source}`)).toEqual(["SESAME:RECORDED"]);

    // Saving to a profile needs guests.manage.
    await expect(
      recordPartyAllergy(database(), server, {
        guestPartyId: party.id,
        expectedPartyVersion: current!.version + 1,
        allergenId: list.EGGS.id,
        severity: "ALLERGY",
        note: null,
        saveToProfile: true,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses to link a finished visit", async () => {
    const profile = await createGuestProfile(database(), host, fields());
    const party = await walkIn();

    await database().execute(sql`UPDATE guest_parties SET status = 'CANCELLED' WHERE id = ${party.id}`);
    await expect(
      linkPartyToProfile(database(), host, { guestPartyId: party.id, guestProfileId: profile.id, expectedPartyVersion: party.version }),
    ).rejects.toMatchObject({ code: "PARTY_FINISHED" });
  });

  it("lists visits from snapshots and counts cancellations", async () => {
    const profile = await createGuestProfile(database(), host, fields());
    const party = await walkIn(profile.id);

    await database().execute(sql`UPDATE guest_parties SET status = 'CANCELLED' WHERE id = ${party.id}`);
    await walkIn(profile.id);

    const { summary, visits } = await getGuestVisits(database(), server, profile.id);

    expect(summary).toMatchObject({ visits: 2, cancellations: 1, seatedVisits: 0, averageSpend: null });
    expect(visits.map((visit) => visit.status).sort()).toEqual(["CANCELLED", "WAITING"]);
  });

  it("merges a duplicate: visits move, the more severe allergy wins, and the duplicate is frozen", async () => {
    const manager = await actorWith(database(), scenario, ["guests.view", "guests.manage", "guests.merge"]);
    const kept = await createGuestProfile(database(), host, {
      ...fields(),
      allergies: [{ allergenId: list.MILK.id, severity: "ALLERGY", note: null }],
    });
    const duplicate = await createGuestProfile(database(), host, {
      ...fields({ displayName: "Ana G." }),
      allergies: [
        { allergenId: list.MILK.id, severity: "SEVERE", note: null },
        { allergenId: list.FISH.id, severity: "ALLERGY", note: null },
      ],
    });
    const party = await walkIn(duplicate.id);

    await expect(
      mergeGuestProfiles(database(), host, {
        duplicateProfileId: duplicate.id,
        duplicateVersion: 1,
        keptProfileId: kept.id,
        keptVersion: 1,
        reason: "Same guest",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const result = await mergeGuestProfiles(database(), manager, {
      duplicateProfileId: duplicate.id,
      duplicateVersion: 1,
      keptProfileId: kept.id,
      keptVersion: 1,
      reason: "Same guest",
    });

    expect(result).toMatchObject({ partiesMoved: 1, allergiesAdded: 1 });

    const keptView = await getGuestProfile(database(), manager, kept.id);

    expect(keptView.allergies.map((entry) => `${entry.code}:${entry.severity}`)).toEqual(["MILK:SEVERE", "FISH:ALLERGY"]);

    const [movedParty] = await database().select().from(guestParties).where(eq(guestParties.id, party.id));

    expect(movedParty!.guestProfileId).toBe(kept.id);
    expect(await database().select().from(guestProfileMerges).where(eq(guestProfileMerges.mergedProfileId, duplicate.id))).toHaveLength(1);
    await expect(
      database().execute(sql`UPDATE guest_profiles SET notes = 'x' WHERE id = ${duplicate.id}`),
    ).rejects.toThrow();
  });

  it("erases personal data from the profile, its merged duplicate and its visits, without contact data in the audit", async () => {
    const manager = await actorWith(database(), scenario, ["guests.view", "guests.manage", "guests.merge", "guests.erase"]);
    const kept = await createGuestProfile(database(), host, {
      ...fields({ notes: "Prefers booth" }),
      allergies: [{ allergenId: list.MILK.id, severity: "ALLERGY", note: null }],
    });
    const duplicate = await createGuestProfile(database(), host, fields({ displayName: "Ana G.", email: "ana.g@example.com" }));
    const party = await walkIn(kept.id);

    await mergeGuestProfiles(database(), manager, {
      duplicateProfileId: duplicate.id,
      duplicateVersion: 1,
      keptProfileId: kept.id,
      keptVersion: 1,
      reason: "Same guest",
    });

    const [before] = await database().select().from(guestProfiles).where(eq(guestProfiles.id, kept.id));
    const result = await eraseGuestProfile(database(), manager, {
      profileId: kept.id,
      expectedVersion: before!.version,
      reason: "Guest asked",
    });

    expect(result).toMatchObject({ partiesCleared: 1, mergedProfilesCleared: 1 });

    const profiles = await database().select().from(guestProfiles).where(sql`${guestProfiles.id} IN (${kept.id}, ${duplicate.id})`);

    for (const profile of profiles) {
      expect(profile).toMatchObject({ displayName: "Erased guest", phone: null, email: null, notes: null, preferences: null });
      expect(profile.erasedAt).not.toBeNull();
    }

    const [clearedParty] = await database().select().from(guestParties).where(eq(guestParties.id, party.id));

    expect(clearedParty).toMatchObject({ guestName: "Erased guest", phone: null, email: null });
    expect(await database().select().from(guestPartyAllergies).where(eq(guestPartyAllergies.guestPartyId, party.id))).toEqual([]);

    const audit = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.category, "GUESTS"), eq(auditEvents.organizationId, scenario.organizationId)));
    const text = JSON.stringify(audit);

    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining(["guests.profile-created", "guests.profile-erased"]));
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("0100199");
    expect(text).not.toContain("Prefers booth");
  });

  it("clears merged profiles without violating the merge constraint", async () => {
    const manager = await actorWith(database(), scenario, ["guests.view", "guests.manage", "guests.merge"]);
    const kept = await createGuestProfile(database(), host, fields());
    const duplicate = await createGuestProfile(database(), host, fields({ displayName: "Ana G." }));

    await mergeGuestProfiles(database(), manager, {
      duplicateProfileId: duplicate.id,
      duplicateVersion: 1,
      keptProfileId: kept.id,
      keptVersion: 1,
      reason: "Same guest",
    });

    await expect(clearRestaurantData(database())).resolves.toBeUndefined();
    expect(await database().select().from(guestProfiles)).toEqual([]);
  });
});
