"use client";

import { TriangleAlert } from "lucide-react";

import { Button, ButtonLink } from "@/components/ui/button";

/**
 * A page that failed to render. It never shows the error's message or stack: the server
 * has already logged it, and the digest lets staff point to that log entry.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto grid max-w-lg justify-items-center gap-3 py-12 text-center">
      <TriangleAlert aria-hidden className="size-10 text-warning-700" />
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-neutral-700">
        This page couldn&apos;t be loaded. Nothing you entered was sent twice. Try again, and if it keeps happening,
        tell a manager.
      </p>
      {error.digest && <p className="text-xs text-neutral-600">Reference: {error.digest}</p>}
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <ButtonLink href="/dashboard">Go to the dashboard</ButtonLink>
      </div>
    </div>
  );
}
