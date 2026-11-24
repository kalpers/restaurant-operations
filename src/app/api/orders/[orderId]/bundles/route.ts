import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addBundleDraft } from "@/modules/orders/services/bundle-draft-service";
import { addBundleDraftSchema, orderIdParamsSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 9): adds a prix-fixe or combo, with its choices, as drafts. */
export const POST = apiRoute<{ orderId: string }>({ module: "orders", operation: "add-bundle-draft" }, async ({ request, params }) => {
  const actor = await requireApiActor();
  const p = parseWith(orderIdParamsSchema, params);
  const body = await parseJsonBody(request, addBundleDraftSchema);

  return { body: await addBundleDraft(getDatabase(), actor, p.orderId, body), status: 201 };
});
