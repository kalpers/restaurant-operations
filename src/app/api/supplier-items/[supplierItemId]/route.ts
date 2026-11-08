import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateSupplierItem } from "@/modules/inventory/services/supplier-service";
import { supplierItemIdParamsSchema, updateSupplierItemSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ supplierItemId: string }>(
  { module: "inventory", operation: "update-supplier-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(supplierItemIdParamsSchema, params);
    const body = await parseJsonBody(request, updateSupplierItemSchema);

    return { body: await updateSupplierItem(db, actor, p.supplierItemId, body) };
  },
);
