import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { setPrimaryPosition } from "@/modules/employees/services/assignment-service";
import {
  assignmentParamsSchema,
  setPrimarySchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ employeeId: string; assignmentId: string }>(
  { module: "employees", operation: "set-primary-position" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("employees.positions.manage");
    const ids = parseWith(assignmentParamsSchema, params);
    const input = await parseJsonBody(request, setPrimarySchema);

    await setPrimaryPosition(getDatabase(), actor, { ...ids, ...input });

    return {};
  },
);
