"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";

import { cn } from "@/components/ui/cn";

import { isStaleConflict } from "./api-request";

type ApiErrorMessageProps = {
  error: { code?: string; message: string; requestId?: string } | null;
  className?: string;
};

/**
 * An error beside the control that failed. A version conflict offers a reload, and the
 * request ID is shown small so staff can quote it when reporting a problem.
 */
export function ApiErrorMessage({ error, className }: ApiErrorMessageProps) {
  const router = useRouter();

  if (!error) {
    return null;
  }

  const stale = isStaleConflict({ code: error.code ?? "" });

  return (
    <span role="alert" className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-danger-700", className)}>
      <span>{error.message}</span>
      {stale && (
        <button
          type="button"
          onClick={() => router.refresh()}
          className="inline-flex min-h-8 items-center gap-1 rounded-md border border-danger-300 bg-white px-2 font-medium text-danger-800 hover:bg-danger-50"
        >
          <RotateCw aria-hidden className="size-4" />
          Reload
        </button>
      )}
      {error.requestId && (
        <span className="text-xs text-neutral-600">Request ID: {error.requestId}</span>
      )}
    </span>
  );
}
