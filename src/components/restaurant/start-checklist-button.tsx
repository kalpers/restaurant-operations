"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiJson, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";

/** Phase 36 (policy 5): starts today's run of a template, then opens it. */
export function StartChecklistButton({ templateId, label = "Start" }: { templateId: string; label?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Pick<ApiFailure, "code" | "message" | "requestId"> | null>(null);

  async function start() {
    setPending(true);
    setError(null);

    const result = await sendApiJson<{ id: string }>("POST", "/api/checklists/runs", { templateId });

    setPending(false);

    if (result.ok) {
      router.push(`/checklists/${result.data.id}`);
    } else {
      setError(result);
    }
  }

  return (
    <div className="grid gap-1">
      <Button variant="primary" pending={pending} pendingLabel="Starting…" onClick={start}>
        {label}
      </Button>
      <ApiErrorMessage error={error} />
    </div>
  );
}
