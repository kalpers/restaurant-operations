"use client";

import { signIn, signOut } from "next-auth/react";

/** Resolves to whether sign-in succeeded. The reason is deliberately not exposed. */
export async function signInWithPassword(credentials: {
  email: string;
  password: string;
}): Promise<boolean> {
  const result = await signIn("credentials", { ...credentials, redirect: false });

  return result?.ok === true && !result.error;
}

export async function signOutToLogin(): Promise<void> {
  // Not a callbackUrl: next-auth resolves that against APP_BASE_URL, which would send someone who
  // opened the app by IP address to another host.
  await signOut({ redirect: false });
  window.location.assign(new URL("/login", window.location.origin));
}
