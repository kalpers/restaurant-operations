import Link from "next/link";

import { getDatabase } from "@/db";
import { requirePermission } from "@/modules/auth/services/permission-service";
import type { AuthContext } from "@/modules/auth/types";
import { listNotesForReader } from "@/modules/restaurant/services/pre-shift-service";

import { PreShiftNoteList } from "./pre-shift-note-list";

/** Phase 32 (policy 10): today's pre-shift notes on the dashboard, for `pre-shift.view` holders. */
export async function PreShiftToday({ auth, locationId }: { auth: AuthContext; locationId: string }) {
  const actor = requirePermission(auth, { permission: "pre-shift.view", locationId });
  const { notes } = await listNotesForReader(getDatabase(), actor);

  return (
    <section aria-labelledby="pre-shift-heading" className="mb-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="pre-shift-heading" className="text-xl font-semibold">
          Pre-shift notes today
        </h2>
        <Link href="/pre-shift" className="font-medium underline">
          Pre-shift page
        </Link>
      </div>
      {notes.length === 0 ? (
        <p className="text-sm text-neutral-700">No pre-shift notes for you today.</p>
      ) : (
        <PreShiftNoteList notes={notes} compact />
      )}
    </section>
  );
}
