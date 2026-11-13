import { z } from "zod";

import { getDatabase } from "@/db";
import { requireCurrentUser } from "@/modules/auth/guards";
import { exportLotTraceCsv } from "@/modules/reporting/services/lot-trace-service";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 23 (policy 23): a lot trace as CSV. Needs the inventory report and export permissions. */
export const GET = apiRoute<{ lotId: string }>(
  { module: "reporting", operation: "export-lot-trace" },
  async ({ params }) => {
    const { lotId } = parseWith(z.object({ lotId: z.uuid() }), params);
    const { fileName, csv } = await exportLotTraceCsv(getDatabase(), await requireCurrentUser(), lotId);

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
