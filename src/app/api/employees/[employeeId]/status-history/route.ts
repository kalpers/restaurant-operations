import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { getEmployeeEmployment } from "@/modules/employees/services/status-service";
import { employeeIdParamsSchema } from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "get-employee-employment" },
  async ({ params }) => {
    const actor = await requireApiPermission("hr.view");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);

    return { body: await getEmployeeEmployment(getDatabase(), actor, employeeId) };
  },
);
