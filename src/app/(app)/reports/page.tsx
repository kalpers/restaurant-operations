import Link from "next/link";

import { requirePageActor } from "@/modules/auth/guards";
import { permittedAreas } from "@/modules/reporting/services/report-service";
import { REPORT_AREA_TITLE, type ReportArea } from "@/modules/reporting/types";

const DESCRIPTIONS: Record<ReportArea, string> = {
  sales: "Net sales of closed orders by business date and order type, with open checks and voids.",
  menu: "Items and modifiers sold, with theoretical food cost from what each sale consumed.",
  settlements: "Tenders, tips and change from completed settlements; voided and failed tenders.",
  orders: "Order lifecycle, check speed, voids, discounts and results by server.",
  inventory: "Ledger usage, waste, count variance, receipts and supplier cost changes.",
  fulfillment: "Kitchen and bar ticket times by station, late items and remakes.",
  labor: "Scheduled hours and hourly labor cost from published schedules, with coverage.",
  seating: "Table sessions, covers, turns, reservations and the waitlist.",
};

/** The reports you may open at the current location. */
export default async function ReportsPage() {
  const { location, actor } = await requirePageActor("reports.view");
  const areas = permittedAreas(actor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Reports</h1>
      <p className="mb-6 text-neutral-600">
        {location.locationName} · read-only reports by business date. Tax is not calculated in this version.
      </p>
      {areas.length === 0 ? (
        <p className="text-neutral-700">You have no report areas at this location.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {areas.map((area) => (
            <li key={area}>
              <Link
                href={`/reports/${area}`}
                className="block h-full rounded border border-neutral-200 p-4 hover:border-neutral-500"
              >
                <span className="text-lg font-medium">{REPORT_AREA_TITLE[area]}</span>
                <span className="mt-1 block text-sm text-neutral-600">{DESCRIPTIONS[area]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
