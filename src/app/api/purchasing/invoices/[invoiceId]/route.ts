import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getInvoice, updateInvoice } from "@/modules/inventory/services/invoice-service";
import { invoiceIdParamsSchema, updateInvoiceSchema } from "@/modules/inventory/validators/invoice-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 8): one invoice with its lines and variances. */
export const GET = apiRoute<{ invoiceId: string }>({ module: "inventory", operation: "get-supplier-invoice" }, async ({ params }) => {
  const actor = await requireApiActor();
  const p = parseWith(invoiceIdParamsSchema, params);

  return { body: await getInvoice(getDatabase(), actor, p.invoiceId) };
});

/** Replaces a draft or disputed invoice's header and lines. */
export const PATCH = apiRoute<{ invoiceId: string }>(
  { module: "inventory", operation: "update-supplier-invoice" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(invoiceIdParamsSchema, params);
    const body = await parseJsonBody(request, updateInvoiceSchema);

    return { body: await updateInvoice(getDatabase(), actor, p.invoiceId, body) };
  },
);
