import { UtensilsCrossed } from "lucide-react";
import type { ReactNode } from "react";

/** Phase 22 (policy 12): the frame of the signed-out guest pages. No staff app shell. */
export function PublicShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-gradient-to-br from-brand-50 via-canvas to-neutral-100 px-4 py-8">
      <div className="mx-auto w-full max-w-xl rounded-xl border border-neutral-200 bg-surface p-5 shadow-lg sm:p-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand-700 text-white">
            <UtensilsCrossed aria-hidden className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold break-words">{title}</h1>
            {subtitle && <p className="text-sm text-neutral-700">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
