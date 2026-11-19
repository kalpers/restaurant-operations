import { BusinessRuleError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

// Phase 32 pre-shift note rules (policies 7–9). Pure, so they are unit-tested on their own.

/** How far ahead a note may be written (policy 7). */
export const NOTE_DAYS_AHEAD = 14;

/** Policy 7: a note is for today's business date or up to 14 days ahead. */
export function assertNoteDate(businessDate: string, today: string): void {
  if (businessDate < today) {
    throw new BusinessRuleError("NOTE_DATE_PASSED", "Pre-shift notes are for today or a later date.");
  }

  if (businessDate > addDays(today, NOTE_DAYS_AHEAD)) {
    throw new BusinessRuleError("NOTE_DATE_TOO_FAR", `Write notes up to ${NOTE_DAYS_AHEAD} days ahead.`);
  }
}

/** Policy 8: a note can be edited or withdrawn until its date has passed. */
export function assertNoteEditable(noteDate: string, today: string): void {
  if (noteDate < today) {
    throw new BusinessRuleError("NOTE_READ_ONLY", "This note's date has passed, so it can't be changed.");
  }
}

export type NoteForFilter = {
  active: boolean;
  businessDate: string;
  pinned: boolean;
  createdAt: Date;
  positionIds: readonly string[];
};

/**
 * Policy 9: what a reader sees on a date: active notes for everyone, plus those for a
 * position the reader holds. Pinned first, then oldest first. Relevance, not access control.
 */
export function notesForReader<Note extends NoteForFilter>(
  notes: readonly Note[],
  businessDate: string,
  heldPositionIds: ReadonlySet<string>,
): Note[] {
  return notes
    .filter(
      (note) =>
        note.active &&
        note.businessDate === businessDate &&
        (note.positionIds.length === 0 || note.positionIds.some((id) => heldPositionIds.has(id))),
    )
    .sort(compareNotes);
}

/** Pinned first, then by when they were written. */
export function compareNotes(a: NoteForFilter, b: NoteForFilter): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }

  return a.createdAt.getTime() - b.createdAt.getTime();
}
