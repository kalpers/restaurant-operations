import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listTransactions } from "@/modules/inventory/queries/stock-queries";
import { transactionFilterSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "inventory", operation: "list-transactions" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const filter = parseWith(transactionFilterSchema, Object.fromEntries(new URL(request.url).searchParams));

    return { body: await listTransactions(db, actor, filter) };
  },
);
