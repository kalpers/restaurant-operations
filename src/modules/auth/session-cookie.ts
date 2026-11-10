import { encode } from "next-auth/jwt";

import { getAuthConfig } from "@/config/auth-env";

import { SESSION_MAX_AGE_SECONDS } from "./auth-options";

/**
 * A `Set-Cookie` value carrying a fresh session for this user, signed in at `authTime`. Used
 * after a self-service password change so the changer stays signed in while every older
 * session ends (Phase 16 policy 21). Same token contents, cookie name and attributes as
 * next-auth v4's own session cookie.
 */
export async function freshSessionCookie(userId: string, authTime: number): Promise<string> {
  const { secret, secureCookies } = getAuthConfig();
  const token = await encode({
    token: { sub: userId, authTime },
    secret,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  const name = `${secureCookies ? "__Secure-" : ""}next-auth.session-token`;
  const attributes = [`Path=/`, "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_MAX_AGE_SECONDS}`];

  if (secureCookies) {
    attributes.push("Secure");
  }

  return `${name}=${token}; ${attributes.join("; ")}`;
}
