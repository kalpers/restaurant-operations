import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { reactivateLocation } from "@/modules/organization/services/location-lifecycle-service";
import {
  locationIdParamsSchema,
  locationLifecycleSchema,
} from "@/modules/organization/validators/organization-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 23 (policy 3): reopens a closed location of the actor's organization. */
export const POST = apiRoute<{ locationId: string }>(
  { module: "organization", operation: "reactivate-location" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("locations.lifecycle");
    const { locationId } = parseWith(locationIdParamsSchema, params);
    const { expectedVersion } = await parseJsonBody(request, locationLifecycleSchema);

    return { body: await reactivateLocation(getDatabase(), actor, { locationId, expectedVersion }) };
  },
);
