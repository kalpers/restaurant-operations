import type { Database } from "@/db";
import { type DatabaseTransaction, withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";

import { normalizeEmail } from "../email";
import {
  MAXIMUM_PASSWORD_LENGTH,
  verifyAgainstDummyHash,
  verifyPassword,
} from "../password";
import {
  findCredentialsByNormalizedEmail,
  findUserOrganizationIds,
  recordLogin,
} from "../repositories/user-repository";

/**
 * Returns the user's ID, or null for every kind of failure: unknown email, disabled
 * account or wrong password. Callers can't tell them apart, by design.
 *
 * Sign-ins to a known account are audited: success, or failure with its reason. The typed
 * email and password are never recorded, and an unknown email writes nothing.
 *
 * A failure's audit write is handed to `deferFailureAudit`, which the sign-in route runs
 * after the response is sent. A failed sign-in to a real account then answers in the same
 * time as an unknown email, so timing doesn't reveal which accounts exist. Without it (tests,
 * scripts) the write happens inline.
 */
export async function verifyCredentials(
  database: Database,
  credentials: { email: string; password: string },
  options: { deferFailureAudit?: (task: () => Promise<void>) => void } = {},
): Promise<{ id: string } | null> {
  const failed = async (userId: string, reason: "DISABLED" | "BAD_PASSWORD") => {
    const task = () => auditAccess(database, userId, "auth.sign-in-failed", reason);

    if (options.deferFailureAudit) {
      options.deferFailureAudit(task);
    } else {
      await task();
    }
  };

  if (credentials.password.length > MAXIMUM_PASSWORD_LENGTH) {
    return null;
  }

  const user = await findCredentialsByNormalizedEmail(
    database,
    normalizeEmail(credentials.email),
  );

  if (!user) {
    await verifyAgainstDummyHash(credentials.password);
    return null;
  }

  if (!user.active) {
    await verifyAgainstDummyHash(credentials.password);
    await failed(user.id, "DISABLED");
    return null;
  }

  if (!(await verifyPassword(user.passwordHash, credentials.password))) {
    await failed(user.id, "BAD_PASSWORD");
    return null;
  }

  await withTransaction(database, async (transaction) => {
    await recordLogin(transaction, user.id);
    await writeAccessAudit(transaction, user.id, "auth.signed-in", null);
  });

  return { id: user.id };
}

/** Records a sign-out for a user whose session is ending. */
export async function recordSignOut(database: Database, userId: string): Promise<void> {
  await auditAccess(database, userId, "auth.signed-out", null);
}

type AccessAction = "auth.signed-in" | "auth.sign-in-failed" | "auth.signed-out";

function auditAccess(
  database: Database,
  userId: string,
  action: AccessAction,
  reason: "DISABLED" | "BAD_PASSWORD" | null,
): Promise<void> {
  return withTransaction(database, (transaction) => writeAccessAudit(transaction, userId, action, reason));
}

async function writeAccessAudit(
  transaction: DatabaseTransaction,
  userId: string,
  action: AccessAction,
  reason: "DISABLED" | "BAD_PASSWORD" | null,
): Promise<void> {
  // Access events are organization-level; a user in several organizations gets one each.
  for (const organizationId of await findUserOrganizationIds(transaction, userId)) {
    await recordAudit(transaction, { userId, organizationId, locationId: null }, {
      action,
      entityId: userId,
      details: reason ? { reason } : null,
    });
  }
}
