import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  type DatabaseExecutor,
  withExecutorTransaction,
} from "@/db/transactions/transaction-context";
import { auditedRead, changedFieldNames, recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { NotFoundError } from "@/shared/errors/app-error";

import {
  findNoteById,
  findNoteRows,
  insertNote,
  updateNoteRow,
} from "../repositories/hr-record-repository";
import { noteRequiresSensitiveAccess } from "../rules/employee-rules";
import { actorHolds, assertPermission, requireEmployee } from "./access";

export async function listNotes(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
) {
  assertPermission(actor, "hr.notes.view");

  const includeSensitive = actorHolds(actor, "hr.notes.sensitive.view");
  const read = async (transaction: DatabaseExecutor) => {
    await requireEmployee(transaction, actor, employeeId);

    return findNoteRows(transaction, employeeId, { includeSensitive });
  };

  // Only reading sensitive and manager notes is audited.
  return includeSensitive
    ? auditedRead(
        executor,
        actor,
        { action: "hr.records-viewed", entityId: employeeId, details: { employeeId, kind: "SENSITIVE_NOTES" } },
        read,
      )
    : read(executor);
}

type NoteInput = {
  noteType: string;
  title: string;
  content: string;
  sensitive: boolean;
};

export async function addNote(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
  input: NoteInput,
) {
  assertPermission(actor, "hr.notes.manage");

  if (noteRequiresSensitiveAccess(input)) {
    assertPermission(actor, "hr.notes.sensitive.manage");
  }

  return withExecutorTransaction(executor, async (transaction) => {
    await requireEmployee(transaction, actor, employeeId);

    const note = await insertNote(transaction, {
      ...input,
      employeeId,
      createdByUserId: actor.userId,
    });

    await recordAudit(transaction, actor, {
      action: "hr.record-created",
      entityId: employeeId,
      details: { employeeId, recordId: note.id, kind: noteKind(input) },
    });

    return note;
  });
}

/** An actor without sensitive access sees such a note as absent and can't reclassify one. */
export async function updateNote(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    employeeId: string;
    noteId: string;
    expectedVersion: number;
    changes: NoteInput;
  },
) {
  assertPermission(actor, "hr.notes.manage");

  return withExecutorTransaction(executor, async (transaction) => {
    await requireEmployee(transaction, actor, input.employeeId);

    const note = await findNoteById(transaction, input.employeeId, input.noteId);

    if (
      !note ||
      (noteRequiresSensitiveAccess(note) &&
        !actorHolds(actor, "hr.notes.sensitive.view"))
    ) {
      throw new NotFoundError("note");
    }

    if (
      noteRequiresSensitiveAccess(note) ||
      noteRequiresSensitiveAccess(input.changes)
    ) {
      assertPermission(actor, "hr.notes.sensitive.manage");
    }

    const result = assertVersionMatched(
      await updateNoteRow(
        transaction,
        note.id,
        input.expectedVersion,
        input.changes,
      ),
      { type: "note", id: note.id },
    );

    await recordAudit(transaction, actor, {
      action: "hr.record-updated",
      entityId: input.employeeId,
      details: {
        employeeId: input.employeeId,
        recordId: note.id,
        kind: noteKind(input.changes),
        changedFields: changedFieldNames(note, input.changes, ["noteType", "title", "content", "sensitive"]),
      },
    });

    return result;
  });
}

function noteKind(note: { noteType: string; sensitive: boolean }): string {
  return noteRequiresSensitiveAccess(note) ? "SENSITIVE_NOTE" : "NOTE";
}
