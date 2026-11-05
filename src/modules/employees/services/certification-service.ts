import type { Database } from "@/db";
import {
  withTransaction,
  type DatabaseExecutor,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  BusinessRuleError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";

import {
  documentBelongsToEmployee,
  findCertificationById,
  findCertificationRows,
  insertCertification,
  markCertificationVerified,
  updateCertificationRow,
} from "../repositories/hr-record-repository";
import { findCertificationTypeInOrganization } from "../repositories/reference-repository";
import { assertCertificationDates } from "../rules/employee-rules";
import { assertPermission, lockEmployee, requireEmployee } from "./access";

export async function listCertifications(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
) {
  assertPermission(actor, "hr.certifications.view");
  await requireEmployee(executor, actor, employeeId);

  return findCertificationRows(executor, employeeId);
}

type CertificationDetails = {
  certificationNumber: string | null;
  issuedDate: string | null;
  expirationDate: string | null;
  documentId: string | null;
};

async function assertDocumentIsEmployees(
  executor: DatabaseExecutor,
  employeeId: string,
  documentId: string | null,
): Promise<void> {
  if (
    documentId &&
    !(await documentBelongsToEmployee(executor, employeeId, documentId))
  ) {
    throw new ValidationError("The document must belong to this employee.");
  }
}

export async function addCertification(
  database: Database,
  actor: Actor,
  employeeId: string,
  input: CertificationDetails & { certificationTypeId: string },
) {
  assertPermission(actor, "hr.certifications.manage");

  return withTransaction(database, async (transaction) => {
    await lockEmployee(transaction, actor, employeeId);

    const type = await findCertificationTypeInOrganization(
      transaction,
      input.certificationTypeId,
      actor.organizationId,
    );

    if (!type?.active) {
      throw new ValidationError("Choose an active certification type.");
    }

    assertCertificationDates({ ...input, ...type });
    await assertDocumentIsEmployees(transaction, employeeId, input.documentId);

    return insertCertification(transaction, { ...input, employeeId });
  });
}

/** Changing the details clears verification, because no one has checked the new values. */
export async function updateCertification(
  database: Database,
  actor: Actor,
  input: {
    employeeId: string;
    certificationId: string;
    details: CertificationDetails;
  },
): Promise<void> {
  assertPermission(actor, "hr.certifications.manage");

  await withTransaction(database, async (transaction) => {
    await lockEmployee(transaction, actor, input.employeeId);

    const certification = await findCertificationById(
      transaction,
      input.employeeId,
      input.certificationId,
    );

    if (!certification) {
      throw new NotFoundError("certification");
    }

    const type = await findCertificationTypeInOrganization(
      transaction,
      certification.certificationTypeId,
      actor.organizationId,
    );

    assertCertificationDates({
      ...input.details,
      expirationRequired: type?.expirationRequired ?? false,
    });
    await assertDocumentIsEmployees(
      transaction,
      input.employeeId,
      input.details.documentId,
    );

    await updateCertificationRow(transaction, certification.id, input.details);
  });
}

/** Records who verified and when, together. No outside service is contacted. */
export async function verifyCertification(
  database: Database,
  actor: Actor,
  input: { employeeId: string; certificationId: string },
): Promise<void> {
  assertPermission(actor, "hr.certifications.manage");

  await withTransaction(database, async (transaction) => {
    await lockEmployee(transaction, actor, input.employeeId);

    const certification = await findCertificationById(
      transaction,
      input.employeeId,
      input.certificationId,
    );

    if (!certification) {
      throw new NotFoundError("certification");
    }

    if (certification.verified) {
      throw new BusinessRuleError(
        "CERTIFICATION_ALREADY_VERIFIED",
        "This certification is already verified.",
      );
    }

    await markCertificationVerified(
      transaction,
      certification.id,
      actor.userId,
    );
  });
}
