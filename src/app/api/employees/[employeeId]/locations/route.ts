import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { assignLocation } from "@/modules/employees/services/assignment-service";
import {
  assignLocationSchema,
  employeeIdParamsSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

const permission = "employees.locations.manage";

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "assign-location" },
  async ({ request, params }) => {
    const actor = await requireApiPermission(permission);
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const { locationId, ...input } = await parseJsonBody(
      request,
      assignLocationSchema,
    );
    const targetActor = await requireApiPermission(permission, locationId);

    return {
      body: await assignLocation(getDatabase(), actor, targetActor, {
        ...input,
        employeeId,
      }),
      status: 201,
    };
  },
);
