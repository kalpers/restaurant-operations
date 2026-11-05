import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { setRoleActive } from "@/modules/auth/services/role-service";
import {
  roleIdParamsSchema,
  setActiveSchema,
} from "@/modules/auth/validators/auth-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ roleId: string }>(
  { module: "auth", operation: "set-role-active" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("admin.roles.manage");
    const { roleId } = parseWith(roleIdParamsSchema, params);
    const input = await parseJsonBody(request, setActiveSchema);

    return {
      body: await setRoleActive(getDatabase(), actor, { ...input, roleId }),
    };
  },
);
