import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { updatePosition } from "@/modules/employees/services/reference-service";
import {
  positionParamsSchema,
  updatePositionSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ positionId: string }>(
  { module: "employees", operation: "update-position" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("employees.positions.manage");
    const { positionId } = parseWith(positionParamsSchema, params);
    const input = await parseJsonBody(request, updatePositionSchema);

    return { body: await updatePosition(getDatabase(), actor, { ...input, positionId }) };
  },
);
