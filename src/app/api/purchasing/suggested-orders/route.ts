import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createSuggestedOrders, previewSuggestedOrders } from "@/modules/inventory/services/suggested-order-service";
import { createSuggestedOrdersSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** What suggested draft orders would hold now (Phase 19, policy 16). Writes nothing. */
export const GET = apiRoute({ module: "inventory", operation: "preview-suggested-orders" }, async () => {
  const actor = await requireApiActor();

  return { body: await previewSuggestedOrders(getDatabase(), actor) };
});

/** Creates the suggested DRAFT orders, one per supplier; never submits (policy 17). */
export const POST = apiRoute({ module: "inventory", operation: "create-suggested-orders" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createSuggestedOrdersSchema);
  const result = await createSuggestedOrders(getDatabase(), actor, body);

  return { status: result.replayed ? 200 : 201, body: result };
});
