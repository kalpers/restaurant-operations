import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { createRole } from "@/modules/auth/services/role-service";
import { createRoleSchema } from "@/modules/auth/validators/auth-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const POST = apiRoute(
  { module: "auth", operation: "create-role" },
  async ({ request }) => {
    const actor = await requireApiPermission("admin.roles.manage");
    const input = await parseJsonBody(request, createRoleSchema);

    return { body: await createRole(getDatabase(), actor, input), status: 201 };
  },
);
