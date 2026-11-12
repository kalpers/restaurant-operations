"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Phase 22 (policy 4): one press stops emails; a link scanner fetching the page changes nothing. */
export function UnsubscribeButton({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (done) {
    return (
      <p role="status" className="font-medium">
        Done. We won&apos;t email this address about bookings again.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      <div>
        <Button
          onClick={async () => {
            try {
              const response = await fetch(`/api/public/messages/unsubscribe/${encodeURIComponent(token)}`, { method: "POST" });

              if (response.ok) {
                setDone(true);
              } else {
                setError("Couldn't do that just now. Please try again.");
              }
            } catch {
              setError("Couldn't reach the restaurant. Please try again.");
            }
          }}
        >
          Stop emails
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}
