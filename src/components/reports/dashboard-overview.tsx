import Link from "next/link";

import { getDatabase } from "@/db";
import type { Actor } from "@/modules/auth/types";
import { buildDashboard, type Dashboard } from "@/modules/reporting/services/report-service";
import { AppError } from "@/shared/errors/app-error";

import { formatCell } from "./format";

/**
 * One business date's headline figures for each report area the actor holds. Rendered
 * inside a Suspense boundary, so the dashboard page never waits for these queries.
 */
export async function DashboardOverview({
  actor,
  locationId,
  businessDate,
}: {
  actor: Actor;
  locationId: string;
  businessDate?: string;
}) {
  let dashboard: Dashboard;

  try {
    dashboard = await buildDashboard(getDatabase(), actor, locationId, businessDate);
  } catch (caught) {
    if (caught instanceof AppError && caught.httpStatus < 500) {
      return (
        <p role="alert" className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-red-800">
          {caught.message}
        </p>
      );
    }

    throw caught;
  }

  return (
    <div className="grid gap-6">
      <p className="font-medium">Business date {dashboard.businessDate}</p>
      {dashboard.groups.map((group) => (
        <div key={group.area}>
          <h3 className="mb-2 font-semibold">
            <Link
              href={`/reports/${group.area}?from=${dashboard.businessDate}&to=${dashboard.businessDate}`}
              className="underline"
            >
              {group.title}
            </Link>
          </h3>
          <dl aria-label={group.title} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {group.tiles.map((tile) => (
              <div key={tile.key} className="rounded border border-neutral-200 p-3">
                <dt className="text-sm text-neutral-600">{tile.label}</dt>
                <dd className="text-lg font-medium tabular-nums">{formatCell(tile.kind, tile.value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className="text-sm text-neutral-600">
        Sales are closed orders before tax. Labor is scheduled hours from published schedules.
      </p>
    </div>
  );
}
