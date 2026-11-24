import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listInvoiceableReceiptLines } from "@/modules/inventory/services/invoice-service";
import { invoiceableQuerySchema } from "@/modules/inventory/validators/invoice-validators";
import { searchParamsToObject } from "@/modules/reporting/validators/report-filters";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 8): a supplier's received lines no live invoice holds yet. */
export const GET = apiRoute({ module: "inventory", operation: "list-invoiceable-receipt-lines" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(invoiceableQuerySchema, searchParamsToObject(new URL(request.url).searchParams));

  return { body: { lines: await listInvoiceableReceiptLines(getDatabase(), actor, query) } };
});
