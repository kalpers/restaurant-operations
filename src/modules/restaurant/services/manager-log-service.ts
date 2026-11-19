import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { managerLogEntries, MANAGER_LOG_CATEGORIES } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { findDisplayNamesByUser } from "@/modules/employees/queries/employee-display-names";
import { findLinkedEmployeeId } from "@/modules/employees/queries/scheduling-facts";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import {
  findCorrections,
  findLogEntries,
  findLogEntry,
  findLogNumbers,
  nextLogNumber,
  type ManagerLogRow,
} from "../repositories/manager-log-repository";
import {
  assertNoCardNumber,
  assertSearchRange,
  entryBusinessDate,
  formatLogNumber,
  redactionReason,
  type LogDateChoice,
} from "../rules/manager-log-rules";
import { assertPermission, readLocationClock } from "./access";

// Phase 32 manager log (policies 3–6, 10–12). Entries are append-only: a correction is a new
// entry, and a redaction (Owner and General Manager) is the one change, made once with a
// reason and audited without the body. Writing an entry isn't audited: the entry itself
// records who wrote it, when and where.

export const MANAGER_LOG_ENTRY_SCOPE = "restaurant.manager-log-entry";

/** Search results are capped, so a broad search stays quick. */
const SEARCH_LIMIT = 300;

export type ManagerLogCategory = (typeof MANAGER_LOG_CATEGORIES)[number];

export type ManagerLogEntryView = {
  id: string;
  entryNumber: string;
  businessDate: string;
  category: string;
  /** Empty once redacted. */
  body: string;
  authorName: string | null;
  createdAt: string;
  corrects: { id: string; entryNumber: string } | null;
  correctedBy: string[];
  redaction: { at: string; byName: string | null; reason: string } | null;
};

async function viewsOf(executor: DatabaseExecutor, actor: Actor, rows: readonly ManagerLogRow[]): Promise<ManagerLogEntryView[]> {
  const ids = rows.map((row) => row.id);
  const [names, correctedNumbers, corrections] = await Promise.all([
    findDisplayNamesByUser(executor, {
      organizationId: actor.organizationId,
      userIds: rows.flatMap((row) => [row.authorUserId, ...(row.redactedByUserId ? [row.redactedByUserId] : [])]),
    }),
    findLogNumbers(executor, {
      organizationId: actor.organizationId,
      ids: rows.flatMap((row) => (row.correctsEntryId ? [row.correctsEntryId] : [])),
    }),
    findCorrections(executor, { organizationId: actor.organizationId, ids }),
  ]);

  return rows.map((row) => ({
    id: row.id,
    entryNumber: formatLogNumber(row.entryNumber),
    businessDate: row.businessDate,
    category: row.category,
    body: row.body,
    authorName: names.get(row.authorUserId) ?? null,
    createdAt: row.createdAt.toISOString(),
    corrects:
      row.correctsEntryId && correctedNumbers.has(row.correctsEntryId)
        ? { id: row.correctsEntryId, entryNumber: formatLogNumber(correctedNumbers.get(row.correctsEntryId)!) }
        : null,
    correctedBy: (corrections.get(row.id) ?? []).map(formatLogNumber),
    redaction:
      row.redactedAt && row.redactionReason
        ? {
            at: row.redactedAt.toISOString(),
            byName: row.redactedByUserId ? (names.get(row.redactedByUserId) ?? null) : null,
            reason: row.redactionReason,
          }
        : null,
  }));
}

// ------------------------------------------------------------------------------ Reading

export type LogQuery = {
  from: string;
  to: string;
  category?: ManagerLogCategory | null;
  text?: string | null;
};

/** One business date (from = to) or a search across up to 31 days (policy 10). */
export async function listLogEntries(
  executor: DatabaseExecutor,
  actor: Actor,
  query: LogQuery,
): Promise<{ entries: ManagerLogEntryView[]; truncated: boolean }> {
  assertPermission(actor, "manager-log.view");
  assertSearchRange(query.from, query.to);

  const rows = await findLogEntries(executor, {
    locationId: actor.locationId,
    from: query.from,
    to: query.to,
    category: query.category ?? null,
    text: query.text?.trim() || null,
    limit: SEARCH_LIMIT + 1,
  });

  return {
    entries: await viewsOf(executor, actor, rows.slice(0, SEARCH_LIMIT)),
    truncated: rows.length > SEARCH_LIMIT,
  };
}

/** The location's current business date, which the log page opens on. */
export async function currentLogDate(executor: DatabaseExecutor, actor: Actor): Promise<string> {
  assertPermission(actor, "manager-log.view");

  return (await readLocationClock(executor, actor.locationId, new Date())).businessDate;
}

// ------------------------------------------------------------------------------ Writing

export type AddLogEntryInput = {
  idempotencyKey: string;
  dateChoice: LogDateChoice;
  category: ManagerLogCategory;
  body: string;
  correctsEntryId: string | null;
};

/** What a retry gets back. The body isn't kept in the idempotency record. */
export type AddedLogEntry = { id: string; entryNumber: string; businessDate: string };

/** Policies 3, 4 and 12: adds one entry; a retry with the same key adds nothing. */
export async function addLogEntry(
  database: Database,
  actor: Actor,
  input: AddLogEntryInput,
): Promise<AddedLogEntry & { replayed: boolean }> {
  assertPermission(actor, "manager-log.write");

  const body = input.body.trim();

  assertNoCardNumber(body);

  const { idempotencyKey, ...request } = input;
  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<AddedLogEntry>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: MANAGER_LOG_ENTRY_SCOPE,
        key: idempotencyKey,
        actorUserId: actor.userId,
        request: { ...request, body, locationId: actor.locationId },
      },
      async () => {
        if (input.correctsEntryId) {
          const corrected = await findLogEntry(transaction, { entryId: input.correctsEntryId, locationId: actor.locationId });

          if (!corrected) {
            throw new NotFoundError("manager log entry");
          }
        }

        const now = new Date();
        const clock = await readLocationClock(transaction, actor.locationId, now);
        const entryNumber = await nextLogNumber(transaction, actor.organizationId);
        const [row] = await transaction
          .insert(managerLogEntries)
          .values({
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            entryNumber,
            businessDate: entryBusinessDate(input.dateChoice, clock.businessDate),
            category: input.category,
            body,
            authorUserId: actor.userId,
            authorEmployeeId: await findLinkedEmployeeId(transaction, {
              userId: actor.userId,
              organizationId: actor.organizationId,
            }),
            correctsEntryId: input.correctsEntryId,
            createdAt: now,
          })
          .returning();

        return { id: row!.id, entryNumber: formatLogNumber(row!.entryNumber), businessDate: row!.businessDate };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}

/** Policy 6: empties an entry's body, once, with a reason, and audits it without the body. */
export async function redactLogEntry(
  database: Database,
  actor: Actor,
  entryId: string,
  input: { reason: string },
): Promise<ManagerLogEntryView> {
  assertPermission(actor, "manager-log.redact");

  const reason = redactionReason(input.reason);

  assertNoCardNumber(reason);

  return withTransaction(database, async (transaction) => {
    const entry = await findLogEntry(transaction, { entryId, locationId: actor.locationId, lock: true });

    if (!entry) {
      throw new NotFoundError("manager log entry");
    }

    if (entry.redactedAt) {
      throw new BusinessRuleError("ALREADY_REDACTED", "This entry has already been redacted.");
    }

    const [updated] = await transaction
      .update(managerLogEntries)
      .set({ body: "", redactedAt: new Date(), redactedByUserId: actor.userId, redactionReason: reason })
      .where(eq(managerLogEntries.id, entry.id))
      .returning();

    await recordAudit(transaction, actor, {
      action: "restaurant.manager-log-redacted",
      entityId: entry.id,
      details: {
        entryNumber: formatLogNumber(entry.entryNumber),
        businessDate: entry.businessDate,
        category: entry.category,
        reasonLength: reason.length,
      },
    });

    const [view] = await viewsOf(transaction, actor, [updated!]);

    return view!;
  });
}
