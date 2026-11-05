import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { terminateEmployee } from "@/workflows/terminate-employee/terminate-employee";
import {
  employeeIdParamsSchema,
  terminateEmployeeSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "terminate-employee" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("employees.terminate");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, terminateEmployeeSchema);

    return { body: await terminateEmployee(getDatabase(), actor, { ...input, employeeId }) };
  },
);
