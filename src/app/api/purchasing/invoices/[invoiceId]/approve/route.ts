import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { approveInvoice } from "@/modules/inventory/services/invoice-service";
import { approveInvoiceSchema, invoiceIdParamsSchema } from "@/modules/inventory/validators/invoice-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 8): approves an invoice, storing its variances. Nothing is posted to inventory. */
export const POST = apiRoute<{ invoiceId: string }>(
  { module: "inventory", operation: "approve-supplier-invoice" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(invoiceIdParamsSchema, params);
    const body = await parseJsonBody(request, approveInvoiceSchema);

    return { body: await approveInvoice(getDatabase(), actor, p.invoiceId, body) };
  },
);
