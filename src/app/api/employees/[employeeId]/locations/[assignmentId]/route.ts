import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { endLocationAssignment } from "@/modules/employees/services/assignment-service";
import {
  assignmentParamsSchema,
  endAssignmentSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ employeeId: string; assignmentId: string }>(
  { module: "employees", operation: "end-location-assignment" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("employees.locations.manage");
    const ids = parseWith(assignmentParamsSchema, params);
    const input = await parseJsonBody(request, endAssignmentSchema);

    await endLocationAssignment(getDatabase(), actor, { ...ids, ...input });

    return {};
  },
);
