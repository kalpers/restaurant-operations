import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createModifier, listModifiers } from "@/modules/menu/services/modifier-service";
import { createModifierSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "menu", operation: "list-modifiers" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listModifiers(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "menu", operation: "create-modifier" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createModifierSchema);

    return { body: await createModifier(db, actor, body), status: 201 };
  },
);
