import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  getLinkedUser,
  linkUser,
  unlinkUser,
} from "@/modules/employees/services/user-link-service";
import {
  employeeIdParamsSchema,
  linkUserSchema,
  unlinkUserSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "get-linked-user" },
  async ({ params }) => {
    const actor = await requireApiPermission("admin.users.view");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);

    return { body: { user: await getLinkedUser(getDatabase(), actor, employeeId) } };
  },
);

export const PUT = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "link-user" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("employees.edit");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, linkUserSchema);

    return { body: await linkUser(getDatabase(), actor, { ...input, employeeId }) };
  },
);

export const DELETE = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "unlink-user" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("employees.edit");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, unlinkUserSchema);

    return { body: await unlinkUser(getDatabase(), actor, { ...input, employeeId }) };
  },
);
