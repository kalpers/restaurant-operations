import type { Database } from "@/db";
import { withTransaction } from "@/db/transactions/transaction-context";
import { findLocationsByCode } from "@/modules/organization/repositories/organization-repository";
import { BusinessRuleError, ValidationError } from "@/shared/errors/app-error";

import { normalizeEmail } from "../email";
import {
  hashPassword,
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
} from "../password";
import { findRoleIdByCode } from "../repositories/role-repository";
import {
  activateAssignment,
  findUserStatusByNormalizedEmail,
  insertUserIfAbsent,
} from "../repositories/user-repository";
import { OWNER_ROLE_CODE } from "../role-catalog";

const MAIN_LOCATION_CODE = "MAIN";

export type OwnerBootstrapResult = {
  userCreated: boolean;
  roleAssigned: boolean;
};

/**
 * Creates the first Owner, or gives an existing account the Owner role. It never
 * replaces an existing password and is safe to run again.
 */
export async function bootstrapOwner(
  database: Database,
  input: { email: string; password: string },
): Promise<OwnerBootstrapResult> {
  const normalizedEmail = normalizeEmail(input.email);

  if (!/^[^\s@]+@[^\s@]+$/.test(normalizedEmail)) {
    throw new ValidationError("Enter a valid email address.");
  }

  if (
    input.password.length < MINIMUM_PASSWORD_LENGTH ||
    input.password.length > MAXIMUM_PASSWORD_LENGTH
  ) {
    throw new ValidationError(
      `The password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
    );
  }

  const passwordHash = await hashPassword(input.password);

  return withTransaction(database, async (transaction) => {
    const mainLocations = await findLocationsByCode(
      transaction,
      MAIN_LOCATION_CODE,
    );
    const [location] = mainLocations;
    const roleId = location
      ? await findRoleIdByCode(
          transaction,
          location.organizationId,
          OWNER_ROLE_CODE,
        )
      : undefined;

    if (!location || mainLocations.length > 1 || !roleId) {
      throw new BusinessRuleError(
        "BOOTSTRAP_FOUNDATION_MISSING",
        "The organization, MAIN location or OWNER role isn't set up. Run npm run db:migrate and npm run db:seed first.",
      );
    }

    const newUserId = await insertUserIfAbsent(transaction, {
      email: input.email.normalize("NFKC").trim(),
      normalizedEmail,
      passwordHash,
    });
    const existing = newUserId
      ? undefined
      : await findUserStatusByNormalizedEmail(transaction, normalizedEmail);

    if (existing && !existing.active) {
      throw new BusinessRuleError(
        "BOOTSTRAP_USER_DISABLED",
        "This account is disabled. Bootstrap won't re-enable it.",
      );
    }

    const userId = newUserId ?? existing?.id;

    if (!userId) {
      throw new Error("The account could not be created or found.");
    }

    return {
      userCreated: newUserId !== undefined,
      roleAssigned: await activateAssignment(transaction, {
        userId,
        roleId,
        locationId: location.id,
        assignedByUserId: null,
      }),
    };
  });
}
