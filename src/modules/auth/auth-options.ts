import type { AuthOptions, Session } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { after } from "next/server";

import { getAuthConfig } from "@/config/auth-env";
import { getDatabase } from "@/db";
import { writeLog } from "@/infrastructure/logging/logger";

import { recordSignOut, verifyCredentials } from "./services/credential-service";
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

/**
 * Runs a failed sign-in's audit write after the response is sent, so a known account's
 * failure answers as fast as an unknown email's. A failure to record is logged, never thrown.
 */
function deferFailureAudit(task: () => Promise<void>): void {
  const run = () =>
    task().catch((error: unknown) =>
      writeLog({
        severity: "error",
        module: "auth",
        operation: "sign-in-failure-audit",
        message: "Failed sign-in audit could not be written",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );

  try {
    after(run);
  } catch {
    // Outside a request scope; still never delay the response.
    void run();
  }
}

/** Built on use, because `next build` imports this module without runtime variables. */
export function getAuthOptions(): AuthOptions {
  const { secret, secureCookies } = getAuthConfig();

  return {
    secret,
    useSecureCookies: secureCookies,
    session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
    pages: { signIn: "/login", error: "/login" },
    callbacks: sessionCallbacks,
    events: {
      // Audited without failing the sign-out: the session cookie is cleared regardless.
      signOut: async ({ token }) => {
        if (!token?.sub) {
          return;
        }

        try {
          await recordSignOut(getDatabase(), token.sub);
        } catch (error) {
          writeLog({
            severity: "error",
            module: "auth",
            operation: "sign-out-audit",
            message: "Sign-out audit failed",
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        }
      },
    },
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
            ? verifyCredentials(getDatabase(), parsed.data, { deferFailureAudit })
            : null;
        },
      }),
    ],
  };
}
