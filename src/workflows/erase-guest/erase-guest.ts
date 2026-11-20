import { count, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { locations } from "@/db/schema";
import { withReadOnlySnapshot, withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { AuthContext, Actor } from "@/modules/auth/types";
import {
  excerptAround,
  findMention,
  hasTerms,
  mentionTerms,
  type GuestIdentifiers,
  type MentionTerms,
} from "@/modules/reservations/rules/guest-mentions";
import { assertPermission } from "@/modules/reservations/services/guest-access";
import {
  eraseGuestProfileInTransaction,
  eraseGuestVisitInTransaction,
  readProfileIdentifiers,
  readVisitIdentifiers,
} from "@/modules/reservations/services/guest-profile-service";
import { findBriefingTextCandidates } from "@/modules/restaurant/queries/briefing-text-search";
import { redactLogEntryInTransaction } from "@/modules/restaurant/services/manager-log-service";
import { redactNoteInTransaction } from "@/modules/restaurant/services/pre-shift-service";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Phase 33 (policies 2–4, 6): erasing a guest also offers to redact the manager log entries and
// pre-shift notes that mention them. Matching is only a suggestion: the eraser ticks what to
// redact, and the ticked ones are redacted in the erase's own transaction. The matches are
// worked out again inside that transaction, so nothing else can be redacted this way.

export type GuestMention = {
  kind: "LOG_ENTRY" | "NOTE";
  id: string;
  locationId: string;
  locationName: string;
  businessDate: string;
  label: string;
  excerpt: string;
};

export type MentionPreview = {
  mentions: GuestMention[];
  /** Locations of the organization the eraser can't redact at, so weren't searched. */
  locationsNotSearched: number;
};

/**
 * Amendment 3: where the eraser may redact, from their whole sign-in: locations of the
 * actor's organization where they hold both `manager-log.view` and `manager-log.redact`.
 */
export function redactableLocationIds(auth: AuthContext, actor: Actor): string[] {
  return auth.locations
    .filter(
      (location) =>
        location.organizationId === actor.organizationId &&
        location.permissions.includes("manager-log.view") &&
        location.permissions.includes("manager-log.redact"),
    )
    .map((location) => location.locationId);
}

async function mentionsOf(
  executor: DatabaseExecutor,
  actor: Actor,
  terms: MentionTerms,
  locationIds: readonly string[],
): Promise<GuestMention[]> {
  if (!hasTerms(terms)) {
    return [];
  }

  const candidates = await findBriefingTextCandidates(executor, {
    organizationId: actor.organizationId,
    locationIds,
    words: [...terms.names, ...terms.emails],
    digitRuns: terms.phoneTails,
  });

  return candidates.flatMap((candidate) => {
    const match = findMention(candidate.text, terms);

    return match
      ? [
          {
            kind: candidate.kind,
            id: candidate.id,
            locationId: candidate.locationId,
            locationName: candidate.locationName,
            businessDate: candidate.businessDate,
            label: candidate.label,
            excerpt: excerptAround(candidate.text, match),
          },
        ]
      : [];
  });
}

async function organizationLocationCount(executor: DatabaseExecutor, organizationId: string): Promise<number> {
  const [row] = await executor.select({ total: count() }).from(locations).where(eq(locations.organizationId, organizationId));

  return row?.total ?? 0;
}

type Target = { profileId: string } | { guestPartyId: string };

async function identifiersOf(executor: DatabaseExecutor, actor: Actor, target: Target) {
  if ("profileId" in target) {
    const { profileNumber, identifiers } = await readProfileIdentifiers(executor, actor, target.profileId);

    return { identifiers, redactionReason: `Guest erase, profile #${profileNumber}` };
  }

  return { identifiers: await readVisitIdentifiers(executor, actor, target.guestPartyId), redactionReason: "Guest erase, visit" };
}

/** Policy 2: the possible mentions shown before an erase is confirmed. Reads only. */
export async function previewGuestMentions(
  database: Database,
  actor: Actor,
  target: Target,
  locationIds: readonly string[],
): Promise<MentionPreview> {
  assertPermission(actor, "guests.erase");

  return withReadOnlySnapshot(database, async (executor) => {
    const { identifiers } = await identifiersOf(executor, actor, target);
    const mentions = await mentionsOf(executor, actor, mentionTerms(identifiers), locationIds);
    const total = await organizationLocationCount(executor, actor.organizationId);

    return { mentions, locationsNotSearched: Math.max(0, total - locationIds.length) };
  });
}

export type ChosenMentions = { redactEntryIds: readonly string[]; redactNoteIds: readonly string[] };

/** Redacts the chosen mentions after checking each is still a mention; returns the counts. */
async function redactChosen(
  transaction: DatabaseTransaction,
  actor: Actor,
  identifiers: GuestIdentifiers,
  locationIds: readonly string[],
  chosen: ChosenMentions,
  reason: string,
) {
  const entryIds = [...new Set(chosen.redactEntryIds)];
  const noteIds = [...new Set(chosen.redactNoteIds)];

  if (entryIds.length + noteIds.length === 0) {
    return { logEntriesRedacted: 0, notesRedacted: 0 };
  }

  const found = await mentionsOf(transaction, actor, mentionTerms(identifiers), locationIds);
  const byId = new Map(found.map((mention) => [`${mention.kind}:${mention.id}`, mention]));
  const missing = [
    ...entryIds.filter((id) => !byId.has(`LOG_ENTRY:${id}`)),
    ...noteIds.filter((id) => !byId.has(`NOTE:${id}`)),
  ];

  if (missing.length > 0) {
    throw new BusinessRuleError(
      "MENTION_NOT_MATCHED",
      "Something chosen for redaction no longer mentions this guest, or can't be redacted by you. Reload and try again.",
    );
  }

  const at = new Date();
  const locationOf = (key: string) => byId.get(key)!.locationId;

  for (const id of entryIds) {
    await redactLogEntryInTransaction(transaction, actor, { entryId: id, locationId: locationOf(`LOG_ENTRY:${id}`), reason, at });
  }

  for (const id of noteIds) {
    await redactNoteInTransaction(transaction, actor, { noteId: id, locationId: locationOf(`NOTE:${id}`), reason, at });
  }

  return { logEntriesRedacted: entryIds.length, notesRedacted: noteIds.length };
}

export type EraseWithMentionsInput = ChosenMentions & { expectedVersion: number; reason: string };

/** Policies 2–4, 6: erases a profile and redacts the chosen mentions, in one transaction. */
export async function eraseGuestProfileWithMentions(
  database: Database,
  actor: Actor,
  profileId: string,
  input: EraseWithMentionsInput,
  locationIds: readonly string[],
) {
  assertPermission(actor, "guests.erase");

  return withTransaction(database, async (transaction) => {
    const { identifiers, redactionReason } = await identifiersOf(transaction, actor, { profileId });
    const redacted = await redactChosen(transaction, actor, identifiers, locationIds, input, redactionReason);

    return eraseGuestProfileInTransaction(
      transaction,
      actor,
      { profileId, expectedVersion: input.expectedVersion, reason: input.reason },
      redacted,
    );
  });
}

/** Policies 2–4, 6: erases one unlinked visit and redacts the chosen mentions. */
export async function eraseGuestVisitWithMentions(
  database: Database,
  actor: Actor,
  guestPartyId: string,
  input: EraseWithMentionsInput,
  locationIds: readonly string[],
) {
  assertPermission(actor, "guests.erase");

  return withTransaction(database, async (transaction) => {
    const { identifiers, redactionReason } = await identifiersOf(transaction, actor, { guestPartyId });
    const redacted = await redactChosen(transaction, actor, identifiers, locationIds, input, redactionReason);

    return eraseGuestVisitInTransaction(
      transaction,
      actor,
      { guestPartyId, expectedVersion: input.expectedVersion, reason: input.reason },
      redacted,
    );
  });
}
