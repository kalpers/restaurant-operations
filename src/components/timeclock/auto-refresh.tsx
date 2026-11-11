"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-reads the page's server data on an interval (Phase 18: the time clock has no realtime
 * events). Skipped while the tab is hidden or a form field has focus, so typing isn't lost.
 */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => {
      const active = document.activeElement;
      const editing = active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement;

      if (document.visibilityState === "visible" && !editing && !document.querySelector("details[open]")) {
        router.refresh();
      }
    }, seconds * 1000);

    return () => window.clearInterval(timer);
  }, [router, seconds]);

  return null;
}
