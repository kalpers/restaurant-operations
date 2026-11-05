"use client";

import { signOutToLogin } from "@/modules/auth/client";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => void signOutToLogin()}
      className="min-h-11 rounded border border-neutral-400 px-3 py-1 text-sm font-medium"
    >
      Log out
    </button>
  );
}
