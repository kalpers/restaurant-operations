import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { disputeInvoice } from "@/modules/inventory/services/invoice-service";
import { invoiceIdParamsSchema, invoiceReasonSchema } from "@/modules/inventory/validators/invoice-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 8): marks an invoice disputed, with a reason. */
export const POST = apiRoute<{ invoiceId: string }>(
  { module: "inventory", operation: "dispute-supplier-invoice" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(invoiceIdParamsSchema, params);
    const body = await parseJsonBody(request, invoiceReasonSchema);

    return { body: await disputeInvoice(getDatabase(), actor, p.invoiceId, body) };
  },
);
