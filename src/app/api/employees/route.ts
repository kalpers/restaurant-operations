import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  createEmployee,
  listEmployees,
} from "@/modules/employees/services/employee-service";
import { createEmployeeSchema } from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "employees", operation: "list-employees" },
  async () => {
    const actor = await requireApiPermission("employees.view");

    return { body: { employees: await listEmployees(getDatabase(), actor) } };
  },
);

export const POST = apiRoute(
  { module: "employees", operation: "create-employee" },
  async ({ request }) => {
    const actor = await requireApiPermission("employees.create");
    const input = await parseJsonBody(request, createEmployeeSchema);

    return { body: await createEmployee(getDatabase(), actor, input), status: 201 };
  },
);
