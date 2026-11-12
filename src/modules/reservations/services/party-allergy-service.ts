import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db";
import { nextVersion } from "@/db/helpers/versioning";
import { allergens, guestParties, guestPartyAllergies, guestProfileAllergies, guestProfiles } from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import type { AllergySeverity, RecordedAllergy } from "@/modules/recipes/rules/allergen-label";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { assertNoCardNumbers } from "../rules/guest-contact";
import { actorHolds, assertAnyPermission, assertPermission } from "./guest-access";
import { ALLERGIES_CHANGED_EVENT, FINISHED_PARTY_STATUSES, requireAllergenCodes } from "./guest-profile-service";

// Phase 21 (policy 8): a visit's allergies, which the order warning checks. Hosts record them
// under `guests.manage`, servers under `orders.edit`. Changing them never touches sent items.

export type PartyAllergyView = RecordedAllergy & { note: string | null; source: "PROFILE" | "RECORDED" | "ONLINE" };

export type PartyGuestFacts = {
  profile: { id: string; profileNumber: number; displayName: string; vip: boolean } | null;
  allergies: PartyAllergyView[];
};

/** Profile and allergies for each party, for host lists, the floor and the order screen. */
export async function loadPartyGuestFacts(
  executor: DatabaseExecutor,
  partyIds: readonly string[],
): Promise<Map<string, PartyGuestFacts>> {
  const result = new Map<string, PartyGuestFacts>();

  if (partyIds.length === 0) {
    return result;
  }

  const ids = [...new Set(partyIds)];
  const [parties, allergyRows] = await Promise.all([
    executor
      .select({
        id: guestParties.id,
        profileId: guestProfiles.id,
        profileNumber: guestProfiles.profileNumber,
        displayName: guestProfiles.displayName,
        vip: guestProfiles.vip,
      })
      .from(guestParties)
      .leftJoin(guestProfiles, eq(guestProfiles.id, guestParties.guestProfileId))
      .where(inArray(guestParties.id, ids)),
    executor
      .select({
        partyId: guestPartyAllergies.guestPartyId,
        allergenId: guestPartyAllergies.allergenId,
        code: allergens.code,
        name: allergens.name,
        severity: guestPartyAllergies.severity,
        note: guestPartyAllergies.note,
        source: guestPartyAllergies.source,
      })
      .from(guestPartyAllergies)
      .innerJoin(allergens, eq(allergens.id, guestPartyAllergies.allergenId))
      .where(inArray(guestPartyAllergies.guestPartyId, ids))
      .orderBy(asc(allergens.displayOrder), asc(allergens.name)),
  ]);

  for (const party of parties) {
    result.set(party.id, {
      profile: party.profileId
        ? { id: party.profileId, profileNumber: party.profileNumber!, displayName: party.displayName!, vip: party.vip! }
        : null,
      allergies: [],
    });
  }

  for (const { partyId, ...row } of allergyRows) {
    result.get(partyId)?.allergies.push({
      ...row,
      severity: row.severity as AllergySeverity,
      source: row.source as PartyAllergyView["source"],
    });
  }

  return result;
}

const MAX_NOTE = 200;

/** Adds or changes one allergy on a visit (policy 8), optionally saving it to the linked profile. */
export async function recordPartyAllergy(
  database: Database,
  actor: Actor,
  input: {
    guestPartyId: string;
    expectedPartyVersion: number;
    allergenId: string;
    severity: AllergySeverity;
    note: string | null;
    saveToProfile: boolean;
  },
) {
  assertAnyPermission(actor, ["guests.manage", "orders.edit"]);

  if (input.saveToProfile) {
    assertPermission(actor, "guests.manage");
  }

  const note = input.note?.trim() || null;

  if (note && note.length > MAX_NOTE) {
    throw new BusinessRuleError("INVALID_NOTE", `Keep the note to ${MAX_NOTE} characters.`);
  }

  assertNoCardNumbers({ note });

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const party = await lockParty(transaction, actor, input.guestPartyId, input.expectedPartyVersion);
    const [existing] = await transaction
      .select()
      .from(guestPartyAllergies)
      .where(and(eq(guestPartyAllergies.guestPartyId, party.id), eq(guestPartyAllergies.allergenId, input.allergenId)));
    const codes = await requireAllergenCodes(
      transaction,
      actor,
      [input.allergenId],
      existing ? new Set([input.allergenId]) : new Set(),
    );

    if (existing) {
      await transaction
        .update(guestPartyAllergies)
        .set({ severity: input.severity, note, recordedByUserId: actor.userId, recordedAt: now })
        .where(eq(guestPartyAllergies.id, existing.id));
    } else {
      await transaction.insert(guestPartyAllergies).values({
        organizationId: actor.organizationId,
        guestPartyId: party.id,
        allergenId: input.allergenId,
        severity: input.severity,
        note,
        source: "RECORDED",
        recordedByUserId: actor.userId,
        recordedAt: now,
      });
    }

    let profileNumber: number | null = null;

    if (input.saveToProfile) {
      if (!party.guestProfileId) {
        throw new BusinessRuleError("PARTY_NOT_LINKED", "Link this visit to a guest profile first.");
      }

      const [profile] = await transaction
        .select()
        .from(guestProfiles)
        .where(eq(guestProfiles.id, party.guestProfileId))
        .for("update");

      if (!profile || profile.status !== "ACTIVE") {
        throw new BusinessRuleError("PROFILE_NOT_ACTIVE", "The linked profile can't be changed.");
      }

      profileNumber = profile.profileNumber;
      await transaction
        .insert(guestProfileAllergies)
        .values({
          organizationId: actor.organizationId,
          guestProfileId: profile.id,
          allergenId: input.allergenId,
          severity: input.severity,
          note,
        })
        .onConflictDoUpdate({
          target: [guestProfileAllergies.guestProfileId, guestProfileAllergies.allergenId],
          set: { severity: input.severity, note },
        });
      await transaction
        .update(guestProfiles)
        .set({ version: nextVersion(guestProfiles.version), updatedAt: now })
        .where(eq(guestProfiles.id, profile.id));
      // The visit's row now comes from the profile, so it leaves with an unlink.
      await transaction
        .update(guestPartyAllergies)
        .set({ source: "PROFILE" })
        .where(and(eq(guestPartyAllergies.guestPartyId, party.id), eq(guestPartyAllergies.allergenId, input.allergenId)));
    }

    const version = await bumpParty(transaction, party.id);

    await recordAudit(transaction, actor, {
      action: "guests.allergies-changed",
      entityId: party.guestProfileId ?? party.id,
      details: {
        ...(profileNumber !== null ? { profileNumber } : {}),
        guestPartyId: party.id,
        added: [`${codes.get(input.allergenId)}:${input.severity}`],
        removed: existing ? [`${codes.get(input.allergenId)}:${existing.severity}`] : [],
      },
    });
    await announce(transaction, actor, party, now);

    return { guestPartyId: party.id, version };
  });
}

/** Removes one allergy from a visit. The linked profile keeps it unless edited there. */
export async function removePartyAllergy(
  database: Database,
  actor: Actor,
  input: { guestPartyId: string; expectedPartyVersion: number; allergenId: string },
) {
  assertAnyPermission(actor, ["guests.manage", "orders.edit"]);

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const party = await lockParty(transaction, actor, input.guestPartyId, input.expectedPartyVersion);
    const removed = await transaction
      .delete(guestPartyAllergies)
      .where(and(eq(guestPartyAllergies.guestPartyId, party.id), eq(guestPartyAllergies.allergenId, input.allergenId)))
      .returning({ severity: guestPartyAllergies.severity });

    if (removed.length === 0) {
      throw new NotFoundError("party allergy");
    }

    const codes = await requireAllergenCodes(transaction, actor, [input.allergenId], new Set([input.allergenId]));
    const version = await bumpParty(transaction, party.id);

    await recordAudit(transaction, actor, {
      action: "guests.allergies-changed",
      entityId: party.guestProfileId ?? party.id,
      details: { guestPartyId: party.id, added: [], removed: [`${codes.get(input.allergenId)}:${removed[0]!.severity}`] },
    });
    await announce(transaction, actor, party, now);

    return { guestPartyId: party.id, version };
  });
}

async function lockParty(
  transaction: DatabaseTransaction,
  actor: Actor,
  partyId: string,
  expectedVersion: number,
) {
  const [party] = await transaction
    .select()
    .from(guestParties)
    .where(and(eq(guestParties.id, partyId), eq(guestParties.locationId, actor.locationId)))
    .for("update");

  if (!party) {
    throw new NotFoundError("guest party");
  }

  if (party.version !== expectedVersion) {
    throw new ConcurrencyError("guest party", party.id);
  }

  if ((FINISHED_PARTY_STATUSES as readonly string[]).includes(party.status)) {
    throw new BusinessRuleError("PARTY_FINISHED", "This visit is finished, so its allergies can't change.");
  }

  return party;
}

async function bumpParty(transaction: DatabaseTransaction, partyId: string) {
  const [row] = await transaction
    .update(guestParties)
    .set({ version: nextVersion(guestParties.version), updatedAt: new Date() })
    .where(eq(guestParties.id, partyId))
    .returning({ version: guestParties.version });

  return row!.version;
}

async function announce(
  transaction: DatabaseTransaction,
  actor: Actor,
  party: { id: string; locationId: string },
  now: Date,
) {
  await writeOutboxEvents(transaction, [
    {
      organizationId: actor.organizationId,
      locationId: party.locationId,
      eventType: ALLERGIES_CHANGED_EVENT,
      aggregateType: "guest_party",
      aggregateId: party.id,
      payload: { guestPartyId: party.id },
      occurredAt: now,
    },
  ]);
}

/** Whether the actor may see a party's profile name and VIP mark (allergies are always shown). */
export function canSeeGuestProfiles(actor: Actor): boolean {
  return actorHolds(actor, "guests.view");
}
