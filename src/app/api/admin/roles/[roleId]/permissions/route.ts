import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { replaceRolePermissions } from "@/modules/auth/services/role-service";
import {
  replaceRolePermissionsSchema,
  roleIdParamsSchema,
} from "@/modules/auth/validators/auth-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ roleId: string }>(
  { module: "auth", operation: "replace-role-permissions" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("admin.roles.manage");
    const { roleId } = parseWith(roleIdParamsSchema, params);
    const input = await parseJsonBody(request, replaceRolePermissionsSchema);

    return {
      body: await replaceRolePermissions(getDatabase(), actor, {
        ...input,
        roleId,
      }),
    };
  },
);
