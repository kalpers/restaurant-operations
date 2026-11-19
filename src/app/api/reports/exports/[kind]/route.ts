import { getDatabase } from "@/db";
import { requireCurrentUser } from "@/modules/auth/guards";
import { exportPayrollHours, exportSalesJournal } from "@/modules/reporting/services/export-service";
import {
  exportFileQuerySchema,
  exportKindParamsSchema,
  searchParamsToObject,
} from "@/modules/reporting/validators/report-filters";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/**
 * Phase 28 (policy 10): the sales journal or payroll hours file as a CSV download. The
 * service checks every permission at every included location.
 */
export const GET = apiRoute<{ kind: string }>(
  { module: "reporting", operation: "export-file" },
  async ({ request, params }) => {
    const { kind } = parseWith(exportKindParamsSchema, params);
    const query = parseWith(exportFileQuerySchema, searchParamsToObject(new URL(request.url).searchParams));
    const auth = await requireCurrentUser();
    const { fileName, csv } =
      kind === "journal"
        ? await exportSalesJournal(getDatabase(), auth, query)
        : await exportPayrollHours(getDatabase(), auth, query);

    return {
      response: new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        },
      }),
    };
  },
);
