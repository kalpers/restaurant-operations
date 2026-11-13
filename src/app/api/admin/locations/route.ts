import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { createLocationSchema } from "@/modules/organization/validators/organization-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";
import { openLocation } from "@/workflows/open-location/open-location";

/** Phase 23 (policy 1): opens a new location, optionally copying setup from another. */
export const POST = apiRoute(
  { module: "organization", operation: "create-location" },
  async ({ request }) => {
    const actor = await requireApiPermission("locations.lifecycle");
    const input = await parseJsonBody(request, createLocationSchema);

    return { body: await openLocation(getDatabase(), actor, input), status: 201 };
  },
);
