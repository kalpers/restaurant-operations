import Link from "next/link";

import { getDatabase } from "@/db";
import { requirePermission } from "@/modules/auth/services/permission-service";
import type { AuthContext } from "@/modules/auth/types";
import { listChecklistsToday } from "@/modules/restaurant/services/checklist-service";

import { ChecklistStatusBadge } from "./checklist-status-badge";

/** Phase 36 (policy 4): today's checklists on the dashboard, for `checklists.view` holders. */
export async function ChecklistsTodayPanel({ auth, locationId }: { auth: AuthContext; locationId: string }) {
  const actor = requirePermission(auth, { permission: "checklists.view", locationId });
  const { entries } = await listChecklistsToday(getDatabase(), actor);

  if (entries.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="checklists-heading" className="mb-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="checklists-heading" className="text-xl font-semibold">
          Today&apos;s checklists
        </h2>
        <Link href="/checklists" className="font-medium underline">
          Checklists page
        </Link>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {entries.map(({ template, run }) => (
          <li key={template.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-surface p-3 shadow-sm">
            <Link href={run ? `/checklists/${run.id}` : "/checklists"} className="font-medium underline">
              {template.name}
            </Link>
            <ChecklistStatusBadge status={run?.status ?? "NOT_STARTED"} />
          </li>
        ))}
      </ul>
    </section>
  );
}
