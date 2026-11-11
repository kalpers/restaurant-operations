import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { cn } from "@/components/ui/cn";
import { getDatabase } from "@/db";
import type { Actor } from "@/modules/auth/types";
import { buildDashboard, type Dashboard } from "@/modules/reporting/services/report-service";
import { AppError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

import { tileDelta } from "./dashboard-delta";
import { formatCell } from "./format";

const DIRECTION_ICON = { up: ArrowUpRight, down: ArrowDownRight, same: ArrowRight } as const;

/**
 * One business date's headline figures for each report area the actor holds, each with
 * its change against the previous business date. Both dates come from the same read-only
 * reporting service. Rendered inside a Suspense boundary, so the page never waits for it.
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
  let previous: Dashboard | null = null;

  try {
    dashboard = await buildDashboard(getDatabase(), actor, locationId, businessDate);
    previous = await buildDashboard(getDatabase(), actor, locationId, addDays(dashboard.businessDate, -1));
  } catch (caught) {
    if (caught instanceof AppError && caught.httpStatus < 500) {
      return (
        <p role="alert" className="mb-4 rounded-md border border-danger-300 bg-danger-50 p-3 text-danger-800">
          {caught.message}
        </p>
      );
    }

    throw caught;
  }

  const previousValue = (area: string, key: string) =>
    previous?.groups.find((group) => group.area === area)?.tiles.find((tile) => tile.key === key)?.value;

  return (
    <div className="grid gap-6">
      <p className="font-medium">
        Business date {dashboard.businessDate}
        {previous && <span className="ml-2 text-sm font-normal text-neutral-600">compared with {previous.businessDate}</span>}
      </p>
      {dashboard.groups.map((group) => (
        <div key={group.area}>
          <h3 className="mb-2 font-semibold">
            <Link
              href={`/reports/${group.area}?from=${dashboard.businessDate}&to=${dashboard.businessDate}`}
              className="text-brand-800 underline-offset-2 hover:underline"
            >
              {group.title}
            </Link>
          </h3>
          <dl aria-label={group.title} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {group.tiles.map((tile) => {
              const delta = tileDelta(tile.kind, tile.value, previousValue(group.area, tile.key));
              const Icon = delta ? DIRECTION_ICON[delta.direction] : null;

              return (
                <div key={tile.key} className="grid gap-1 rounded-lg border border-neutral-200 bg-surface p-3 shadow-sm">
                  <dt className="text-sm text-neutral-700">{tile.label}</dt>
                  <dd className="tabular text-2xl font-semibold">{formatCell(tile.kind, tile.value)}</dd>
                  {delta && Icon && (
                    <dd className={cn("flex items-center gap-1 text-xs", delta.direction === "same" ? "text-neutral-600" : "text-neutral-800")}>
                      <Icon aria-hidden className="size-3.5" />
                      <span className="tabular">{delta.text}</span>
                      <span className="text-neutral-600">vs prev. day</span>
                    </dd>
                  )}
                </div>
              );
            })}
          </dl>
        </div>
      ))}
      <p className="text-sm text-neutral-600">
        Sales are closed orders before tax; tax is shown separately. Labor is scheduled hours from published schedules. Up and down arrows show
        direction only; whether a change is good depends on the figure.
      </p>
    </div>
  );
}
