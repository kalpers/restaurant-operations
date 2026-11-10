import { getServerSession } from "next-auth/next";

import { getAuthOptions } from "./auth-options";

export type SessionIdentity = {
  userId: string;
  /** The sign-in instant in milliseconds; absent on tokens from before Phase 16. */
  authTime?: number;
};

/** The signed-in user's ID and sign-in instant from the session token. Grants nothing by itself. */
export async function getSessionIdentity(): Promise<SessionIdentity | null> {
  const session = await getServerSession(getAuthOptions());
  const user = session?.user as { id?: string } | undefined;
  const authTime = (session as { authTime?: unknown } | null)?.authTime;

  if (!user?.id) {
    return null;
  }

  return typeof authTime === "number" ? { userId: user.id, authTime } : { userId: user.id };
}

/** The signed-in user's ID from the session token. Grants nothing by itself. */
export async function getSessionUserId(): Promise<string | null> {
  return (await getSessionIdentity())?.userId ?? null;
}
