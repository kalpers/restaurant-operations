import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createSupplier, listSuppliers } from "@/modules/inventory/services/supplier-service";
import { createSupplierSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "inventory", operation: "list-suppliers" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listSuppliers(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "inventory", operation: "create-supplier" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createSupplierSchema);

    return { body: await createSupplier(db, actor, body), status: 201 };
  },
);
