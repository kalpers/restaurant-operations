import { ExportDownload } from "@/components/reports/export-download";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { exportAbilities, exportDefaults } from "@/modules/reporting/services/export-service";

/**
 * Phase 28 exports (policies 8 to 10): files for the bookkeeper and the payroll provider.
 * The page needs `reports.export`; each file checks its own permissions again on the server.
 */
export default async function ExportsPage() {
  const { auth, location, actor } = await requirePageActor("reports.export");
  const abilities = exportAbilities(auth, location.locationId);
  const defaults = await exportDefaults(getDatabase(), actor);

  return (
    <>
      <PageHeader
        title="Exports"
        breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: "Exports" }]}
        description={`${location.locationName}: CSV files to load into accounting and payroll software. No pay is calculated here.`}
      />

      {!abilities.journal && !abilities.payroll && !abilities.unclaimed ? (
        <EmptyState title="No exports available">
          The sales journal needs the sales and settlements reports; the payroll file needs the labor report.
        </EmptyState>
      ) : null}

      <div className="grid gap-6">
        {abilities.journal ? (
          <Card>
            <CardTitle>Sales and tax journal</CardTitle>
            <p className="mb-3 text-sm text-neutral-700">
              One line per business date and account code: sales by menu category, discounts, comps, tax by category,
              tenders, tips, refunds and drawer over or short, as debits and credits that balance each day. Closed checks
              only; refunds on the day they were given.
            </p>
            <ExportDownload
              kind="journal"
              label="Sales journal"
              locationId={location.locationId}
              allLocations={abilities.journalAllLocations}
              defaultFrom={defaults.journal.from}
              defaultTo={defaults.journal.to}
            />
          </Card>
        ) : null}

        {abilities.payroll ? (
          <Card>
            <CardTitle>Payroll hours</CardTitle>
            <p className="mb-3 text-sm text-neutral-700">
              Regular and overtime hours per employee, position and work week, from the time clock, by the same overtime
              rules as the labor report. Whole weeks only (one to six). Refused while a time entry in the range is still
              open. Tip columns appear only if you can see tips. No rates or pay.
            </p>
            <ExportDownload
              kind="payroll"
              label="Payroll hours"
              locationId={location.locationId}
              allLocations={abilities.payrollAllLocations}
              defaultFrom={defaults.payroll.from}
              defaultTo={defaults.payroll.to}
            />
          </Card>
        ) : null}

        {abilities.unclaimed ? (
          <Card>
            <CardTitle>Gift card holder report</CardTitle>
            <p className="mb-3 text-sm text-neutral-700">
              Every gift card with value left and no activity for the unused-balance period in the gift card settings, across
              all locations, with the selling location&apos;s address and the purchaser&apos;s details where they were given
              (UNKNOWN where not). It is the material for an unclaimed-property filing, not the filing: each state has its own
              form and rules. No card codes.
            </p>
            <ExportDownload
              kind="unclaimed"
              label="Holder report"
              locationId={location.locationId}
              allLocations={false}
              defaultFrom={defaults.journal.to}
              defaultTo={defaults.journal.to}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
