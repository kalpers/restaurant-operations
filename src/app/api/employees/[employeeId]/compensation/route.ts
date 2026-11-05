import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  changeCompensation,
  getCompensationHistory,
} from "@/modules/employees/services/compensation-service";
import {
  changeCompensationSchema,
  employeeIdParamsSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "get-compensation" },
  async ({ params }) => {
    const actor = await requireApiPermission("hr.compensation.view");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);

    return { body: { compensation: await getCompensationHistory(getDatabase(), actor, employeeId) } };
  },
);

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "change-compensation" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.compensation.edit");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, changeCompensationSchema);

    return { body: await changeCompensation(getDatabase(), actor, { ...input, employeeId }), status: 201 };
  },
);
