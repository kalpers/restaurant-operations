import Link from "next/link";
import { Suspense } from "react";

import { DashboardOverview } from "@/components/reports/dashboard-overview";
import { requirePageUser, resolveCurrentLocation } from "@/modules/auth/guards";
import { requirePermission } from "@/modules/auth/services/permission-service";
import { dashboardQuerySchema } from "@/modules/reporting/validators/report-filters";
import { INPUT_BASE } from "@/components/ui/field";

const INPUT_CLASS = INPUT_BASE;

/**
 * The operational overview. With `reports.view` it shows one business date's headline
 * figures for each report area the user holds; everyone sees their location and roles.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requirePageUser();
  const location = await resolveCurrentLocation(auth);
  const canReport = location?.permissions.includes("reports.view") ?? false;
  const raw = await searchParams;
  const parsed = dashboardQuerySchema.safeParse({
    locationId: location?.locationId,
    businessDate: typeof raw.businessDate === "string" && raw.businessDate !== "" ? raw.businessDate : undefined,
  });

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Dashboard</h1>
      {location ? (
        <dl className="mb-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
            <dt className="text-sm text-neutral-600">Location</dt>
            <dd className="text-lg font-medium">{location.locationName}</dd>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
            <dt className="text-sm text-neutral-600">Your roles here</dt>
            <dd className="text-lg font-medium">{location.roles.map((role) => role.name).join(", ")}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-neutral-700">
          Your account has no role at any location yet. Ask an administrator to assign one.
        </p>
      )}

      {location && canReport && (
        <section aria-labelledby="overview-heading">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <h2 id="overview-heading" className="text-xl font-semibold">
              Operational overview
            </h2>
            <form method="get" aria-label="Choose business date" className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-sm font-medium">
                Business date
                <input
                  type="date"
                  name="businessDate"
                  defaultValue={parsed.success ? parsed.data.businessDate : undefined}
                  className={INPUT_CLASS}
                />
              </label>
              <button type="submit" className="min-h-11 rounded-md border border-neutral-300 px-4 font-medium">
                Show
              </button>
              <Link href="/reports" className="inline-flex min-h-11 items-center font-medium underline">
                All reports
              </Link>
            </form>
          </div>

          {parsed.success ? (
            <Suspense fallback={<p className="text-neutral-600">Loading figures…</p>}>
              <DashboardOverview
                actor={requirePermission(auth, { permission: "reports.view", locationId: location.locationId })}
                locationId={location.locationId}
                businessDate={parsed.data.businessDate}
              />
            </Suspense>
          ) : (
            <p role="alert" className="mb-4 rounded border border-danger-300 bg-danger-50 p-3 text-danger-800">
              Choose a valid business date.
            </p>
          )}
        </section>
      )}
    </>
  );
}
