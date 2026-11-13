import { getDatabase } from "@/db";
import type { AuthContext } from "@/modules/auth/types";
import { buildTodayAcrossLocations } from "@/modules/reporting/services/cross-location-service";

import { formatCell } from "./format";

/** Phase 23 (policy 8): today at each location the user can see sales for, side by side. */
export async function LocationsToday({ auth }: { auth: AuthContext }) {
  const rows = await buildTodayAcrossLocations(getDatabase(), auth);

  if (!rows) {
    return null;
  }

  return (
    <section aria-labelledby="locations-today-heading" className="mb-8">
      <h2 id="locations-today-heading" className="mb-3 text-xl font-semibold">
        Today at all my locations
      </h2>
      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-surface shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-50">
            <tr>
              {["Location", "Business date", "Net sales", "Closed checks", "Covers", "Open checks", "Parties seated"].map((label) => (
                <th key={label} scope="col" className="px-3 py-2 font-semibold">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.locationId} className="border-t border-neutral-200">
                <th scope="row" className="px-3 py-2 font-medium">
                  {row.name}
                </th>
                <td className="px-3 py-2">{row.businessDate}</td>
                <td className="px-3 py-2">{formatCell("money", row.netSales)}</td>
                <td className="px-3 py-2">{formatCell("count", row.closedOrders)}</td>
                <td className="px-3 py-2">{formatCell("count", row.covers)}</td>
                <td className="px-3 py-2">{formatCell("count", row.openChecks)}</td>
                <td className="px-3 py-2">{row.seatedParties === null ? "—" : formatCell("count", row.seatedParties)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
