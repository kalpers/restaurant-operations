import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createSupplierItem, listSupplierItems } from "@/modules/inventory/services/supplier-service";
import { createSupplierItemSchema, supplierIdParamsSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ supplierId: string }>(
  { module: "inventory", operation: "list-supplier-items" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(supplierIdParamsSchema, params);

    return { body: await listSupplierItems(db, actor, { supplierId: p.supplierId }) };
  },
);

export const POST = apiRoute<{ supplierId: string }>(
  { module: "inventory", operation: "create-supplier-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(supplierIdParamsSchema, params);
    const body = await parseJsonBody(request, createSupplierItemSchema);

    return { body: await createSupplierItem(db, actor, p.supplierId, body), status: 201 };
  },
);
