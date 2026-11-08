import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { validateModifierSelection } from "@/modules/menu/services/selection-service";
import { validateSelectionSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const POST = apiRoute(
  { module: "menu", operation: "validate-selection" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, validateSelectionSchema);

    return { body: await validateModifierSelection(db, actor, body).then((violations) => ({ valid: violations.length === 0, violations })) };
  },
);
