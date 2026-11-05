import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  createUserWithRole,
  listUsersAtLocation,
} from "@/modules/auth/services/user-service";
import { createUserSchema } from "@/modules/auth/validators/auth-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "auth", operation: "list-users" },
  async () => {
    const actor = await requireApiPermission("admin.users.view");

    return {
      body: { users: await listUsersAtLocation(getDatabase(), actor.locationId) },
    };
  },
);

export const POST = apiRoute(
  { module: "auth", operation: "create-user" },
  async ({ request }) => {
    const actor = await requireApiPermission("admin.users.manage");
    const input = await parseJsonBody(request, createUserSchema);

    return {
      body: await createUserWithRole(getDatabase(), actor, input),
      status: 201,
    };
  },
);
