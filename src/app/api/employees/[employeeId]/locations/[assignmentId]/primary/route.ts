import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { setPrimaryLocation } from "@/modules/employees/services/assignment-service";
import {
  assignmentParamsSchema,
  setPrimarySchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ employeeId: string; assignmentId: string }>(
  { module: "employees", operation: "set-primary-location" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("employees.locations.manage");
    const ids = parseWith(assignmentParamsSchema, params);
    const input = await parseJsonBody(request, setPrimarySchema);

    await setPrimaryLocation(getDatabase(), actor, { ...ids, ...input });

    return {};
  },
);
