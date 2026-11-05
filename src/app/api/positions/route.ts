import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  createPosition,
  listPositions,
} from "@/modules/employees/services/reference-service";
import { createPositionSchema } from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "employees", operation: "list-positions" },
  async () => {
    const actor = await requireApiPermission("employees.view");

    return { body: { positions: await listPositions(getDatabase(), actor) } };
  },
);

export const POST = apiRoute(
  { module: "employees", operation: "create-position" },
  async ({ request }) => {
    const actor = await requireApiPermission("employees.positions.manage");
    const input = await parseJsonBody(request, createPositionSchema);

    return { body: await createPosition(getDatabase(), actor, input), status: 201 };
  },
);
