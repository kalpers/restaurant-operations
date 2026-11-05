import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { AuthorizationError, BusinessRuleError } from "@/shared/errors/app-error";

import {
  countOtherActiveHolders,
  findRoleIdByCode,
  holdsActiveRole,
} from "../repositories/role-repository";
import { OWNER_ROLE_CODE } from "../role-catalog";
import type { Actor } from "../types";

export const ESCALATION_MESSAGE =
  "You can't change access that includes permissions you don't hold.";

/** No-escalation rule: nobody can grant, remove or affect access they don't hold. */
export function assertActorHolds(actor: Actor, required: Iterable<string>): void {
  for (const code of required) {
    if (!actor.permissions.has(code)) {
      throw new AuthorizationError(ESCALATION_MESSAGE);
    }
  }
}

export function isOwnerRole(role: { code: string }): boolean {
  return role.code === OWNER_ROLE_CODE;
}

/**
 * Stops an organization from losing its last active Owner. Pass a location to exclude
 * one assignment, or none to exclude all of the user's. The row lock on the Owner role
 * makes concurrent removals take turns, so two can't each see the other as remaining.
 * Call this in the transaction that makes the change, before making it.
 */
export async function assertNotLastOwner(
  transaction: DatabaseTransaction,
  request: { organizationId: string; userId: string; locationId?: string },
): Promise<void> {
  const roleId = await findRoleIdByCode(
    transaction,
    request.organizationId,
    OWNER_ROLE_CODE,
    { lock: true },
  );

  if (!roleId) {
    return;
  }

  const key = {
    roleId,
    userId: request.userId,
    locationId: request.locationId,
  };

  if (
    (await holdsActiveRole(transaction, key)) &&
    (await countOtherActiveHolders(transaction, key)) === 0
  ) {
    throw new BusinessRuleError(
      "LAST_OWNER",
      "The organization must keep at least one active Owner.",
    );
  }
}
