import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { ReportView } from "@/components/reports/report-view";
import { Breadcrumbs } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageUser } from "@/modules/auth/guards";
import { traceLot } from "@/modules/reporting/services/lot-trace-service";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";

/** Phase 23 (policy 23): where one lot came from, where it went, and what used it. */
export default async function LotTracePage({ params }: { params: Promise<{ lotId: string }> }) {
  const parsed = z.object({ lotId: z.uuid() }).safeParse(await params);

  if (!parsed.success) {
    notFound();
  }

  const auth = await requirePageUser();
  const report = await traceLot(getDatabase(), auth, parsed.data.lotId).catch((error: unknown) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    if (error instanceof AuthorizationError) {
      redirect("/access-denied");
    }

    throw error;
  });
  const here = auth.locations.find((location) => location.locationId === report.location.id);
  const exportHref = here?.permissions.includes("reports.export")
    ? () => `/api/reports/lot-trace/${parsed.data.lotId}/export`
    : null;

  return (
    <>
      <Breadcrumbs items={[{ label: "Reports", href: "/reports" }, { label: "Inventory", href: "/reports/inventory" }, { label: report.title }]} />
      <h1 className="mb-1 text-2xl font-semibold">{report.title}</h1>
      <p className="mb-6 text-neutral-600">{report.location.name}</p>
      <ReportView report={report} exportHref={exportHref} />
    </>
  );
}
