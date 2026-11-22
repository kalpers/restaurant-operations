import { count, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { locations } from "@/db/schema";
import { withReadOnlySnapshot, withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { AuthContext, Actor } from "@/modules/auth/types";
import { redactTicketItemInstructions } from "@/modules/kitchen/services/erase-text";
import {
  findItemInstructionCandidates,
  findTakeoutNameCandidates,
  redactItemInstructions,
  redactTakeoutName,
} from "@/modules/orders/services/erase-text";
import {
  excerptAround,
  findMention,
  hasTerms,
  mentionTerms,
  redactMentions,
  type GuestIdentifiers,
  type MentionTerms,
} from "@/modules/reservations/rules/guest-mentions";
import {
  clearOwnVisitNotes,
  findPartyRequestCandidates,
  findReservationNoteCandidates,
  findWaitlistNoteCandidates,
  readOwnPartyIds,
  redactPartyRequest,
  redactReservationNote,
  redactWaitlistNote,
} from "@/modules/reservations/services/erase-text";
import { assertPermission } from "@/modules/reservations/services/guest-access";
import {
  eraseGuestProfileInTransaction,
  eraseGuestVisitInTransaction,
  readProfileIdentifiers,
  readVisitIdentifiers,
} from "@/modules/reservations/services/guest-profile-service";
import { findBriefingTextCandidates } from "@/modules/restaurant/queries/briefing-text-search";
import { clearOwnSessionNotes, findSessionNoteCandidates, redactSessionNote } from "@/modules/restaurant/services/erase-text";
import { redactLogEntryInTransaction } from "@/modules/restaurant/services/manager-log-service";
import { redactNoteInTransaction } from "@/modules/restaurant/services/pre-shift-service";
import {
  findAssignmentNoteCandidates,
  findShiftNoteCandidates,
  redactAssignmentNote,
  redactShiftNote,
} from "@/modules/scheduling/services/erase-text";
import { clearPurchaserForErase, findPurchaserCandidates } from "@/modules/settlements/services/gift-card-purchaser-service";
import { BusinessRuleError } from "@/shared/errors/app-error";
import { likeContains, type FreeTextCandidate, type FreeTextQuery, type RedactText } from "@/shared/text/free-text-search";

// Phase 33 (policies 2–4, 6): erasing a guest also offers to redact the manager log entries and
// pre-shift notes that mention them. Phase 34 (policies 11–14, amendments 6–8) widens the
// search to every free-text field staff type into, and redacts word by word everywhere but the
// log and notes (which are emptied, as in Phase 33). Matching is only a suggestion: the eraser
// ticks what to redact, and the ticked ones are redacted in the erase's own transaction. The
// matches are worked out again inside that transaction, so nothing else can be redacted.

/** Phase 33's log entries and notes, then Phase 34's kinds (amendment 6). */
export const MENTION_KINDS = [
  "LOG_ENTRY",
  "NOTE",
  "PARTY_REQUEST",
  "RESERVATION_NOTE",
  "WAITLIST_NOTE",
  "SESSION_NOTE",
  "TAKEOUT_NAME",
  "ORDER_ITEM_INSTRUCTION",
  "SHIFT_NOTE",
  "ASSIGNMENT_NOTE",
  "GIFT_CARD_PURCHASER",
] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

/** Phase 34 kinds, chosen through `redactMentions`. */
export type TextMentionKind = Exclude<MentionKind, "LOG_ENTRY" | "NOTE">;

export type GuestMention = {
  kind: MentionKind;
  id: string;
  locationId: string | null;
  locationName: string | null;
  businessDate: string | null;
  label: string;
  excerpt: string;
};

export type MentionPreview = {
  mentions: GuestMention[];
  /** Locations of the organization the eraser can't redact the manager log at. */
  locationsNotSearched: number;
  /** Phase 34 (amendment 8): per kind, how many locations weren't searched (0 when all were). */
  notSearched: { kind: MentionKind; locations: number }[];
};

/** Amendment 8: per kind, where the eraser may search and redact. Purchasers are organization-wide. */
export type EraseSearchScope = Record<Exclude<MentionKind, "GIFT_CARD_PURCHASER">, string[]> & { purchasers: boolean };

/** The view permission(s) a kind needs at a location (Phase 34 policy 14). */
const KIND_PERMISSIONS: Record<Exclude<MentionKind, "GIFT_CARD_PURCHASER">, readonly PermissionCode[]> = {
  LOG_ENTRY: ["manager-log.view", "manager-log.redact"],
  NOTE: ["manager-log.view", "manager-log.redact"],
  PARTY_REQUEST: ["reservations.view"],
  RESERVATION_NOTE: ["reservations.view"],
  WAITLIST_NOTE: ["waitlist.view"],
  SESSION_NOTE: ["restaurant.view"],
  TAKEOUT_NAME: ["orders.view"],
  ORDER_ITEM_INSTRUCTION: ["orders.view"],
  SHIFT_NOTE: ["schedule.view"],
  ASSIGNMENT_NOTE: ["schedule.view"],
};

/** Amendments 3 and 8: from the eraser's whole sign-in, where each kind may be searched. */
export function eraseSearchScope(auth: AuthContext, actor: Actor): EraseSearchScope {
  const mine = auth.locations.filter((location) => location.organizationId === actor.organizationId);
  const where = (needed: readonly PermissionCode[]) =>
    mine.filter((location) => needed.every((permission) => location.permissions.includes(permission))).map((location) => location.locationId);
  const scope = Object.fromEntries(
    Object.entries(KIND_PERMISSIONS).map(([kind, needed]) => [kind, where(needed)]),
  ) as Record<Exclude<MentionKind, "GIFT_CARD_PURCHASER">, string[]>;

  return { ...scope, purchasers: actor.permissions.has("gift-cards.purchaser.view") };
}

/** Phase 33's name, kept for its callers: where the manager log may be redacted. */
export function redactableLocationIds(auth: AuthContext, actor: Actor): string[] {
  return eraseSearchScope(auth, actor).LOG_ENTRY;
}

/** A scope covering only the manager log locations given (Phase 33 callers and tests). */
export function logOnlyScope(locationIds: readonly string[]): EraseSearchScope {
  return {
    LOG_ENTRY: [...locationIds],
    NOTE: [...locationIds],
    PARTY_REQUEST: [],
    RESERVATION_NOTE: [],
    WAITLIST_NOTE: [],
    SESSION_NOTE: [],
    TAKEOUT_NAME: [],
    ORDER_ITEM_INSTRUCTION: [],
    SHIFT_NOTE: [],
    ASSIGNMENT_NOTE: [],
    purchasers: false,
  };
}

const toScope = (scope: EraseSearchScope | readonly string[]): EraseSearchScope =>
  Array.isArray(scope) ? logOnlyScope(scope) : (scope as EraseSearchScope);

type Candidate = FreeTextCandidate & { kind: MentionKind };

async function candidatesOf(
  executor: DatabaseExecutor,
  actor: Actor,
  terms: MentionTerms,
  scope: EraseSearchScope,
  ownPartyIds: readonly string[],
): Promise<Candidate[]> {
  const query: FreeTextQuery = { words: [...terms.names, ...terms.emails], digitRuns: terms.phoneTails };
  const organizationId = actor.organizationId;
  const at = (locationIds: readonly string[]) => ({ organizationId, locationIds, excludePartyIds: ownPartyIds });
  const tag = (kind: MentionKind) => (rows: FreeTextCandidate[]) => rows.map((row) => ({ ...row, kind }));
  const briefing = await findBriefingTextCandidates(executor, {
    organizationId,
    locationIds: scope.LOG_ENTRY,
    words: query.words,
    digitRuns: query.digitRuns,
  });

  return [
    ...briefing.map((row) => ({
      kind: row.kind,
      id: row.id,
      locationId: row.locationId,
      locationName: row.locationName,
      date: row.businessDate,
      label: row.label,
      text: row.text,
    })),
    ...tag("PARTY_REQUEST")(await findPartyRequestCandidates(executor, at(scope.PARTY_REQUEST), query)),
    ...tag("RESERVATION_NOTE")(await findReservationNoteCandidates(executor, at(scope.RESERVATION_NOTE), query)),
    ...tag("WAITLIST_NOTE")(await findWaitlistNoteCandidates(executor, at(scope.WAITLIST_NOTE), query)),
    ...tag("SESSION_NOTE")(await findSessionNoteCandidates(executor, at(scope.SESSION_NOTE), query)),
    ...tag("TAKEOUT_NAME")(await findTakeoutNameCandidates(executor, at(scope.TAKEOUT_NAME), query)),
    ...tag("ORDER_ITEM_INSTRUCTION")(await findItemInstructionCandidates(executor, at(scope.ORDER_ITEM_INSTRUCTION), query)),
    ...tag("SHIFT_NOTE")(await findShiftNoteCandidates(executor, at(scope.SHIFT_NOTE), query)),
    ...tag("ASSIGNMENT_NOTE")(await findAssignmentNoteCandidates(executor, at(scope.ASSIGNMENT_NOTE), query)),
    ...(scope.purchasers
      ? (await findPurchaserCandidates(executor, actor, { ...query, contains: likeContains })).map((row) => ({
          kind: "GIFT_CARD_PURCHASER" as const,
          id: row.id,
          locationId: null,
          locationName: null,
          date: null,
          label: `Purchaser of gift card ${row.cardNumber}`,
          text: row.text,
        }))
      : []),
  ];
}

async function mentionsOf(
  executor: DatabaseExecutor,
  actor: Actor,
  terms: MentionTerms,
  scope: EraseSearchScope,
  ownPartyIds: readonly string[],
): Promise<GuestMention[]> {
  if (!hasTerms(terms)) {
    return [];
  }

  const candidates = await candidatesOf(executor, actor, terms, scope, ownPartyIds);

  return candidates
    .flatMap((candidate) => {
      const match = findMention(candidate.text, terms);

      return match
        ? [
            {
              kind: candidate.kind,
              id: candidate.id,
              locationId: candidate.locationId,
              locationName: candidate.locationName,
              businessDate: candidate.date,
              label: candidate.label,
              excerpt: excerptAround(candidate.text, match),
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        MENTION_KINDS.indexOf(a.kind) - MENTION_KINDS.indexOf(b.kind) ||
        (b.businessDate ?? "").localeCompare(a.businessDate ?? "") ||
        a.label.localeCompare(b.label),
    );
}

async function organizationLocationCount(executor: DatabaseExecutor, organizationId: string): Promise<number> {
  const [row] = await executor.select({ total: count() }).from(locations).where(eq(locations.organizationId, organizationId));

  return row?.total ?? 0;
}

type Target = { profileId: string } | { guestPartyId: string };

async function identifiersOf(executor: DatabaseExecutor, actor: Actor, target: Target) {
  const ownPartyIds = await readOwnPartyIds(executor, target);

  if ("profileId" in target) {
    const { profileNumber, identifiers } = await readProfileIdentifiers(executor, actor, target.profileId);

    return { identifiers, ownPartyIds, redactionReason: `Guest erase, profile #${profileNumber}` };
  }

  return { identifiers: await readVisitIdentifiers(executor, actor, target.guestPartyId), ownPartyIds, redactionReason: "Guest erase, visit" };
}

/** Policy 2: the possible mentions shown before an erase is confirmed. Reads only. */
export async function previewGuestMentions(
  database: Database,
  actor: Actor,
  target: Target,
  searchScope: EraseSearchScope | readonly string[],
): Promise<MentionPreview> {
  assertPermission(actor, "guests.erase");

  const scope = toScope(searchScope);

  return withReadOnlySnapshot(database, async (executor) => {
    const { identifiers, ownPartyIds } = await identifiersOf(executor, actor, target);
    const mentions = await mentionsOf(executor, actor, mentionTerms(identifiers), scope, ownPartyIds);
    const total = await organizationLocationCount(executor, actor.organizationId);
    const notSearched = MENTION_KINDS.map((kind) => ({
      kind,
      locations: kind === "GIFT_CARD_PURCHASER" ? (scope.purchasers ? 0 : total) : Math.max(0, total - scope[kind].length),
    })).filter((entry) => entry.locations > 0);

    return { mentions, locationsNotSearched: Math.max(0, total - scope.LOG_ENTRY.length), notSearched };
  });
}

export type ChosenMentions = {
  redactEntryIds: readonly string[];
  redactNoteIds: readonly string[];
  /** Phase 34 (amendment 6): the other kinds, by kind and row. */
  redactMentions?: readonly { kind: TextMentionKind; id: string }[];
};

type TextRedactor = (transaction: DatabaseTransaction, actor: Actor, id: string, redact: RedactText, reason: string) => Promise<unknown>;

/** Amendment 7: each domain redacts its own rows; the kitchen's copies go with their item. */
const TEXT_REDACTORS: Record<Exclude<TextMentionKind, "GIFT_CARD_PURCHASER">, TextRedactor> = {
  PARTY_REQUEST: redactPartyRequest,
  RESERVATION_NOTE: redactReservationNote,
  WAITLIST_NOTE: redactWaitlistNote,
  SESSION_NOTE: redactSessionNote,
  TAKEOUT_NAME: redactTakeoutName,
  ORDER_ITEM_INSTRUCTION: async (transaction, actor, id, redact, reason) => {
    await redactItemInstructions(transaction, actor, id, redact, reason);
    await redactTicketItemInstructions(transaction, actor, id, redact, reason);
  },
  SHIFT_NOTE: redactShiftNote,
  ASSIGNMENT_NOTE: redactAssignmentNote,
};

/** Redacts the chosen mentions after checking each is still a mention; returns the counts. */
async function redactChosen(
  transaction: DatabaseTransaction,
  actor: Actor,
  identifiers: GuestIdentifiers,
  scope: EraseSearchScope,
  ownPartyIds: readonly string[],
  chosen: ChosenMentions,
  reason: string,
) {
  const entryIds = [...new Set(chosen.redactEntryIds)];
  const noteIds = [...new Set(chosen.redactNoteIds)];
  const others = [...new Map((chosen.redactMentions ?? []).map((mention) => [`${mention.kind}:${mention.id}`, mention])).values()];

  if (entryIds.length + noteIds.length + others.length === 0) {
    return { logEntriesRedacted: 0, notesRedacted: 0, textRedacted: 0 };
  }

  const terms = mentionTerms(identifiers);
  const found = await mentionsOf(transaction, actor, terms, scope, ownPartyIds);
  const byId = new Map(found.map((mention) => [`${mention.kind}:${mention.id}`, mention]));
  const missing = [
    ...entryIds.filter((id) => !byId.has(`LOG_ENTRY:${id}`)),
    ...noteIds.filter((id) => !byId.has(`NOTE:${id}`)),
    ...others.filter((mention) => !byId.has(`${mention.kind}:${mention.id}`)),
  ];

  if (missing.length > 0) {
    throw new BusinessRuleError(
      "MENTION_NOT_MATCHED",
      "Something chosen for redaction no longer mentions this guest, or can't be redacted by you. Reload and try again.",
    );
  }

  const at = new Date();
  const locationOf = (key: string) => byId.get(key)!.locationId!;

  for (const id of entryIds) {
    await redactLogEntryInTransaction(transaction, actor, { entryId: id, locationId: locationOf(`LOG_ENTRY:${id}`), reason, at });
  }

  for (const id of noteIds) {
    await redactNoteInTransaction(transaction, actor, { noteId: id, locationId: locationOf(`NOTE:${id}`), reason, at });
  }

  const redact: RedactText = (text) => redactMentions(text, terms);

  for (const mention of others) {
    if (mention.kind === "GIFT_CARD_PURCHASER") {
      await clearPurchaserForErase(transaction, actor, mention.id, reason);
    } else {
      await TEXT_REDACTORS[mention.kind](transaction, actor, mention.id, redact, reason);
    }
  }

  return { logEntriesRedacted: entryIds.length, notesRedacted: noteIds.length, textRedacted: others.length };
}

/** Policy 11: the erased guest's own reservation, waitlist and table session notes. */
async function clearOwnNotes(transaction: DatabaseTransaction, partyIds: readonly string[]): Promise<number> {
  return (await clearOwnVisitNotes(transaction, partyIds)) + (await clearOwnSessionNotes(transaction, partyIds));
}

export type EraseWithMentionsInput = ChosenMentions & { expectedVersion: number; reason: string };

/** Policies 2–4, 6 (Phase 33) and 11–14 (Phase 34): erases a profile and redacts the chosen mentions. */
export async function eraseGuestProfileWithMentions(
  database: Database,
  actor: Actor,
  profileId: string,
  input: EraseWithMentionsInput,
  searchScope: EraseSearchScope | readonly string[],
) {
  assertPermission(actor, "guests.erase");

  const scope = toScope(searchScope);

  return withTransaction(database, async (transaction) => {
    const { identifiers, ownPartyIds, redactionReason } = await identifiersOf(transaction, actor, { profileId });
    const redacted = await redactChosen(transaction, actor, identifiers, scope, ownPartyIds, input, redactionReason);
    const ownNotesCleared = await clearOwnNotes(transaction, ownPartyIds);

    return eraseGuestProfileInTransaction(
      transaction,
      actor,
      { profileId, expectedVersion: input.expectedVersion, reason: input.reason },
      { ...redacted, ownNotesCleared },
    );
  });
}

/** The same for one unlinked visit. */
export async function eraseGuestVisitWithMentions(
  database: Database,
  actor: Actor,
  guestPartyId: string,
  input: EraseWithMentionsInput,
  searchScope: EraseSearchScope | readonly string[],
) {
  assertPermission(actor, "guests.erase");

  const scope = toScope(searchScope);

  return withTransaction(database, async (transaction) => {
    const { identifiers, ownPartyIds, redactionReason } = await identifiersOf(transaction, actor, { guestPartyId });
    const redacted = await redactChosen(transaction, actor, identifiers, scope, ownPartyIds, input, redactionReason);
    const ownNotesCleared = await clearOwnNotes(transaction, ownPartyIds);

    return eraseGuestVisitInTransaction(
      transaction,
      actor,
      { guestPartyId, expectedVersion: input.expectedVersion, reason: input.reason },
      { ...redacted, ownNotesCleared },
    );
  });
}
