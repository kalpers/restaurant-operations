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
  await signOut({ callbackUrl: "/login" });
}
