import { KeyRound } from "lucide-react";
import Link from "next/link";

import { ChangePasswordForm } from "@/components/account/change-password-form";
import { SignOutButton } from "@/components/app-shell/sign-out-button";
import { requirePageUserAllowingPasswordChange } from "@/modules/auth/guards";
import { MINIMUM_PASSWORD_LENGTH } from "@/modules/auth/password";

/**
 * Change password (Phase 16). Outside the app shell, because the shell's guard sends a user
 * with a pending forced change here; this page is the one place they may go.
 */
export default async function ChangePasswordPage() {
  const auth = await requirePageUserAllowingPasswordChange();

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-canvas to-neutral-100 p-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-surface p-6 shadow-lg">
        <div className="mb-6 flex items-center gap-3">
          <span className="inline-flex size-11 items-center justify-center rounded-lg bg-brand-700 text-white">
            <KeyRound aria-hidden className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Change password</h1>
            <p className="truncate text-sm text-neutral-700" title={auth.email}>
              {auth.email}
            </p>
          </div>
        </div>
        {auth.mustChangePassword && (
          <p role="status" className="mb-4 rounded-md border border-warning-300 bg-warning-50 p-3 text-warning-900">
            Your password was reset by an administrator. Choose a new password to continue.
          </p>
        )}
        <ChangePasswordForm minimumLength={MINIMUM_PASSWORD_LENGTH} />
        <p className="mt-4 text-sm text-neutral-700">
          Changing your password signs you out everywhere else.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          {!auth.mustChangePassword && (
            <Link href="/dashboard" className="text-sm font-medium text-brand-800 underline">
              Back to the app
            </Link>
          )}
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
