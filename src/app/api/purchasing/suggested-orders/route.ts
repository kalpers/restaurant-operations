import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createSuggestedOrders, previewSuggestedOrders } from "@/modules/inventory/services/suggested-order-service";
import {
  createSuggestedOrdersSchema,
  suggestedOrdersQuerySchema,
} from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import {
  createForecastSuggestedOrders,
  previewForecastSuggestedOrders,
} from "@/workflows/forecast-items/forecast-suggested-orders";

/**
 * What suggested draft orders would hold now (Phase 19, policy 16). Writes nothing. Phase 25
 * policy 11: `?basis=forecast&through=YYYY-MM-DD` uses the forecast instead of par levels.
 */
export const GET = apiRoute({ module: "inventory", operation: "preview-suggested-orders" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(suggestedOrdersQuerySchema, Object.fromEntries(new URL(request.url).searchParams.entries()));

  return {
    body:
      query.basis === "forecast"
        ? await previewForecastSuggestedOrders(getDatabase(), actor, { throughDate: query.through })
        : await previewSuggestedOrders(getDatabase(), actor),
  };
});

/** Creates the suggested DRAFT orders, one per supplier; never submits (policy 17; Phase 25 policy 13). */
export const POST = apiRoute({ module: "inventory", operation: "create-suggested-orders" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createSuggestedOrdersSchema);
  const result =
    body.basis === "forecast"
      ? await createForecastSuggestedOrders(getDatabase(), actor, {
          throughDate: body.throughDate,
          idempotencyKey: body.idempotencyKey,
        })
      : await createSuggestedOrders(getDatabase(), actor, { idempotencyKey: body.idempotencyKey });

  return { status: result.replayed ? 200 : 201, body: result };
});
