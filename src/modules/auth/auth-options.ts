import type { AuthOptions, Session } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

import { getAuthConfig } from "@/config/auth-env";
import { getDatabase } from "@/db";
import { writeLog } from "@/infrastructure/logging/logger";

import { verifyCredentials } from "./services/credential-service";
import { credentialsSchema } from "./validators/auth-validators";

export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * The token carries only the user ID. Everything about what the user may do is read
 * from the database on each request.
 */
export const sessionCallbacks: NonNullable<AuthOptions["callbacks"]> = {
  jwt: ({ token, user }) => ({ sub: user?.id ?? token.sub }),
  session: ({ session, token }) =>
    ({ expires: session.expires, user: { id: token.sub } }) as Session,
};

/** Built on use, because `next build` imports this module without runtime variables. */
export function getAuthOptions(): AuthOptions {
  const { secret, secureCookies } = getAuthConfig();

  return {
    secret,
    useSecureCookies: secureCookies,
    session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
    pages: { signIn: "/login", error: "/login" },
    callbacks: sessionCallbacks,
    // The library's own logging can include request metadata, so only its code is kept.
    logger: {
      error: (code) =>
        writeLog({
          severity: "error",
          module: "auth",
          operation: "next-auth",
          message: "Authentication library error",
          errorCode: code,
        }),
      warn: () => {},
      debug: () => {},
    },
    providers: [
      CredentialsProvider({
        name: "Email and password",
        credentials: {
          email: { type: "email" },
          password: { type: "password" },
        },
        authorize: async (submitted) => {
          const parsed = credentialsSchema.safeParse(submitted);

          return parsed.success
            ? verifyCredentials(getDatabase(), parsed.data)
            : null;
        },
      }),
    ],
  };
}
