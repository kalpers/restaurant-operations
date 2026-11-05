import { assertVersionMatched } from "@/db/helpers/versioning";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";

import {
  findDisciplinaryRows,
  findReviewRows,
  insertDisciplinaryAction,
  insertReview,
  updateDisciplinaryRow,
  updateReviewRow,
} from "../repositories/hr-record-repository";
import { assertEffectiveRange } from "../rules/employee-rules";
import { assertPermission, requireEmployee } from "./access";

type ReviewInput = {
  reviewPeriodStart: string;
  reviewPeriodEnd: string;
  reviewDate: string;
  status: string;
  overallRating: number | null;
  summary: string | null;
  employeeComments: string | null;
};

export async function listPerformanceReviews(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
) {
  assertPermission(actor, "hr.performance.view");
  await requireEmployee(executor, actor, employeeId);

  return findReviewRows(executor, employeeId);
}

export async function addPerformanceReview(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
  input: ReviewInput,
) {
  assertPermission(actor, "hr.performance.manage");
  assertEffectiveRange(input.reviewPeriodStart, input.reviewPeriodEnd);
  await requireEmployee(executor, actor, employeeId);

  return insertReview(executor, {
    ...input,
    employeeId,
    reviewerUserId: actor.userId,
  });
}

export async function updatePerformanceReview(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    employeeId: string;
    reviewId: string;
    expectedVersion: number;
    changes: ReviewInput;
  },
) {
  assertPermission(actor, "hr.performance.manage");
  assertEffectiveRange(
    input.changes.reviewPeriodStart,
    input.changes.reviewPeriodEnd,
  );
  await requireEmployee(executor, actor, input.employeeId);

  return assertVersionMatched(
    await updateReviewRow(executor, input, input.changes),
    { type: "performance review", id: input.reviewId },
  );
}

type DisciplinaryInput = {
  actionType: string;
  incidentDate: string | null;
  actionDate: string;
  description: string;
  actionTaken: string;
  followUpDate: string | null;
};

export async function listDisciplinaryActions(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
) {
  assertPermission(actor, "hr.disciplinary.view");
  await requireEmployee(executor, actor, employeeId);

  return findDisciplinaryRows(executor, employeeId);
}

function assertDisciplinaryDates(input: DisciplinaryInput): void {
  if (input.incidentDate !== null) {
    assertEffectiveRange(input.incidentDate, input.actionDate);
  }
}

export async function addDisciplinaryAction(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
  input: DisciplinaryInput,
) {
  assertPermission(actor, "hr.disciplinary.manage");
  assertDisciplinaryDates(input);
  await requireEmployee(executor, actor, employeeId);

  return insertDisciplinaryAction(executor, {
    ...input,
    employeeId,
    createdByUserId: actor.userId,
  });
}

export async function updateDisciplinaryAction(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    employeeId: string;
    actionId: string;
    expectedVersion: number;
    changes: DisciplinaryInput;
  },
) {
  assertPermission(actor, "hr.disciplinary.manage");
  assertDisciplinaryDates(input.changes);
  await requireEmployee(executor, actor, input.employeeId);

  return assertVersionMatched(
    await updateDisciplinaryRow(executor, input, input.changes),
    { type: "disciplinary action", id: input.actionId },
  );
}
