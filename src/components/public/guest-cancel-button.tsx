"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Phase 22 (policy 11): cancels the booking through its private link, after a confirmation. */
export function GuestCancelButton({ token }: { token: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/public/manage/${token}/cancel`, { method: "POST" });

      if (response.ok) {
        router.refresh();
      } else {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;

        setError(body?.error?.message ?? "Couldn't cancel. Please call the restaurant.");
      }
    } catch {
      setError("Couldn't reach the restaurant. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-2">
      {confirming ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" disabled={pending} onClick={cancel}>
            Yes, cancel my booking
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Cancel booking
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}
