import type { Database } from "@/db";
import { type DatabaseTransaction, withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";

import { normalizeEmail } from "../email";
import {
  MAXIMUM_PASSWORD_LENGTH,
  verifyAgainstDummyHash,
  verifyPassword,
} from "../password";
import { deleteThrottle } from "../repositories/login-throttle-repository";
import {
  findCredentialsByNormalizedEmail,
  findUserOrganizationIds,
  recordLogin,
} from "../repositories/user-repository";
import { isThrottled, recordSignInFailure, throttleKeysFor } from "./login-throttle";

export type VerifyCredentialsOptions = {
  deferFailureAudit?: (task: () => Promise<void>) => void;
  /** The client IP from a trusted proxy header; ignored unless one is configured. */
  clientIp?: string | null;
  /** For tests with a controlled clock. */
  now?: () => Date;
};

/**
 * Returns the user's ID, or null for every kind of failure: unknown email, disabled
 * account, wrong password or a locked throttle key. Callers can't tell them apart, by design.
 *
 * Sign-ins to a known account are audited: success, or failure with its reason. The typed
 * email and password are never recorded, and an unknown email writes nothing.
 *
 * Throttling (Phase 16): every failure, unknown emails included, counts toward its key with
 * one atomic upsert. While a key is locked the password is not checked, even if correct, but
 * a dummy verification still runs, so the answer and its timing are the same as any failure.
 * A known account's lock is audited once, when it happens.
 *
 * A failure's audit writes are handed to `deferFailureAudit`, which the sign-in route runs
 * after the response is sent. A failed sign-in to a real account then answers in the same
 * time as an unknown email, so timing doesn't reveal which accounts exist. Without it (tests,
 * scripts) the writes happen inline.
 */
export async function verifyCredentials(
  database: Database,
  credentials: { email: string; password: string },
  options: VerifyCredentialsOptions = {},
): Promise<{ id: string } | null> {
  if (credentials.password.length > MAXIMUM_PASSWORD_LENGTH) {
    return null;
  }

  const now = options.now?.() ?? new Date();
  const normalizedEmail = normalizeEmail(credentials.email);
  const keys = throttleKeysFor(normalizedEmail, options.clientIp);

  // Both reads always run, so a locked key does the same work as an unlocked one.
  const [locked, user] = await Promise.all([
    isThrottled(database, keys, now),
    findCredentialsByNormalizedEmail(database, normalizedEmail),
  ]);

  const failed = async (userId: string | null, reason: "DISABLED" | "BAD_PASSWORD" | null) => {
    const { accountLocked } = await recordSignInFailure(database, keys, now);

    if (!userId) {
      return;
    }

    const task = async () => {
      if (reason) {
        await auditAccess(database, userId, "auth.sign-in-failed", reason);
      }

      if (accountLocked) {
        await auditAccess(database, userId, "auth.account-locked", null);
      }
    };

    if (options.deferFailureAudit) {
      options.deferFailureAudit(task);
    } else {
      await task();
    }
  };

  if (locked) {
    await verifyAgainstDummyHash(credentials.password);
    return null;
  }

  if (!user) {
    await verifyAgainstDummyHash(credentials.password);
    await failed(null, null);
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
    await deleteThrottle(transaction, keys.account);
    await writeAccessAudit(transaction, user.id, "auth.signed-in", null);
  });

  return { id: user.id };
}

/** Records a sign-out for a user whose session is ending. */
export async function recordSignOut(database: Database, userId: string): Promise<void> {
  await auditAccess(database, userId, "auth.signed-out", null);
}

type AccessAction = "auth.signed-in" | "auth.sign-in-failed" | "auth.signed-out" | "auth.account-locked";

function auditAccess(
  database: Database,
  userId: string,
  action: AccessAction,
  reason: "DISABLED" | "BAD_PASSWORD" | null,
): Promise<void> {
  return withTransaction(database, (transaction) => writeAccessAudit(transaction, userId, action, reason));
}

/** Writes an organization-level access or lock event for each organization the user is in. */
export async function writeAccessAudit(
  transaction: DatabaseTransaction,
  userId: string,
  action: AccessAction | "auth.password-changed",
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
