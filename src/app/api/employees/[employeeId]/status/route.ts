import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { changeEmployeeStatus } from "@/modules/employees/services/status-service";
import {
  changeStatusSchema,
  employeeIdParamsSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "change-employee-status" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("employees.edit");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, changeStatusSchema);

    return { body: await changeEmployeeStatus(getDatabase(), actor, { ...input, employeeId }) };
  },
);
