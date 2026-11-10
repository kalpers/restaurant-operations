import type { Database } from "@/db";
import { assertVersionMatched } from "@/db/helpers/versioning";
import { withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import {
  AuthenticationError,
  BusinessRuleError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";

import {
  generateTemporaryPassword,
  hashPassword,
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  verifyPassword,
} from "../password";
import { deleteThrottle } from "../repositories/login-throttle-repository";
import { findUserPermissionCodes } from "../repositories/role-repository";
import {
  findPasswordHashById,
  findUserAccountById,
  hasAssignmentAtLocation,
  updateUserPassword,
} from "../repositories/user-repository";
import type { Actor } from "../types";
import { writeAccessAudit } from "./credential-service";
import { isThrottled, recordSignInFailure, throttleKeysFor } from "./login-throttle";
import { assertActorHolds } from "./security-rules";
import { assertCanManageUsers } from "./user-service";

// Password lifecycle (Phase 16 policies 18-23). No email, reset link or token: recovery is
// an administrator's reset, or `bootstrap:owner` for the last Owner. Passwords, hashes and
// the temporary password are never logged or audited.

function assertNewPasswordLength(password: string): void {
  if (password.length < MINIMUM_PASSWORD_LENGTH || password.length > MAXIMUM_PASSWORD_LENGTH) {
    throw new ValidationError(`The new password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }
}

/**
 * Changes the signed-in user's own password. A wrong current password counts toward the
 * account's sign-in throttle, and a locked account can't change it until the lock ends. On
 * success the hash is replaced, `password_changed_at` set (ending every older session), the
 * forced-change flag cleared, the version bumped and the account's throttle cleared, with
 * `auth.password-changed`, in one transaction. Returns the change instant, for the caller's
 * fresh session.
 */
export async function changeOwnPassword(
  database: Database,
  userId: string,
  input: { currentPassword: string; newPassword: string },
  options: { now?: () => Date } = {},
): Promise<{ passwordChangedAt: Date; version: number }> {
  assertNewPasswordLength(input.newPassword);

  const user = await findPasswordHashById(database, userId);

  if (!user) {
    throw new AuthenticationError();
  }

  const now = options.now?.() ?? new Date();
  const keys = throttleKeysFor(user.normalizedEmail, null);

  if (await isThrottled(database, keys, now)) {
    throw new BusinessRuleError(
      "ACCOUNT_TEMPORARILY_LOCKED",
      "Too many incorrect attempts. Try again later.",
    );
  }

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    const { accountLocked } = await recordSignInFailure(database, keys, now);

    if (accountLocked) {
      await withTransaction(database, (transaction) =>
        writeAccessAudit(transaction, userId, "auth.account-locked", null),
      );
    }

    throw new BusinessRuleError("CURRENT_PASSWORD_INCORRECT", "The current password is incorrect.");
  }

  if (input.newPassword === input.currentPassword) {
    throw new BusinessRuleError("PASSWORD_UNCHANGED", "Choose a password different from the current one.");
  }

  // Hashing is slow, so it happens before the transaction opens.
  const passwordHash = await hashPassword(input.newPassword);

  return withTransaction(database, async (transaction) => {
    const [updated] = await updateUserPassword(transaction, {
      userId,
      passwordHash,
      mustChangePassword: false,
    });

    if (!updated?.passwordChangedAt) {
      throw new AuthenticationError();
    }

    await deleteThrottle(transaction, keys.account);
    await writeAccessAudit(transaction, userId, "auth.password-changed", null);

    return { passwordChangedAt: updated.passwordChangedAt, version: updated.version };
  });
}

/**
 * An administrator's reset (Phase 16 policy 20). Generates a random 16-character temporary
 * password and returns it once, for handing over in person; only its hash is kept. Sets the
 * forced-change flag and `password_changed_at` (ending the user's sessions), clears any
 * lockout, and records `admin.user-password-reset` with no details. Not for the actor's own
 * account, and subject to the no-escalation rule and the user's version.
 */
export async function resetUserPassword(
  database: Database,
  actor: Actor,
  input: { userId: string; expectedVersion: number },
): Promise<{ id: string; version: number; temporaryPassword: string }> {
  assertCanManageUsers(actor);

  if (input.userId === actor.userId) {
    throw new BusinessRuleError(
      "SELF_PASSWORD_RESET_NOT_ALLOWED",
      "Use Change password for your own account.",
    );
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  return withTransaction(database, async (transaction) => {
    const user = await findUserAccountById(transaction, input.userId);

    if (!user || !(await hasAssignmentAtLocation(transaction, input.userId, actor.locationId))) {
      throw new NotFoundError("user");
    }

    assertActorHolds(actor, await findUserPermissionCodes(transaction, input.userId));

    const updated = assertVersionMatched(
      await updateUserPassword(transaction, {
        userId: input.userId,
        passwordHash,
        mustChangePassword: true,
        expectedVersion: input.expectedVersion,
      }),
      { type: "user", id: input.userId },
    );

    await deleteThrottle(transaction, throttleKeysFor(user.normalizedEmail, null).account);
    await recordAudit(transaction, actor, { action: "admin.user-password-reset", entityId: input.userId });

    return { id: input.userId, version: updated.version, temporaryPassword };
  });
}
