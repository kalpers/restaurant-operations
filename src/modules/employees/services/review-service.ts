import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  type DatabaseExecutor,
  withExecutorTransaction,
} from "@/db/transactions/transaction-context";
import { auditedRead, recordAudit } from "@/modules/auditing";
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

// Reviews and disciplinary records are restricted HR data: reads and changes are audited
// by record and field name only, never their content.

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

  return auditedRead(
    executor,
    actor,
    { action: "hr.records-viewed", entityId: employeeId, details: { employeeId, kind: "PERFORMANCE" } },
    async (transaction) => {
      await requireEmployee(transaction, actor, employeeId);

      return findReviewRows(transaction, employeeId);
    },
  );
}

export async function addPerformanceReview(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
  input: ReviewInput,
) {
  assertPermission(actor, "hr.performance.manage");
  assertEffectiveRange(input.reviewPeriodStart, input.reviewPeriodEnd);

  return withExecutorTransaction(executor, async (transaction) => {
    await requireEmployee(transaction, actor, employeeId);

    const review = await insertReview(transaction, {
      ...input,
      employeeId,
      reviewerUserId: actor.userId,
    });

    await recordAudit(transaction, actor, {
      action: "hr.record-created",
      entityId: employeeId,
      details: { employeeId, recordId: review.id, kind: "PERFORMANCE", status: input.status },
    });

    return review;
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

  return withExecutorTransaction(executor, async (transaction) => {
    await requireEmployee(transaction, actor, input.employeeId);

    const result = assertVersionMatched(
      await updateReviewRow(transaction, input, input.changes),
      { type: "performance review", id: input.reviewId },
    );

    await recordAudit(transaction, actor, {
      action: "hr.record-updated",
      entityId: input.employeeId,
      details: {
        employeeId: input.employeeId,
        recordId: input.reviewId,
        kind: "PERFORMANCE",
        status: input.changes.status,
        changedFields: Object.keys(input.changes),
      },
    });

    return result;
  });
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

  return auditedRead(
    executor,
    actor,
    { action: "hr.records-viewed", entityId: employeeId, details: { employeeId, kind: "DISCIPLINARY" } },
    async (transaction) => {
      await requireEmployee(transaction, actor, employeeId);

      return findDisciplinaryRows(transaction, employeeId);
    },
  );
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

  return withExecutorTransaction(executor, async (transaction) => {
    await requireEmployee(transaction, actor, employeeId);

    const action = await insertDisciplinaryAction(transaction, {
      ...input,
      employeeId,
      createdByUserId: actor.userId,
    });

    await recordAudit(transaction, actor, {
      action: "hr.record-created",
      entityId: employeeId,
      details: { employeeId, recordId: action.id, kind: "DISCIPLINARY" },
    });

    return action;
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

  return withExecutorTransaction(executor, async (transaction) => {
    await requireEmployee(transaction, actor, input.employeeId);

    const result = assertVersionMatched(
      await updateDisciplinaryRow(transaction, input, input.changes),
      { type: "disciplinary action", id: input.actionId },
    );

    await recordAudit(transaction, actor, {
      action: "hr.record-updated",
      entityId: input.employeeId,
      details: {
        employeeId: input.employeeId,
        recordId: input.actionId,
        kind: "DISCIPLINARY",
        changedFields: Object.keys(input.changes),
      },
    });

    return result;
  });
}
