import { getServerSession } from "next-auth/next";

import { getAuthOptions } from "./auth-options";

/** The signed-in user's ID from the session token. Grants nothing by itself. */
export async function getSessionUserId(): Promise<string | null> {
  const session = await getServerSession(getAuthOptions());
  const user = session?.user as { id?: string } | undefined;

  return user?.id ?? null;
}
