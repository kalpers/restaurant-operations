import type { NextRequest } from "next/server";
import NextAuth from "next-auth";

import { getAuthOptions } from "./auth-options";

/** Sign-in, sign-out, CSRF and session endpoints, all owned by the library. */
export function handleAuthRequest(
  request: NextRequest,
  context: { params: Promise<{ nextauth: string[] }> },
): Promise<Response> {
  return NextAuth(request, context, getAuthOptions());
}
