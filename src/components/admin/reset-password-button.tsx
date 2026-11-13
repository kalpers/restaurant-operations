"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { NETWORK_FAILURE_MESSAGE, readFailure, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { apiFetch } from "@/components/forms/page-location";

/**
 * An administrator's password reset. The temporary password exists only in this component's
 * state after the response: it is shown once, for handing over in person, and is gone when
 * the dialog closes.
 */
export function ResetPasswordButton({ userId, email, version }: { userId: string; email: string; version: number }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);

  async function reset() {
    setPending(true);
    setError(null);

    try {
      const response = await apiFetch(`/api/admin/users/${userId}/password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
        cache: "no-store",
      });

      if (response.ok) {
        const body = (await response.json()) as { temporaryPassword: string };

        setAsking(false);
        setTemporaryPassword(body.temporaryPassword);
      } else {
        setError(await readFailure(response));
      }
    } catch {
      setError({ ok: false, status: 0, code: "NETWORK", message: NETWORK_FAILURE_MESSAGE });
    } finally {
      setPending(false);
    }
  }

  function closeShown() {
    setTemporaryPassword(null);
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        className="text-danger-700"
        onClick={() => {
          setError(null);
          setAsking(true);
        }}
      >
        Reset password
      </Button>
      <ConfirmDialog
        open={asking}
        title="Reset this user's password?"
        body={`${email} is signed out everywhere and must choose a new password at next sign-in. You'll see a temporary password once.`}
        confirmLabel="Reset password"
        pending={pending}
        error={<ApiErrorMessage error={error} />}
        onConfirm={reset}
        onClose={() => setAsking(false)}
      />
      <Dialog
        open={temporaryPassword !== null}
        onClose={closeShown}
        title="Temporary password"
        description={`Give this to ${email} in person. It is shown only now and can't be shown again.`}
        footer={
          <Button variant="primary" onClick={closeShown} data-autofocus>
            Done
          </Button>
        }
      >
        <p className="rounded-md border border-neutral-300 bg-neutral-50 p-3 text-center font-mono text-lg tracking-wide select-all" data-testid="temporary-password">
          {temporaryPassword}
        </p>
      </Dialog>
    </span>
  );
}
