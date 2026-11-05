import { assertVersionMatched } from "@/db/helpers/versioning";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
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
  await requireEmployee(executor, actor, employeeId);

  return findNoteRows(executor, employeeId, {
    includeSensitive: actorHolds(actor, "hr.notes.sensitive.view"),
  });
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

  await requireEmployee(executor, actor, employeeId);

  return insertNote(executor, {
    ...input,
    employeeId,
    createdByUserId: actor.userId,
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
  await requireEmployee(executor, actor, input.employeeId);

  const note = await findNoteById(executor, input.employeeId, input.noteId);

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

  return assertVersionMatched(
    await updateNoteRow(
      executor,
      note.id,
      input.expectedVersion,
      input.changes,
    ),
    { type: "note", id: note.id },
  );
}
