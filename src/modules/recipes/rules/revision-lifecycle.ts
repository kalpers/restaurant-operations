import { isPositiveDecimal, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Recipe revisions: DRAFT -> PUBLISHED -> RETIRED. Intervals are half-open
// `[effectiveFrom, effectiveTo)`. A published revision's content never changes; only its
// interval can close. At most one revision is in effect at any instant, and a revision
// published later always starts after every earlier one, so history is never rewritten.

export type RevisionStatus = "DRAFT" | "PUBLISHED" | "RETIRED";

export type RevisionRow = {
  id: string;
  revisionNumber: number;
  status: RevisionStatus;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
};

export function assertEditable(status: RevisionStatus): void {
  if (status !== "DRAFT") {
    throw new BusinessRuleError(
      "REVISION_NOT_EDITABLE",
      "Only a draft revision can be changed. Create a new revision instead.",
    );
  }
}

/** Yield is a positive exact quantity with at most four decimal places. */
export function normalizeYield(value: string): string {
  let normalized: string;

  try {
    normalized = toScale(value, 4);
  } catch {
    throw new BusinessRuleError(
      "INVALID_YIELD",
      "Yield must be a number with at most four decimal places.",
    );
  }

  if (!isPositiveDecimal(normalized)) {
    throw new BusinessRuleError("INVALID_YIELD", "Yield must be greater than zero.");
  }

  return normalized;
}

export function nextRevisionNumber(revisions: readonly RevisionRow[]): number {
  return revisions.reduce((highest, row) => Math.max(highest, row.revisionNumber), 0) + 1;
}

export type PublishPlan = {
  effectiveFrom: Date;
  /** The earlier revision whose interval must end where this one begins. */
  closePrior: { id: string; at: Date } | null;
};

/**
 * `requestedFrom` null means "now". A start in the past would rewrite which revision was
 * in effect, so it is refused; a start must also fall after every earlier revision's start.
 */
export function planPublish(
  revisions: readonly RevisionRow[],
  draft: RevisionRow,
  requestedFrom: Date | null,
  now: Date,
): PublishPlan {
  assertEditable(draft.status);

  const effectiveFrom = requestedFrom ?? now;

  if (effectiveFrom.getTime() < now.getTime()) {
    throw new BusinessRuleError(
      "EFFECTIVE_DATE_IN_PAST",
      "A revision can't take effect in the past.",
    );
  }

  const earlier = revisions.filter(
    (row) => row.id !== draft.id && row.status !== "DRAFT" && row.effectiveFrom !== null,
  );

  if (earlier.some((row) => row.effectiveFrom!.getTime() >= effectiveFrom.getTime())) {
    throw new BusinessRuleError(
      "REVISION_ORDER",
      "The new revision must take effect after every earlier revision.",
    );
  }

  const inForce = earlier.find(
    (row) =>
      row.status === "PUBLISHED" &&
      (row.effectiveTo === null || row.effectiveTo.getTime() > effectiveFrom.getTime()),
  );

  return {
    effectiveFrom,
    closePrior: inForce ? { id: inForce.id, at: effectiveFrom } : null,
  };
}

export type RetirePlan = { effectiveTo: Date };

/**
 * Retiring ends the revision now. One that hasn't taken effect yet gets an empty interval
 * (`effectiveTo = effectiveFrom`), which keeps its history without ever being in effect.
 */
export function planRetire(revision: RevisionRow, now: Date): RetirePlan {
  if (revision.status !== "PUBLISHED" || revision.effectiveFrom === null) {
    throw new BusinessRuleError(
      "REVISION_NOT_PUBLISHED",
      "Only a published revision can be retired.",
    );
  }

  if (revision.effectiveFrom.getTime() >= now.getTime()) {
    return { effectiveTo: revision.effectiveFrom };
  }

  if (revision.effectiveTo !== null && revision.effectiveTo.getTime() <= now.getTime()) {
    return { effectiveTo: revision.effectiveTo };
  }

  return { effectiveTo: now };
}

/** The revision in effect at an instant, or null. */
export function resolveRevisionAt<Row extends RevisionRow>(
  revisions: readonly Row[],
  at: Date,
): Row | null {
  const inEffect = revisions.filter(
    (row) =>
      row.status !== "DRAFT" &&
      row.effectiveFrom !== null &&
      row.effectiveFrom.getTime() <= at.getTime() &&
      (row.effectiveTo === null || at.getTime() < row.effectiveTo.getTime()),
  );

  if (inEffect.length > 1) {
    throw new BusinessRuleError(
      "AMBIGUOUS_REVISION",
      "More than one revision is in effect. Contact an administrator.",
    );
  }

  return inEffect[0] ?? null;
}
