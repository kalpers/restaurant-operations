import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { getDatabase } from "@/db";
import { requirePermission } from "@/modules/auth/services/permission-service";
import type { AuthContext } from "@/modules/auth/types";
import { listChecksDue } from "@/modules/restaurant/services/temperature-service";

/** Phase 36 (policy 4): overdue temperature checks on the dashboard, for `food-safety.view` holders. */
export async function TemperatureDuePanel({ auth, locationId }: { auth: AuthContext; locationId: string }) {
  const actor = requirePermission(auth, { permission: "food-safety.view", locationId });
  const { checks } = await listChecksDue(getDatabase(), actor);
  const overdue = checks.filter((check) => check.status.state === "OVERDUE");

  if (checks.every((check) => check.status.state === "NO_SCHEDULE")) {
    return null;
  }

  return (
    <section aria-labelledby="temperature-due-heading" className="mb-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="temperature-due-heading" className="text-xl font-semibold">
          Temperature checks due
        </h2>
        <Link href="/temperature-log" className="font-medium underline">
          Temperature log
        </Link>
      </div>
      {overdue.length === 0 ? (
        <p className="text-sm text-neutral-700">No checks are overdue.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {overdue.map((check) => (
            <li key={check.point.id}>
              <Badge tone="danger">{check.point.name}: check overdue</Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
