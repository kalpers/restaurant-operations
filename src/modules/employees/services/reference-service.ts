import { isUniqueViolation } from "@/db/helpers/database-errors";
import { assertVersionMatched } from "@/db/helpers/versioning";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, ConflictError } from "@/shared/errors/app-error";

import {
  findCertificationTypes,
  findPositions,
  insertCertificationType,
  insertPosition,
  updateCertificationTypeRow,
  updatePositionRow,
} from "../repositories/reference-repository";
import { actorHolds, assertPermission } from "./access";

async function mapDuplicateCode<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("CODE_ALREADY_EXISTS", "This code already exists.");
    }

    throw error;
  }
}

export async function listPositions(executor: DatabaseExecutor, actor: Actor) {
  if (
    !actorHolds(actor, "employees.view") &&
    !actorHolds(actor, "employees.positions.manage")
  ) {
    throw new AuthorizationError();
  }

  return findPositions(executor, actor.organizationId);
}

export async function createPosition(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { code: string; name: string; description: string | null },
) {
  assertPermission(actor, "employees.positions.manage");

  return mapDuplicateCode(() =>
    insertPosition(executor, {
      ...input,
      organizationId: actor.organizationId,
    }),
  );
}

/** Deactivating stops new assignments and leaves every existing one in place. */
export async function updatePosition(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    positionId: string;
    name: string;
    description: string | null;
    active: boolean;
    expectedVersion: number;
  },
) {
  assertPermission(actor, "employees.positions.manage");

  const { positionId, expectedVersion, ...changes } = input;

  return assertVersionMatched(
    await updatePositionRow(
      executor,
      { positionId, expectedVersion, organizationId: actor.organizationId },
      changes,
    ),
    { type: "position", id: positionId },
  );
}

export async function listCertificationTypes(executor: DatabaseExecutor, actor: Actor) {
  if (
    !actorHolds(actor, "hr.certifications.view") &&
    !actorHolds(actor, "hr.certifications.manage")
  ) {
    throw new AuthorizationError();
  }

  return findCertificationTypes(executor, actor.organizationId);
}

type CertificationTypeInput = {
  name: string;
  description: string | null;
  expirationRequired: boolean;
  warningDays: number | null;
};

export async function createCertificationType(
  executor: DatabaseExecutor,
  actor: Actor,
  input: CertificationTypeInput & { code: string },
) {
  assertPermission(actor, "hr.certifications.manage");

  return mapDuplicateCode(() =>
    insertCertificationType(executor, {
      ...input,
      organizationId: actor.organizationId,
    }),
  );
}

export async function updateCertificationType(
  executor: DatabaseExecutor,
  actor: Actor,
  input: CertificationTypeInput & {
    certificationTypeId: string;
    active: boolean;
    expectedVersion: number;
  },
) {
  assertPermission(actor, "hr.certifications.manage");

  const { certificationTypeId, expectedVersion, ...changes } = input;

  return assertVersionMatched(
    await updateCertificationTypeRow(
      executor,
      {
        certificationTypeId,
        expectedVersion,
        organizationId: actor.organizationId,
      },
      changes,
    ),
    { type: "certification type", id: certificationTypeId },
  );
}
