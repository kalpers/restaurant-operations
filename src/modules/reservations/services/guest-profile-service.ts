import { and, asc, desc, eq, ilike, inArray, isNull, notInArray, or, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { nextVersion } from "@/db/helpers/versioning";
import {
  allergens,
  guestParties,
  guestPartyAllergies,
  guestProfileAllergies,
  guestProfileMerges,
  guestProfileNumberCounters,
  guestProfiles,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import type { AllergySeverity } from "@/modules/recipes/rules/allergen-label";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { assertNoCardNumbers, normalizeGuestEmail, normalizePhone, searchAsPhone } from "../rules/guest-contact";
import { actorHolds, assertPermission } from "./guest-access";
import { eraseVisitMessaging } from "./guest-message-service";

// Phase 21 guest profiles (policies 1-4, 7), owned by Reservations (D1). A profile is
// organization-wide (D2); a visit (Guest Party) links to one by hand (D3). Every change is one
// transaction with its audit row. Audit rows name fields and allergen codes only, never contact
// details, notes or allergy notes (D14). Nothing here touches orders, stock or reports.

export const ALLERGIES_CHANGED_EVENT = "guest.allergies-changed";

/** Parties in these states are finished: their profile link and allergies no longer change. */
export const FINISHED_PARTY_STATUSES = ["COMPLETED", "CANCELLED", "NO_SHOW"] as const;

const ERASED_NAME = "Erased guest";

export type AllergyInput = { allergenId: string; severity: AllergySeverity; note: string | null };

export type ProfileFields = {
  displayName: string;
  phone: string | null;
  email: string | null;
  vip: boolean;
  vipReason: string | null;
  preferences: string | null;
  notes: string | null;
  otherDietaryNeeds: string | null;
};

type ProfileRow = typeof guestProfiles.$inferSelect;

const blank = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? "";

  return trimmed === "" ? null : trimmed;
};

function cleanFields(input: ProfileFields) {
  const fields = {
    displayName: input.displayName.trim(),
    phone: blank(input.phone),
    email: blank(input.email),
    vip: input.vip,
    vipReason: input.vip ? blank(input.vipReason) : null,
    preferences: blank(input.preferences),
    notes: blank(input.notes),
    otherDietaryNeeds: blank(input.otherDietaryNeeds),
  };

  if (fields.displayName === "") {
    throw new BusinessRuleError("INVALID_NAME", "Give the guest a name.");
  }

  assertNoCardNumbers({
    email: fields.email,
    vipReason: fields.vipReason,
    preferences: fields.preferences,
    notes: fields.notes,
    otherDietaryNeeds: fields.otherDietaryNeeds,
  });

  return {
    ...fields,
    phoneNormalized: normalizePhone(fields.phone),
    emailNormalized: normalizeGuestEmail(fields.email),
  };
}

function cleanAllergies(input: readonly AllergyInput[]) {
  const ids = input.map((entry) => entry.allergenId);

  if (new Set(ids).size !== ids.length) {
    throw new BusinessRuleError("ALLERGEN_DUPLICATE", "List each allergen once.");
  }

  const cleaned = input.map((entry) => ({ ...entry, note: blank(entry.note) }));

  assertNoCardNumbers(Object.fromEntries(cleaned.map((entry, index) => [`allergies.${index}.note`, entry.note])));

  return cleaned;
}

/** Allergen codes by ID; each must be this organization's and active unless already in `kept`. */
export async function requireAllergenCodes(
  executor: DatabaseExecutor,
  actor: Actor,
  ids: readonly string[],
  kept: ReadonlySet<string> = new Set(),
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({ id: allergens.id, code: allergens.code, active: allergens.active })
    .from(allergens)
    .where(and(eq(allergens.organizationId, actor.organizationId), inArray(allergens.id, [...new Set(ids)])));

  if (rows.length !== new Set(ids).size) {
    throw new NotFoundError("allergen");
  }

  if (rows.some((row) => !row.active && !kept.has(row.id))) {
    throw new BusinessRuleError("ALLERGEN_INACTIVE", "An inactive allergen can't be recorded.");
  }

  return new Map(rows.map((row) => [row.id, row.code]));
}

async function nextProfileNumber(transaction: DatabaseTransaction, organizationId: string): Promise<number> {
  const [row] = await transaction
    .insert(guestProfileNumberCounters)
    .values({ organizationId, lastNumber: 1 })
    .onConflictDoUpdate({
      target: guestProfileNumberCounters.organizationId,
      set: { lastNumber: sql`${guestProfileNumberCounters.lastNumber} + 1` },
    })
    .returning({ lastNumber: guestProfileNumberCounters.lastNumber });

  return row!.lastNumber;
}

/** Locks an ACTIVE profile of the actor's organization and checks its version when given. */
async function lockActiveProfile(
  transaction: DatabaseTransaction,
  actor: Actor,
  profileId: string,
  expectedVersion?: number,
): Promise<ProfileRow> {
  const [profile] = await transaction
    .select()
    .from(guestProfiles)
    .where(and(eq(guestProfiles.id, profileId), eq(guestProfiles.organizationId, actor.organizationId)))
    .for("update");

  if (!profile) {
    throw new NotFoundError("guest profile");
  }

  if (expectedVersion !== undefined && profile.version !== expectedVersion) {
    throw new ConcurrencyError("guest profile", profile.id);
  }

  if (profile.status !== "ACTIVE") {
    throw new BusinessRuleError(
      "PROFILE_NOT_ACTIVE",
      profile.status === "MERGED" ? "This profile was merged into another." : "This profile was erased.",
    );
  }

  return profile;
}

async function bumpProfile(transaction: DatabaseTransaction, profileId: string) {
  const [row] = await transaction
    .update(guestProfiles)
    .set({ version: nextVersion(guestProfiles.version), updatedAt: new Date() })
    .where(eq(guestProfiles.id, profileId))
    .returning();

  return row!;
}

async function profileAllergyRows(executor: DatabaseExecutor, profileId: string) {
  return executor.select().from(guestProfileAllergies).where(eq(guestProfileAllergies.guestProfileId, profileId));
}

/** Copies a profile's allergies onto a visit as PROFILE rows. A RECORDED row for the same allergen stays. */
async function copyProfileAllergies(
  transaction: DatabaseTransaction,
  actor: Actor,
  profileId: string,
  partyId: string,
  now: Date,
) {
  const rows = await profileAllergyRows(transaction, profileId);

  if (rows.length > 0) {
    await transaction
      .insert(guestPartyAllergies)
      .values(
        rows.map((row) => ({
          organizationId: actor.organizationId,
          guestPartyId: partyId,
          allergenId: row.allergenId,
          severity: row.severity,
          note: row.note,
          source: "PROFILE",
          recordedByUserId: actor.userId,
          recordedAt: now,
        })),
      )
      .onConflictDoNothing({ target: [guestPartyAllergies.guestPartyId, guestPartyAllergies.allergenId] });
  }
}

async function announceAllergies(transaction: DatabaseTransaction, actor: Actor, partyIds: readonly string[], now: Date) {
  if (partyIds.length === 0) {
    return;
  }

  const rows = await transaction
    .select({ id: guestParties.id, locationId: guestParties.locationId })
    .from(guestParties)
    .where(inArray(guestParties.id, [...partyIds]));

  await writeOutboxEvents(
    transaction,
    rows.map((row) => ({
      organizationId: actor.organizationId,
      locationId: row.locationId,
      eventType: ALLERGIES_CHANGED_EVENT,
      aggregateType: "guest_party",
      aggregateId: row.id,
      payload: { guestPartyId: row.id },
      occurredAt: now,
    })),
  );
}

/** Unfinished visits linked to a profile: their PROFILE allergies follow the profile. */
async function refreshLinkedParties(transaction: DatabaseTransaction, actor: Actor, profileId: string, now: Date) {
  const parties = await transaction
    .select({ id: guestParties.id })
    .from(guestParties)
    .where(and(eq(guestParties.guestProfileId, profileId), notInArray(guestParties.status, [...FINISHED_PARTY_STATUSES])));

  for (const party of parties) {
    await transaction
      .delete(guestPartyAllergies)
      .where(and(eq(guestPartyAllergies.guestPartyId, party.id), eq(guestPartyAllergies.source, "PROFILE")));
    await copyProfileAllergies(transaction, actor, profileId, party.id, now);
  }

  return parties.map((party) => party.id);
}

async function replaceProfileAllergies(
  transaction: DatabaseTransaction,
  actor: Actor,
  profileId: string,
  input: readonly AllergyInput[],
) {
  const allergies = cleanAllergies(input);
  const before = await profileAllergyRows(transaction, profileId);
  const codes = await requireAllergenCodes(
    transaction,
    actor,
    [...allergies.map((entry) => entry.allergenId), ...before.map((row) => row.allergenId)],
    new Set(before.map((row) => row.allergenId)),
  );

  await transaction.delete(guestProfileAllergies).where(eq(guestProfileAllergies.guestProfileId, profileId));

  if (allergies.length > 0) {
    await transaction.insert(guestProfileAllergies).values(
      allergies.map((entry) => ({
        organizationId: actor.organizationId,
        guestProfileId: profileId,
        allergenId: entry.allergenId,
        severity: entry.severity,
        note: entry.note,
      })),
    );
  }

  const describe = (rows: readonly { allergenId: string; severity: string }[]) =>
    new Set(rows.map((row) => `${codes.get(row.allergenId)}:${row.severity}`));
  const was = describe(before);
  const now = describe(allergies);

  return {
    added: [...now].filter((entry) => !was.has(entry)).sort(),
    removed: [...was].filter((entry) => !now.has(entry)).sort(),
  };
}

// ------------------------------------------------------------------ create and edit

export async function createGuestProfile(
  database: Database,
  actor: Actor,
  input: ProfileFields & { allergies?: readonly AllergyInput[] },
) {
  assertPermission(actor, "guests.manage");

  const fields = cleanFields(input);

  return withTransaction(database, async (transaction) => {
    const profileNumber = await nextProfileNumber(transaction, actor.organizationId);
    const [profile] = await transaction
      .insert(guestProfiles)
      .values({ organizationId: actor.organizationId, profileNumber, createdByUserId: actor.userId, ...fields })
      .returning();

    await recordAudit(transaction, actor, {
      action: "guests.profile-created",
      entityId: profile!.id,
      after: { profileNumber, vip: profile!.vip },
    });

    if (input.allergies && input.allergies.length > 0) {
      const change = await replaceProfileAllergies(transaction, actor, profile!.id, input.allergies);

      await recordAudit(transaction, actor, {
        action: "guests.allergies-changed",
        entityId: profile!.id,
        details: { profileNumber, ...change },
      });
    }

    return { id: profile!.id, profileNumber, version: profile!.version };
  });
}

export async function updateGuestProfile(
  database: Database,
  actor: Actor,
  input: ProfileFields & { profileId: string; expectedVersion: number },
) {
  assertPermission(actor, "guests.manage");

  return withTransaction(database, async (transaction) => {
    const current = await lockActiveProfile(transaction, actor, input.profileId, input.expectedVersion);
    // An editor who can't see contact details can't change them: the stored ones stay.
    const fields = cleanFields(
      actorHolds(actor, "guests.contact.view") ? input : { ...input, phone: current.phone, email: current.email },
    );
    const [row] = await transaction
      .update(guestProfiles)
      .set({ ...fields, version: nextVersion(guestProfiles.version), updatedAt: new Date() })
      .where(eq(guestProfiles.id, current.id))
      .returning();
    const changedFields = (
      ["displayName", "phone", "email", "vipReason", "preferences", "notes", "otherDietaryNeeds"] as const
    ).filter((field) => current[field] !== row![field]);

    if (changedFields.length > 0) {
      await recordAudit(transaction, actor, {
        action: "guests.profile-updated",
        entityId: current.id,
        details: { profileNumber: current.profileNumber, changedFields },
      });
    }

    if (current.vip !== row!.vip) {
      await recordAudit(transaction, actor, {
        action: "guests.vip-changed",
        entityId: current.id,
        before: { profileNumber: current.profileNumber, vip: current.vip },
        after: { profileNumber: current.profileNumber, vip: row!.vip },
      });
    }

    return { id: row!.id, version: row!.version };
  });
}

/** Replaces a profile's allergies; unfinished linked visits follow (policy 8). */
export async function setGuestProfileAllergies(
  database: Database,
  actor: Actor,
  input: { profileId: string; expectedVersion: number; allergies: readonly AllergyInput[] },
) {
  assertPermission(actor, "guests.manage");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const profile = await lockActiveProfile(transaction, actor, input.profileId, input.expectedVersion);
    const change = await replaceProfileAllergies(transaction, actor, profile.id, input.allergies);
    const row = await bumpProfile(transaction, profile.id);
    const parties = await refreshLinkedParties(transaction, actor, profile.id, now);

    await recordAudit(transaction, actor, {
      action: "guests.allergies-changed",
      entityId: profile.id,
      details: { profileNumber: profile.profileNumber, ...change },
    });
    await announceAllergies(transaction, actor, parties, now);

    return { id: row.id, version: row.version };
  });
}

// ------------------------------------------------------------------ read

export type GuestAllergyView = {
  allergenId: string;
  code: string;
  name: string;
  severity: AllergySeverity;
  note: string | null;
};

export type GuestProfileSummary = {
  id: string;
  profileNumber: number;
  displayName: string;
  vip: boolean;
  allergies: Omit<GuestAllergyView, "note">[];
  /** Only with `guests.contact.view`. */
  phone?: string | null;
  email?: string | null;
};

async function allergiesByProfile(executor: DatabaseExecutor, profileIds: readonly string[]) {
  const result = new Map<string, GuestAllergyView[]>();

  if (profileIds.length === 0) {
    return result;
  }

  const rows = await executor
    .select({
      profileId: guestProfileAllergies.guestProfileId,
      allergenId: guestProfileAllergies.allergenId,
      code: allergens.code,
      name: allergens.name,
      severity: guestProfileAllergies.severity,
      note: guestProfileAllergies.note,
    })
    .from(guestProfileAllergies)
    .innerJoin(allergens, eq(allergens.id, guestProfileAllergies.allergenId))
    .where(inArray(guestProfileAllergies.guestProfileId, [...profileIds]))
    .orderBy(asc(allergens.displayOrder), asc(allergens.name));

  for (const { profileId, ...row } of rows) {
    result.set(profileId, [...(result.get(profileId) ?? []), { ...row, severity: row.severity as AllergySeverity }]);
  }

  return result;
}

function summarize(actor: Actor, row: ProfileRow, allergies: readonly GuestAllergyView[]): GuestProfileSummary {
  return {
    id: row.id,
    profileNumber: row.profileNumber,
    displayName: row.displayName,
    vip: row.vip,
    allergies: allergies.map((entry) => ({
      allergenId: entry.allergenId,
      code: entry.code,
      name: entry.name,
      severity: entry.severity,
    })),
    ...(actorHolds(actor, "guests.contact.view") ? { phone: row.phone, email: row.email } : {}),
  };
}

/**
 * Suggestions for the guest picker and the Guests page (policy 2): an exact phone or email
 * match first, then names containing the text. ACTIVE profiles only, at most 10. Searching by
 * phone or email needs `guests.contact.view`, so contact details can't be probed without it.
 */
export async function searchGuestProfiles(executor: DatabaseExecutor, actor: Actor, query: string) {
  assertPermission(actor, "guests.view");

  const text = query.trim();

  if (text.length === 0) {
    return [];
  }

  const canUseContact = actorHolds(actor, "guests.contact.view");
  const phone = canUseContact ? searchAsPhone(text) : null;
  const email = canUseContact && text.includes("@") ? normalizeGuestEmail(text) : null;
  const pattern = `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  const rows = await executor
    .select()
    .from(guestProfiles)
    .where(
      and(
        eq(guestProfiles.organizationId, actor.organizationId),
        eq(guestProfiles.status, "ACTIVE"),
        or(
          ilike(guestProfiles.displayName, pattern),
          phone ? sql`right(${guestProfiles.phoneNormalized}, ${phone.length}) = ${phone}` : undefined,
          email ? eq(guestProfiles.emailNormalized, email) : undefined,
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${email ? sql`${guestProfiles.emailNormalized} = ${email}` : sql`false`}
        OR ${phone ? sql`right(${guestProfiles.phoneNormalized}, ${phone.length}) = ${phone}` : sql`false`} THEN 0 ELSE 1 END`,
      desc(guestProfiles.vip),
      asc(guestProfiles.displayName),
      asc(guestProfiles.profileNumber),
    )
    .limit(10);
  const allergies = await allergiesByProfile(executor, rows.map((row) => row.id));

  return rows.map((row) => summarize(actor, row, allergies.get(row.id) ?? []));
}

export type GuestProfileView = Omit<GuestProfileSummary, "allergies"> & {
  status: ProfileRow["status"];
  vipReason: string | null;
  preferences: string | null;
  notes: string | null;
  otherDietaryNeeds: string | null;
  allergies: GuestAllergyView[];
  mergedIntoProfileId: string | null;
  version: number;
  createdAt: string;
};

export async function getGuestProfile(executor: DatabaseExecutor, actor: Actor, profileId: string): Promise<GuestProfileView> {
  assertPermission(actor, "guests.view");

  const [row] = await executor
    .select()
    .from(guestProfiles)
    .where(and(eq(guestProfiles.id, profileId), eq(guestProfiles.organizationId, actor.organizationId)));

  if (!row) {
    throw new NotFoundError("guest profile");
  }

  const allergies = (await allergiesByProfile(executor, [row.id])).get(row.id) ?? [];

  return {
    ...summarize(actor, row, allergies),
    allergies,
    status: row.status,
    vipReason: row.vipReason,
    preferences: row.preferences,
    notes: row.notes,
    otherDietaryNeeds: row.otherDietaryNeeds,
    mergedIntoProfileId: row.mergedIntoProfileId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

// ------------------------------------------------------------------ linking (policy 2)

async function lockOpenParty(transaction: DatabaseTransaction, actor: Actor, partyId: string, expectedVersion?: number) {
  const [party] = await transaction
    .select()
    .from(guestParties)
    .where(and(eq(guestParties.id, partyId), eq(guestParties.locationId, actor.locationId)))
    .for("update");

  if (!party) {
    throw new NotFoundError("guest party");
  }

  if (expectedVersion !== undefined && party.version !== expectedVersion) {
    throw new ConcurrencyError("guest party", party.id);
  }

  if ((FINISHED_PARTY_STATUSES as readonly string[]).includes(party.status)) {
    throw new BusinessRuleError("PARTY_FINISHED", "This visit is finished, so its guest can't change.");
  }

  return party;
}

/**
 * Links a visit to a profile inside the caller's transaction, replacing any earlier link, and
 * copies the profile's allergies in. Used by the link API and by reservation and walk-in creation.
 */
export async function attachProfileToParty(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: { guestPartyId: string; guestProfileId: string; expectedPartyVersion?: number },
) {
  assertPermission(actor, "guests.manage");

  const now = new Date();
  const party = await lockOpenParty(transaction, actor, input.guestPartyId, input.expectedPartyVersion);
  const profile = await lockActiveProfile(transaction, actor, input.guestProfileId);

  if (party.guestProfileId === profile.id) {
    return { guestPartyId: party.id, version: party.version };
  }

  await transaction
    .delete(guestPartyAllergies)
    .where(and(eq(guestPartyAllergies.guestPartyId, party.id), eq(guestPartyAllergies.source, "PROFILE")));

  const [row] = await transaction
    .update(guestParties)
    .set({ guestProfileId: profile.id, version: nextVersion(guestParties.version), updatedAt: now })
    .where(eq(guestParties.id, party.id))
    .returning({ version: guestParties.version });

  await copyProfileAllergies(transaction, actor, profile.id, party.id, now);
  await recordAudit(transaction, actor, {
    action: "guests.party-linked",
    entityId: profile.id,
    details: { profileNumber: profile.profileNumber, guestPartyId: party.id },
  });
  await announceAllergies(transaction, actor, [party.id], now);

  return { guestPartyId: party.id, version: row!.version };
}

export async function linkPartyToProfile(
  database: Database,
  actor: Actor,
  input: { guestPartyId: string; guestProfileId: string; expectedPartyVersion: number },
) {
  assertPermission(actor, "guests.manage");

  return withTransaction(database, (transaction) => attachProfileToParty(transaction, actor, input));
}

export async function unlinkPartyProfile(
  database: Database,
  actor: Actor,
  input: { guestPartyId: string; expectedPartyVersion: number },
) {
  assertPermission(actor, "guests.manage");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const party = await lockOpenParty(transaction, actor, input.guestPartyId, input.expectedPartyVersion);

    if (!party.guestProfileId) {
      return { guestPartyId: party.id, version: party.version };
    }

    const [profile] = await transaction
      .select({ id: guestProfiles.id, profileNumber: guestProfiles.profileNumber })
      .from(guestProfiles)
      .where(eq(guestProfiles.id, party.guestProfileId));

    await transaction
      .delete(guestPartyAllergies)
      .where(and(eq(guestPartyAllergies.guestPartyId, party.id), eq(guestPartyAllergies.source, "PROFILE")));

    const [row] = await transaction
      .update(guestParties)
      .set({ guestProfileId: null, version: nextVersion(guestParties.version), updatedAt: now })
      .where(eq(guestParties.id, party.id))
      .returning({ version: guestParties.version });

    await recordAudit(transaction, actor, {
      action: "guests.party-unlinked",
      entityId: profile!.id,
      details: { profileNumber: profile!.profileNumber, guestPartyId: party.id },
    });
    await announceAllergies(transaction, actor, [party.id], now);

    return { guestPartyId: party.id, version: row!.version };
  });
}

// ------------------------------------------------------------------ merge and erase

/** Merges a duplicate into the profile kept (policy 3). Never undone. */
export async function mergeGuestProfiles(
  database: Database,
  actor: Actor,
  input: {
    duplicateProfileId: string;
    duplicateVersion: number;
    keptProfileId: string;
    keptVersion: number;
    reason: string;
  },
) {
  assertPermission(actor, "guests.merge");

  const reason = input.reason.trim();

  if (reason.length === 0 || reason.length > 200) {
    throw new BusinessRuleError("INVALID_REASON", "Give a reason of 1 to 200 characters.");
  }

  if (input.duplicateProfileId === input.keptProfileId) {
    throw new BusinessRuleError("MERGE_SAME_PROFILE", "Choose two different profiles.");
  }

  assertNoCardNumbers({ reason });

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    // Lock in ID order so two merges of the same pair can't deadlock.
    const [firstId, secondId] = [input.duplicateProfileId, input.keptProfileId].sort();
    const first = await lockActiveProfile(transaction, actor, firstId!);
    const second = await lockActiveProfile(transaction, actor, secondId!);
    const duplicate = first.id === input.duplicateProfileId ? first : second;
    const kept = first.id === input.keptProfileId ? first : second;

    if (duplicate.version !== input.duplicateVersion) {
      throw new ConcurrencyError("guest profile", duplicate.id);
    }

    if (kept.version !== input.keptVersion) {
      throw new ConcurrencyError("guest profile", kept.id);
    }

    const keptAllergies = new Map((await profileAllergyRows(transaction, kept.id)).map((row) => [row.allergenId, row]));
    const duplicateAllergies = await profileAllergyRows(transaction, duplicate.id);
    let allergiesAdded = 0;

    for (const row of duplicateAllergies) {
      const existing = keptAllergies.get(row.allergenId);

      if (!existing) {
        await transaction.insert(guestProfileAllergies).values({
          organizationId: actor.organizationId,
          guestProfileId: kept.id,
          allergenId: row.allergenId,
          severity: row.severity,
          note: row.note,
        });
        allergiesAdded += 1;
      } else if (row.severity === "SEVERE" && existing.severity !== "SEVERE") {
        await transaction.update(guestProfileAllergies).set({ severity: "SEVERE" }).where(eq(guestProfileAllergies.id, existing.id));
      }
    }

    const moved = await transaction
      .update(guestParties)
      .set({ guestProfileId: kept.id, version: nextVersion(guestParties.version), updatedAt: now })
      .where(eq(guestParties.guestProfileId, duplicate.id))
      .returning({ id: guestParties.id });

    await transaction
      .update(guestProfiles)
      .set({ status: "MERGED", mergedIntoProfileId: kept.id, version: nextVersion(guestProfiles.version), updatedAt: now })
      .where(eq(guestProfiles.id, duplicate.id));

    const keptRow = await bumpProfile(transaction, kept.id);

    await transaction.insert(guestProfileMerges).values({
      organizationId: actor.organizationId,
      mergedProfileId: duplicate.id,
      keptProfileId: kept.id,
      partiesMoved: moved.length,
      allergiesAdded,
      reason,
      mergedByUserId: actor.userId,
      mergedAt: now,
    });

    const refreshed = await refreshLinkedParties(transaction, actor, kept.id, now);

    await recordAudit(transaction, actor, {
      action: "guests.profile-merged",
      entityId: duplicate.id,
      details: {
        profileNumber: duplicate.profileNumber,
        keptProfileNumber: kept.profileNumber,
        partiesMoved: moved.length,
        allergiesAdded,
        reason,
      },
    });
    await announceAllergies(transaction, actor, refreshed, now);

    return { keptProfileId: kept.id, keptVersion: keptRow.version, partiesMoved: moved.length, allergiesAdded };
  });
}

/**
 * Erases a profile's personal data (policy 4, D12): the profile keeps only its number, and the
 * visits linked to it lose their contact details, requests and allergies. Orders, sessions,
 * snapshots and history stay, so reports still add up.
 */
export async function eraseGuestProfile(
  database: Database,
  actor: Actor,
  input: { profileId: string; expectedVersion: number; reason: string },
) {
  assertPermission(actor, "guests.erase");

  const reason = input.reason.trim();

  if (reason.length === 0 || reason.length > 200) {
    throw new BusinessRuleError("INVALID_REASON", "Give a reason of 1 to 200 characters.");
  }

  assertNoCardNumbers({ reason });

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const profile = await lockActiveProfile(transaction, actor, input.profileId, input.expectedVersion);
    // Profiles merged into this one, directly or through a chain, hold the same guest's data.
    // Their parties moved at merge, so the parties to clear are this profile's.
    const mergedRows = await transaction.execute<{ id: string }>(sql`
      WITH RECURSIVE chain AS (
        SELECT "id" FROM "guest_profiles" WHERE "merged_into_profile_id" = ${profile.id}
        UNION
        SELECT p."id" FROM "guest_profiles" p JOIN chain c ON p."merged_into_profile_id" = c."id"
      )
      SELECT "id" FROM chain`);
    const mergedIds = [...mergedRows].map((row) => row.id);
    const parties = await transaction
      .update(guestParties)
      .set({
        guestName: ERASED_NAME,
        phone: null,
        email: null,
        specialRequests: null,
        version: nextVersion(guestParties.version),
        updatedAt: now,
      })
      .where(eq(guestParties.guestProfileId, profile.id))
      .returning({ id: guestParties.id });
    const partyIds = parties.map((party) => party.id);

    if (partyIds.length > 0) {
      await transaction.delete(guestPartyAllergies).where(inArray(guestPartyAllergies.guestPartyId, partyIds));
    }

    // Phase 22 (policy 17): consents, message addresses and bodies, and manage links too.
    await eraseVisitMessaging(transaction, partyIds, now);

    const personalData = {
      displayName: ERASED_NAME,
      phone: null,
      phoneNormalized: null,
      email: null,
      emailNormalized: null,
      vip: false,
      vipReason: null,
      preferences: null,
      notes: null,
      otherDietaryNeeds: null,
      erasedAt: now,
      updatedAt: now,
    };

    await transaction
      .delete(guestProfileAllergies)
      .where(inArray(guestProfileAllergies.guestProfileId, [profile.id, ...mergedIds]));

    if (mergedIds.length > 0) {
      await transaction
        .update(guestProfiles)
        .set({ ...personalData, version: nextVersion(guestProfiles.version) })
        .where(and(inArray(guestProfiles.id, mergedIds), isNull(guestProfiles.erasedAt)));
    }

    await transaction
      .update(guestProfiles)
      .set({
        displayName: ERASED_NAME,
        phone: null,
        phoneNormalized: null,
        email: null,
        emailNormalized: null,
        vip: false,
        vipReason: null,
        preferences: null,
        notes: null,
        otherDietaryNeeds: null,
        status: "ERASED",
        erasedAt: now,
        version: nextVersion(guestProfiles.version),
        updatedAt: now,
      })
      .where(eq(guestProfiles.id, profile.id));

    await recordAudit(transaction, actor, {
      action: "guests.profile-erased",
      entityId: profile.id,
      details: {
        profileNumber: profile.profileNumber,
        partiesCleared: partyIds.length,
        mergedProfilesCleared: mergedIds.length,
        reason,
      },
    });
    await announceAllergies(transaction, actor, partyIds, now);

    return { id: profile.id, partiesCleared: partyIds.length, mergedProfilesCleared: mergedIds.length };
  });
}

/**
 * Phase 22 (policy 17): erases one visit that was never linked to a profile, such as an online
 * booking. Its name becomes "Erased guest"; phone, email, special requests and allergies go;
 * its consents, message addresses and bodies and manage links are cleared. Its reservation,
 * orders and history stay. A linked visit is erased with its profile instead.
 */
export async function eraseGuestVisit(
  database: Database,
  actor: Actor,
  input: { guestPartyId: string; expectedVersion: number; reason: string },
) {
  assertPermission(actor, "guests.erase");

  const reason = input.reason.trim();

  if (reason.length === 0 || reason.length > 200) {
    throw new BusinessRuleError("INVALID_REASON", "Give a reason of 1 to 200 characters.");
  }

  assertNoCardNumbers({ reason });

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const [party] = await transaction
      .select()
      .from(guestParties)
      .where(and(eq(guestParties.id, input.guestPartyId), eq(guestParties.locationId, actor.locationId)))
      .for("update");

    if (!party) {
      throw new NotFoundError("guest party");
    }

    if (party.version !== input.expectedVersion) {
      throw new ConcurrencyError("guest party", party.id);
    }

    if (party.guestProfileId) {
      throw new BusinessRuleError("PARTY_HAS_PROFILE", "This visit belongs to a guest profile. Erase the profile instead.");
    }

    await transaction
      .update(guestParties)
      .set({
        guestName: ERASED_NAME,
        phone: null,
        email: null,
        specialRequests: null,
        version: nextVersion(guestParties.version),
        updatedAt: now,
      })
      .where(eq(guestParties.id, party.id));
    await transaction.delete(guestPartyAllergies).where(eq(guestPartyAllergies.guestPartyId, party.id));
    await eraseVisitMessaging(transaction, [party.id], now);
    await recordAudit(transaction, actor, {
      action: "guests.visit-erased",
      entityId: party.id,
      details: { guestPartyId: party.id, reason },
    });
    await announceAllergies(transaction, actor, [party.id], now);

    return { id: party.id, erased: true };
  });
}
