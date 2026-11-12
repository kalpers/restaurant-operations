import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { clearTaxExemption, setTaxExemption } from "@/modules/orders/services/tax-exemption-service";
import {
  clearTaxExemptionSchema,
  orderIdParamsSchema,
  setTaxExemptionSchema,
} from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Mark an OPEN check tax exempt (Phase 20, policy 16). */
export const POST = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "set-tax-exemption" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { orderId } = parseWith(orderIdParamsSchema, params);
    const body = await parseJsonBody(request, setTaxExemptionSchema);

    return { body: await setTaxExemption(getDatabase(), actor, orderId, body) };
  },
);

/** Remove the exemption while the check is still OPEN. */
export const DELETE = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "clear-tax-exemption" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { orderId } = parseWith(orderIdParamsSchema, params);
    const body = await parseJsonBody(request, clearTaxExemptionSchema);

    return { body: await clearTaxExemption(getDatabase(), actor, orderId, body) };
  },
);
