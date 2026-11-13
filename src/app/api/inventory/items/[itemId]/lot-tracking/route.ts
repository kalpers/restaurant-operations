import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { disableLotTracking, enableLotTracking } from "@/modules/inventory/services/lot-service";
import { itemIdParamsSchema, lotTrackingSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 23 (policy 20): turns lot tracking on (opening lots) or off (only with no lot stock). */
export const PUT = apiRoute<{ itemId: string }>(
  { module: "inventory", operation: "set-lot-tracking" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { itemId } = parseWith(itemIdParamsSchema, params);
    const { enabled, expectedVersion } = await parseJsonBody(request, lotTrackingSchema);
    const database = getDatabase();

    return {
      body: enabled
        ? await enableLotTracking(database, actor, itemId, expectedVersion)
        : await disableLotTracking(database, actor, itemId, expectedVersion),
    };
  },
);
