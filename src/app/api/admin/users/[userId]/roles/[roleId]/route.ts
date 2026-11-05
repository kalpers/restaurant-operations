import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { removeRole } from "@/modules/auth/services/user-service";
import { userRoleParamsSchema } from "@/modules/auth/validators/auth-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const DELETE = apiRoute<{ userId: string; roleId: string }>(
  { module: "auth", operation: "remove-role" },
  async ({ params }) => {
    const actor = await requireApiPermission("admin.users.manage");

    await removeRole(
      getDatabase(),
      actor,
      parseWith(userRoleParamsSchema, params),
    );

    return {};
  },
);
