"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { INPUT_STYLE } from "@/components/ui/field";

/** Self-service password change. On success the server issues a fresh session. */
export function ChangePasswordForm({ minimumLength }: { minimumLength: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [mismatch, setMismatch] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const newPassword = String(data.get("newPassword"));

    setError(null);
    setMismatch(newPassword !== String(data.get("confirmPassword")));

    if (newPassword !== String(data.get("confirmPassword"))) {
      return;
    }

    setPending(true);

    const result = await sendApiRequest("POST", "/api/account/password", {
      currentPassword: String(data.get("currentPassword")),
      newPassword,
    });

    if (result.ok) {
      router.replace("/dashboard");
      router.refresh();
    } else {
      setPending(false);
      setError(result);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <label className="grid gap-1 text-sm font-medium">
        Current password
        <input type="password" name="currentPassword" required autoComplete="current-password" className={INPUT_STYLE} />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        New password ({minimumLength}+ characters)
        <input
          type="password"
          name="newPassword"
          required
          minLength={minimumLength}
          autoComplete="new-password"
          className={INPUT_STYLE}
        />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Confirm new password
        <input
          type="password"
          name="confirmPassword"
          required
          minLength={minimumLength}
          autoComplete="new-password"
          className={INPUT_STYLE}
        />
      </label>
      {mismatch && (
        <p role="alert" className="rounded-md border border-danger-300 bg-danger-50 p-3 text-danger-800">
          The new passwords don&apos;t match.
        </p>
      )}
      <ApiErrorMessage error={error} />
      <Button type="submit" variant="primary" size="lg" pending={pending} pendingLabel="Changing...">
        Change password
      </Button>
    </form>
  );
}
