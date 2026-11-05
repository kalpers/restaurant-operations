import { getDatabase } from "@/db";
import { requireApiPermission, requireCurrentUser } from "@/modules/auth/guards";
import {
  findAreaLocationId,
  updateArea,
} from "@/modules/organization/services/organization-service";
import {
  areaIdParamsSchema,
  updateAreaSchema,
} from "@/modules/organization/validators/organization-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ areaId: string }>(
  { module: "organization", operation: "update-area" },
  async ({ request, params }) => {
    await requireCurrentUser();
    const { areaId } = parseWith(areaIdParamsSchema, params);

    // Authorized at the area's own location, not the one the user is working at.
    await requireApiPermission(
      "locations.manage",
      await findAreaLocationId(getDatabase(), areaId),
    );
    const input = await parseJsonBody(request, updateAreaSchema);

    return { body: await updateArea(getDatabase(), areaId, input) };
  },
);
