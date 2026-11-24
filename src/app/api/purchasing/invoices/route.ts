import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createInvoice, listInvoices } from "@/modules/inventory/services/invoice-service";
import { createInvoiceSchema, invoiceListQuerySchema } from "@/modules/inventory/validators/invoice-validators";
import { searchParamsToObject } from "@/modules/reporting/validators/report-filters";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 8): supplier invoices by invoice date. */
export const GET = apiRoute({ module: "inventory", operation: "list-supplier-invoices" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(invoiceListQuerySchema, searchParamsToObject(new URL(request.url).searchParams));

  return { body: { invoices: await listInvoices(getDatabase(), actor, query) } };
});

/** Enters an invoice as a draft. */
export const POST = apiRoute({ module: "inventory", operation: "create-supplier-invoice" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createInvoiceSchema);

  return { body: await createInvoice(getDatabase(), actor, body), status: 201 };
});
