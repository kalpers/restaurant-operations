"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, type ButtonVariant } from "@/components/ui/button";
import { ConfirmDialog, type ConfirmOptions } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";

import { ApiErrorMessage } from "./api-error-message";
import { sendApiRequest, type ApiFailure } from "./api-request";

type ActionButtonProps = {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  body?: unknown;
  label: string;
  variant?: ButtonVariant;
  /** Ask before sending. Required for changes that cancel, remove, deactivate or void. */
  confirm?: Omit<ConfirmOptions, "confirmLabel"> & { confirmLabel?: string };
  /** Toast text after success. */
  successMessage?: string;
};

/** A change to one record, showing any error beside the button. */
export function ActionButton({
  method,
  url,
  body,
  label,
  variant,
  confirm,
  successMessage = "Done.",
}: ActionButtonProps) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [asking, setAsking] = useState(false);

  async function send() {
    setPending(true);
    setError(null);
    const result = await sendApiRequest(method, url, body);
    setPending(false);

    if (result.ok) {
      setAsking(false);
      toast.success(successMessage);
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant={variant ?? "secondary"}
        onClick={
          confirm
            ? () => {
                setError(null);
                setAsking(true);
              }
            : send
        }
        pending={pending && !confirm}
        // A destructive action reads as one even before it is pressed.
        className={confirm && variant === undefined ? "text-danger-700" : undefined}
      >
        {label}
      </Button>
      {!asking && <ApiErrorMessage error={error} />}
      {confirm && (
        <ConfirmDialog
          open={asking}
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel ?? label}
          cancelLabel={confirm.cancelLabel}
          tone={confirm.tone}
          pending={pending}
          error={<ApiErrorMessage error={error} />}
          onConfirm={send}
          onClose={() => setAsking(false)}
        />
      )}
    </span>
  );
}
