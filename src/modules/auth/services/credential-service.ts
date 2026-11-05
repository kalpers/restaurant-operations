import type { Database } from "@/db";

import { normalizeEmail } from "../email";
import {
  MAXIMUM_PASSWORD_LENGTH,
  verifyAgainstDummyHash,
  verifyPassword,
} from "../password";
import {
  findCredentialsByNormalizedEmail,
  recordLogin,
} from "../repositories/user-repository";

/**
 * Returns the user's ID, or null for every kind of failure: unknown email, disabled
 * account or wrong password. Callers can't tell them apart, by design.
 */
export async function verifyCredentials(
  database: Database,
  credentials: { email: string; password: string },
): Promise<{ id: string } | null> {
  if (credentials.password.length > MAXIMUM_PASSWORD_LENGTH) {
    return null;
  }

  const user = await findCredentialsByNormalizedEmail(
    database,
    normalizeEmail(credentials.email),
  );

  if (!user?.active) {
    await verifyAgainstDummyHash(credentials.password);
    return null;
  }

  if (!(await verifyPassword(user.passwordHash, credentials.password))) {
    return null;
  }

  await recordLogin(database, user.id);

  return { id: user.id };
}
