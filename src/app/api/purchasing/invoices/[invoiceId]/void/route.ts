import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { voidInvoice } from "@/modules/inventory/services/invoice-service";
import { invoiceIdParamsSchema, invoiceReasonSchema } from "@/modules/inventory/validators/invoice-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 8): voids an invoice, releasing its received lines. */
export const POST = apiRoute<{ invoiceId: string }>(
  { module: "inventory", operation: "void-supplier-invoice" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(invoiceIdParamsSchema, params);
    const body = await parseJsonBody(request, invoiceReasonSchema);

    return { body: await voidInvoice(getDatabase(), actor, p.invoiceId, body) };
  },
);
