import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import type { Database } from "@/db";
import { assertVersionMatched, nextVersion } from "@/db/helpers/versioning";
import { preShiftNotePositions, preShiftNotes } from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { findHeldPositionIds, findTargetPositions } from "@/modules/employees/queries/briefing-positions";
import { findDisplayNamesByUser } from "@/modules/employees/queries/employee-display-names";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import { assertNoCardNumber, assertSearchRange } from "../rules/manager-log-rules";
import { assertNoteDate, assertNoteEditable, compareNotes, notesForReader } from "../rules/pre-shift-rules";
import { actorHolds, assertPermission, readLocationClock } from "./access";

// Phase 32 pre-shift notes (policies 7–10, 12). A briefing for one business date, aimed at
// everyone or at positions. Managers edit or withdraw it until its date has passed; edits
// aren't audited. Position targeting decides relevance, not access.

type NoteRow = typeof preShiftNotes.$inferSelect;

export type PreShiftNoteView = {
  id: string;
  businessDate: string;
  title: string;
  body: string;
  pinned: boolean;
  active: boolean;
  /** Empty means everyone. */
  positions: { id: string; name: string }[];
  createdByName: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  editable: boolean;
};

async function positionIdsOf(executor: DatabaseExecutor, noteIds: readonly string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  if (noteIds.length === 0) {
    return result;
  }

  const rows = await executor
    .select({ noteId: preShiftNotePositions.noteId, positionId: preShiftNotePositions.positionId })
    .from(preShiftNotePositions)
    .where(inArray(preShiftNotePositions.noteId, [...noteIds]));

  for (const row of rows) {
    result.set(row.noteId, [...(result.get(row.noteId) ?? []), row.positionId]);
  }

  return result;
}

async function viewsOf(
  executor: DatabaseExecutor,
  actor: Actor,
  rows: readonly (NoteRow & { positionIds: string[] })[],
  today: string,
): Promise<PreShiftNoteView[]> {
  const [positionList, names] = await Promise.all([
    findTargetPositions(executor, { organizationId: actor.organizationId, ids: [...new Set(rows.flatMap((row) => row.positionIds))] }),
    findDisplayNamesByUser(executor, {
      organizationId: actor.organizationId,
      userIds: rows.flatMap((row) => [row.createdByUserId, row.updatedByUserId]),
    }),
  ]);
  const positionNames = new Map(positionList.map((position) => [position.id, position.name]));

  return rows.map((row) => ({
    id: row.id,
    businessDate: row.businessDate,
    title: row.title,
    body: row.body,
    pinned: row.pinned,
    active: row.active,
    positions: row.positionIds
      .map((id) => ({ id, name: positionNames.get(id) ?? "Unknown position" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    createdByName: names.get(row.createdByUserId) ?? null,
    updatedByName: names.get(row.updatedByUserId) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    editable: row.active && row.businessDate >= today,
  }));
}

async function notesBetween(executor: DatabaseExecutor, locationId: string, from: string, to: string) {
  const rows = await executor
    .select()
    .from(preShiftNotes)
    .where(and(eq(preShiftNotes.locationId, locationId), gte(preShiftNotes.businessDate, from), lte(preShiftNotes.businessDate, to)))
    .orderBy(asc(preShiftNotes.businessDate), asc(preShiftNotes.createdAt));
  const positions = await positionIdsOf(
    executor,
    rows.map((row) => row.id),
  );

  return rows.map((row) => ({ ...row, positionIds: positions.get(row.id) ?? [] }));
}

async function today(executor: DatabaseExecutor, actor: Actor): Promise<string> {
  return (await readLocationClock(executor, actor.locationId, new Date())).businessDate;
}

// ------------------------------------------------------------------------------ Reading

/**
 * Policy 9: today's notes for the reader, meaning those for everyone and for a position they
 * hold here. A holder of `pre-shift.manage` sees every active note for today.
 */
export async function listNotesForReader(
  executor: DatabaseExecutor,
  actor: Actor,
): Promise<{ businessDate: string; notes: PreShiftNoteView[] }> {
  assertPermission(actor, "pre-shift.view");

  const businessDate = await today(executor, actor);
  const rows = await notesBetween(executor, actor.locationId, businessDate, businessDate);
  const visible = actorHolds(actor, "pre-shift.manage")
    ? rows.filter((row) => row.active).sort(compareNotes)
    : notesForReader(
        rows,
        businessDate,
        await findHeldPositionIds(executor, {
          userId: actor.userId,
          organizationId: actor.organizationId,
          locationId: actor.locationId,
        }),
      );

  return { businessDate, notes: await viewsOf(executor, actor, visible, businessDate) };
}

/** Policy 9: every note in a range (up to 31 days), withdrawn ones included, for managers. */
export async function listNotesForManager(
  executor: DatabaseExecutor,
  actor: Actor,
  range: { from: string; to: string },
): Promise<{ today: string; notes: PreShiftNoteView[] }> {
  assertPermission(actor, "pre-shift.manage");
  assertSearchRange(range.from, range.to);

  const businessDate = await today(executor, actor);
  const rows = await notesBetween(executor, actor.locationId, range.from, range.to);

  return { today: businessDate, notes: await viewsOf(executor, actor, rows, businessDate) };
}

/** The positions a note can be aimed at: the organization's active ones. */
export async function listNoteTargets(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "pre-shift.manage");

  return (await findTargetPositions(executor, { organizationId: actor.organizationId })).filter((position) => position.active);
}

// ------------------------------------------------------------------------------ Writing

export type NoteInput = {
  businessDate: string;
  title: string;
  body: string;
  pinned: boolean;
  positionIds: string[];
};

/** Every position is the organization's; newly named ones must be active. */
async function assertTargets(executor: DatabaseExecutor, actor: Actor, positionIds: readonly string[], kept: readonly string[] = []) {
  const unique = [...new Set(positionIds)];
  const found = await findTargetPositions(executor, { organizationId: actor.organizationId, ids: unique });
  const byId = new Map(found.map((position) => [position.id, position]));

  for (const id of unique) {
    const position = byId.get(id);

    if (!position) {
      throw new NotFoundError("position");
    }

    if (!position.active && !kept.includes(id)) {
      throw new BusinessRuleError("POSITION_INACTIVE", `${position.name} is no longer an active position.`);
    }
  }

  return unique;
}

async function replacePositions(transaction: DatabaseTransaction, actor: Actor, noteId: string, positionIds: readonly string[]) {
  await transaction.delete(preShiftNotePositions).where(eq(preShiftNotePositions.noteId, noteId));

  if (positionIds.length > 0) {
    await transaction
      .insert(preShiftNotePositions)
      .values(positionIds.map((positionId) => ({ noteId, positionId, organizationId: actor.organizationId })));
  }
}

async function viewOne(executor: DatabaseExecutor, actor: Actor, noteId: string): Promise<PreShiftNoteView> {
  const [row] = await executor.select().from(preShiftNotes).where(eq(preShiftNotes.id, noteId));
  const positions = await positionIdsOf(executor, [noteId]);
  const [view] = await viewsOf(executor, actor, [{ ...row!, positionIds: positions.get(noteId) ?? [] }], await today(executor, actor));

  return view!;
}

/** Policy 7: a note for today or up to 14 days ahead. */
export async function createNote(database: Database, actor: Actor, input: NoteInput): Promise<PreShiftNoteView> {
  assertPermission(actor, "pre-shift.manage");
  assertNoCardNumber(input.title, input.body);

  return withTransaction(database, async (transaction) => {
    assertNoteDate(input.businessDate, await today(transaction, actor));

    const positionIds = await assertTargets(transaction, actor, input.positionIds);
    const [row] = await transaction
      .insert(preShiftNotes)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        businessDate: input.businessDate,
        title: input.title.trim(),
        body: input.body.trim(),
        pinned: input.pinned,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      })
      .returning({ id: preShiftNotes.id });

    await replacePositions(transaction, actor, row!.id, positionIds);

    return viewOne(transaction, actor, row!.id);
  });
}

async function lockNote(transaction: DatabaseTransaction, actor: Actor, noteId: string): Promise<NoteRow> {
  const [note] = await transaction
    .select()
    .from(preShiftNotes)
    .where(and(eq(preShiftNotes.id, noteId), eq(preShiftNotes.locationId, actor.locationId)))
    .for("update");

  if (!note) {
    throw new NotFoundError("pre-shift note");
  }

  return note;
}

/** Policy 8: edits until the note's date has passed, with optimistic concurrency. */
export async function updateNote(
  database: Database,
  actor: Actor,
  noteId: string,
  input: NoteInput & { expectedVersion: number },
): Promise<PreShiftNoteView> {
  assertPermission(actor, "pre-shift.manage");
  assertNoCardNumber(input.title, input.body);

  return withTransaction(database, async (transaction) => {
    const note = await lockNote(transaction, actor, noteId);
    const businessDate = await today(transaction, actor);

    assertNoteEditable(note.businessDate, businessDate);

    if (!note.active) {
      throw new BusinessRuleError("NOTE_WITHDRAWN", "This note has been withdrawn.");
    }

    assertNoteDate(input.businessDate, businessDate);

    const kept = (await positionIdsOf(transaction, [noteId])).get(noteId) ?? [];
    const positionIds = await assertTargets(transaction, actor, input.positionIds, kept);

    assertVersionMatched(
      await transaction
        .update(preShiftNotes)
        .set({
          businessDate: input.businessDate,
          title: input.title.trim(),
          body: input.body.trim(),
          pinned: input.pinned,
          updatedByUserId: actor.userId,
          version: nextVersion(preShiftNotes.version),
        })
        .where(and(eq(preShiftNotes.id, noteId), eq(preShiftNotes.version, input.expectedVersion)))
        .returning({ id: preShiftNotes.id }),
      { type: "pre-shift note", id: noteId },
    );
    await replacePositions(transaction, actor, noteId, positionIds);

    return viewOne(transaction, actor, noteId);
  });
}

/** Policy 8: withdrawn, never deleted, until the note's date has passed. */
export async function withdrawNote(
  database: Database,
  actor: Actor,
  noteId: string,
  input: { expectedVersion: number },
): Promise<PreShiftNoteView> {
  assertPermission(actor, "pre-shift.manage");

  return withTransaction(database, async (transaction) => {
    const note = await lockNote(transaction, actor, noteId);

    assertNoteEditable(note.businessDate, await today(transaction, actor));

    if (!note.active) {
      throw new BusinessRuleError("NOTE_WITHDRAWN", "This note has already been withdrawn.");
    }

    assertVersionMatched(
      await transaction
        .update(preShiftNotes)
        .set({ active: false, updatedByUserId: actor.userId, version: nextVersion(preShiftNotes.version) })
        .where(and(eq(preShiftNotes.id, noteId), eq(preShiftNotes.version, input.expectedVersion)))
        .returning({ id: preShiftNotes.id }),
      { type: "pre-shift note", id: noteId },
    );

    return viewOne(transaction, actor, noteId);
  });
}
