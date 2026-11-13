import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { searchPeopleToAdd } from "@/modules/auth/services/user-service";
import { apiRoute, parseWith } from "@/shared/http/api-route";

const querySchema = z.object({ q: z.string().max(320).default("") });

/** Phase 23 (policy 5): people in the organization not yet working at this location. */
export const GET = apiRoute(
  { module: "auth", operation: "search-people-to-add" },
  async ({ request }) => {
    const actor = await requireApiPermission("admin.users.manage");
    const { q } = parseWith(querySchema, Object.fromEntries(new URL(request.url).searchParams));

    return { body: { people: await searchPeopleToAdd(getDatabase(), actor, q) } };
  },
);
