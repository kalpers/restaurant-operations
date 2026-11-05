import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { assignRole } from "@/modules/auth/services/user-service";
import {
  assignRoleSchema,
  userIdParamsSchema,
} from "@/modules/auth/validators/auth-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ userId: string }>(
  { module: "auth", operation: "assign-role" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("admin.users.manage");
    const { userId } = parseWith(userIdParamsSchema, params);
    const { roleId } = await parseJsonBody(request, assignRoleSchema);

    await assignRole(getDatabase(), actor, { userId, roleId });

    return {};
  },
);
