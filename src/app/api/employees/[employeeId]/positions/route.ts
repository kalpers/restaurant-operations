import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { assignPosition } from "@/modules/employees/services/assignment-service";
import {
  assignPositionSchema,
  employeeIdParamsSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

const permission = "employees.positions.manage";

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "assign-position" },
  async ({ request, params }) => {
    const actor = await requireApiPermission(permission);
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const { locationId, ...input } = await parseJsonBody(
      request,
      assignPositionSchema,
    );
    const targetActor = await requireApiPermission(permission, locationId);

    return {
      body: await assignPosition(getDatabase(), actor, targetActor, {
        ...input,
        employeeId,
      }),
      status: 201,
    };
  },
);
