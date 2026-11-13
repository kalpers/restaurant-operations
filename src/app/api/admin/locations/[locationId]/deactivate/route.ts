import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  locationIdParamsSchema,
  locationLifecycleSchema,
} from "@/modules/organization/validators/organization-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";
import { deactivateLocation } from "@/workflows/deactivate-location/deactivate-location";

/** Phase 23 (policy 3): closes a location. The workflow checks the permission there too. */
export const POST = apiRoute<{ locationId: string }>(
  { module: "organization", operation: "deactivate-location" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("locations.lifecycle");
    const { locationId } = parseWith(locationIdParamsSchema, params);
    const { expectedVersion } = await parseJsonBody(request, locationLifecycleSchema);

    return { body: await deactivateLocation(getDatabase(), actor, { locationId, expectedVersion }) };
  },
);
