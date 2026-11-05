import { and, asc, eq } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import { certificationTypes, positions } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

const POSITION_COLUMNS = {
  id: positions.id,
  code: positions.code,
  name: positions.name,
  description: positions.description,
  active: positions.active,
  version: positions.version,
};

export function findPositions(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .select(POSITION_COLUMNS)
    .from(positions)
    .where(eq(positions.organizationId, organizationId))
    .orderBy(asc(positions.name));
}

export async function findPositionInOrganization(
  executor: DatabaseExecutor,
  positionId: string,
  organizationId: string,
) {
  const [position] = await executor
    .select(POSITION_COLUMNS)
    .from(positions)
    .where(
      and(
        eq(positions.id, positionId),
        eq(positions.organizationId, organizationId),
      ),
    );

  return position;
}

export async function insertPosition(
  executor: DatabaseExecutor,
  values: {
    organizationId: string;
    code: string;
    name: string;
    description: string | null;
  },
) {
  const [position] = await executor
    .insert(positions)
    .values(values)
    .returning(POSITION_COLUMNS);

  if (!position) {
    throw new Error("Position insert returned no row.");
  }

  return position;
}

/** Returns no rows when the version is stale or it belongs to another organization. */
export function updatePositionRow(
  executor: DatabaseExecutor,
  input: { positionId: string; organizationId: string; expectedVersion: number },
  changes: { name: string; description: string | null; active: boolean },
) {
  return executor
    .update(positions)
    .set({ ...changes, version: nextVersion(positions.version) })
    .where(
      and(
        eq(positions.id, input.positionId),
        eq(positions.organizationId, input.organizationId),
        eq(positions.version, input.expectedVersion),
      ),
    )
    .returning(POSITION_COLUMNS);
}

const CERTIFICATION_TYPE_COLUMNS = {
  id: certificationTypes.id,
  code: certificationTypes.code,
  name: certificationTypes.name,
  description: certificationTypes.description,
  expirationRequired: certificationTypes.expirationRequired,
  warningDays: certificationTypes.warningDays,
  active: certificationTypes.active,
  version: certificationTypes.version,
};

export function findCertificationTypes(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .select(CERTIFICATION_TYPE_COLUMNS)
    .from(certificationTypes)
    .where(eq(certificationTypes.organizationId, organizationId))
    .orderBy(asc(certificationTypes.name));
}

export async function findCertificationTypeInOrganization(
  executor: DatabaseExecutor,
  certificationTypeId: string,
  organizationId: string,
) {
  const [type] = await executor
    .select(CERTIFICATION_TYPE_COLUMNS)
    .from(certificationTypes)
    .where(
      and(
        eq(certificationTypes.id, certificationTypeId),
        eq(certificationTypes.organizationId, organizationId),
      ),
    );

  return type;
}

type CertificationTypeFields = {
  name: string;
  description: string | null;
  expirationRequired: boolean;
  warningDays: number | null;
};

export async function insertCertificationType(
  executor: DatabaseExecutor,
  values: CertificationTypeFields & { organizationId: string; code: string },
) {
  const [type] = await executor
    .insert(certificationTypes)
    .values(values)
    .returning(CERTIFICATION_TYPE_COLUMNS);

  if (!type) {
    throw new Error("Certification type insert returned no row.");
  }

  return type;
}

/** Returns no rows when the version is stale or it belongs to another organization. */
export function updateCertificationTypeRow(
  executor: DatabaseExecutor,
  input: {
    certificationTypeId: string;
    organizationId: string;
    expectedVersion: number;
  },
  changes: CertificationTypeFields & { active: boolean },
) {
  return executor
    .update(certificationTypes)
    .set({ ...changes, version: nextVersion(certificationTypes.version) })
    .where(
      and(
        eq(certificationTypes.id, input.certificationTypeId),
        eq(certificationTypes.organizationId, input.organizationId),
        eq(certificationTypes.version, input.expectedVersion),
      ),
    )
    .returning(CERTIFICATION_TYPE_COLUMNS);
}
