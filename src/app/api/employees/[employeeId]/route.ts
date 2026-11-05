import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  getEmployeeGeneral,
  updateEmployeeGeneral,
} from "@/modules/employees/services/employee-service";
import {
  employeeIdParamsSchema,
  updateEmployeeSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "get-employee" },
  async ({ params }) => {
    const actor = await requireApiPermission("employees.view");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);

    return { body: await getEmployeeGeneral(getDatabase(), actor, employeeId) };
  },
);

export const PATCH = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "update-employee" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("employees.edit");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, updateEmployeeSchema);

    return { body: await updateEmployeeGeneral(getDatabase(), actor, employeeId, input) };
  },
);
