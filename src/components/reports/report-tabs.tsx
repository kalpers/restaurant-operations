import Link from "next/link";

import { REPORT_AREA_TITLE, type ReportArea } from "@/modules/reporting/types";

/** Usability only: every report page and API checks its own permission. */
export function ReportTabs({
  areas,
  current,
  query,
}: {
  areas: readonly ReportArea[];
  current?: ReportArea;
  /** Location and dates carried between reports. */
  query: string;
}) {
  return (
    <nav aria-label="Reports" className="mb-6 flex flex-wrap gap-2">
      {areas.map((area) => (
        <Link
          key={area}
          href={`/reports/${area}${query}`}
          aria-current={area === current ? "page" : undefined}
          className={`inline-flex min-h-11 items-center rounded border px-3 text-sm font-medium ${
            area === current ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-400"
          }`}
        >
          {REPORT_AREA_TITLE[area]}
        </Link>
      ))}
    </nav>
  );
}
