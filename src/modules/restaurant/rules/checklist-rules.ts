import type { ChecklistItemState, ChecklistKind, ChecklistRunStatus } from "@/db/schema/checklists";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Phase 36 part 1 (policy 5): checklist rules. Pure, so they are unit-tested on their own.

/** The longest range the history covers at once. */
export const MAX_CHECKLIST_HISTORY_DAYS = 31;

export type RunItemFacts = { required: boolean; state: ChecklistItemState };

/** Policy 5: a run is completed only once no required item is still open. */
export function assertCanComplete(items: readonly RunItemFacts[]): void {
  const open = items.filter((item) => item.required && item.state === "OPEN").length;

  if (open > 0) {
    throw new BusinessRuleError(
      "CHECKLIST_INCOMPLETE",
      open === 1 ? "One required item is still open." : `${open} required items are still open.`,
    );
  }
}

/** Runs are worked on only for the current business date; earlier ones are read-only. */
export function assertRunWorkable(run: { status: ChecklistRunStatus; businessDate: string }, today: string): void {
  if (run.status !== "OPEN") {
    throw new BusinessRuleError("CHECKLIST_COMPLETED", "This checklist has been completed.");
  }

  if (run.businessDate !== today) {
    throw new BusinessRuleError("CHECKLIST_READ_ONLY", "Checklists from earlier days can't be changed.");
  }
}

/** A skip needs a reason of 1 to 200 characters. */
export function skipReasonOf(reason: string | null | undefined): string {
  const trimmed = (reason ?? "").trim();

  if (!trimmed || trimmed.length > 200) {
    throw new BusinessRuleError("SKIP_REASON_REQUIRED", "Say why the item was skipped, in up to 200 characters.");
  }

  return trimmed;
}

/**
 * Policy 5: undoing a tick (back to open, or from done to skipped and back) is for the person
 * who ticked it or a manager.
 */
export function canChangeTick(item: { state: ChecklistItemState; actedByUserId: string | null }, userId: string, isManager: boolean): boolean {
  return item.state === "OPEN" || isManager || item.actedByUserId === userId;
}

/** A side-work run is its owner's; managers act on anyone's. */
export function canWorkRun(run: { kind: ChecklistKind; employeeId: string | null }, actorEmployeeId: string | null, isManager: boolean): boolean {
  return run.kind !== "SIDE_WORK" || isManager || (actorEmployeeId !== null && run.employeeId === actorEmployeeId);
}

/** Sign-off is by a manager other than the one who completed it. */
export function assertCanSignOff(
  run: { status: ChecklistRunStatus; requiresSignOff: boolean; signedOffAt: Date | null; completedByUserId: string | null },
  userId: string,
): void {
  if (!run.requiresSignOff) {
    throw new BusinessRuleError("SIGN_OFF_NOT_REQUIRED", "This checklist doesn't need signing off.");
  }

  if (run.status !== "COMPLETED") {
    throw new BusinessRuleError("CHECKLIST_NOT_COMPLETED", "Complete the checklist before signing it off.");
  }

  if (run.signedOffAt) {
    throw new BusinessRuleError("ALREADY_SIGNED_OFF", "This checklist has already been signed off.");
  }

  if (run.completedByUserId === userId) {
    throw new BusinessRuleError("SIGN_OFF_BY_ANOTHER", "Someone other than the person who completed it signs it off.");
  }
}

export type DisplayStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "NOT_COMPLETED"
  | "AWAITING_SIGN_OFF"
  | "COMPLETED"
  | "SIGNED_OFF";

/** Policy 5: what a run (or its absence) means on a date, worked out on read and never stored. */
export function displayStatus(
  run: { status: ChecklistRunStatus; requiresSignOff: boolean; signedOffAt: Date | null; businessDate: string } | null,
  today: string,
): DisplayStatus {
  if (!run) {
    return "NOT_STARTED";
  }

  if (run.status === "OPEN") {
    return run.businessDate < today ? "NOT_COMPLETED" : "IN_PROGRESS";
  }

  if (run.requiresSignOff) {
    return run.signedOffAt ? "SIGNED_OFF" : "AWAITING_SIGN_OFF";
  }

  return "COMPLETED";
}

/** Relevance (not access): a template for no positions is everyone's; otherwise one held here. */
export function isTemplateRelevant(positionIds: readonly string[], heldPositionIds: ReadonlySet<string>): boolean {
  return positionIds.length === 0 || positionIds.some((id) => heldPositionIds.has(id));
}

/** Business dates from `from` to `to`, inclusive, newest first. */
export function datesDescending(from: string, to: string): string[] {
  const dates: string[] = [];
  const start = Date.parse(`${from}T00:00:00.000Z`);

  for (let at = Date.parse(`${to}T00:00:00.000Z`); at >= start; at -= 86_400_000) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }

  return dates;
}
