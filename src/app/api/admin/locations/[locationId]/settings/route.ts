import { getDatabase } from "@/db";
import { requireApiPermission, requireCurrentUser } from "@/modules/auth/guards";
import { updateLocationSettings } from "@/modules/organization/services/organization-service";
import {
  locationIdParamsSchema,
  updateLocationSettingsSchema,
} from "@/modules/organization/validators/organization-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ locationId: string }>(
  { module: "organization", operation: "update-location-settings" },
  async ({ request, params }) => {
    await requireCurrentUser();
    const { locationId } = parseWith(locationIdParamsSchema, params);

    // Authorized at the target location, not the one the user is working at.
    await requireApiPermission("locations.manage", locationId);
    const input = await parseJsonBody(request, updateLocationSettingsSchema);

    return {
      body: await updateLocationSettings(getDatabase(), locationId, input),
    };
  },
);
