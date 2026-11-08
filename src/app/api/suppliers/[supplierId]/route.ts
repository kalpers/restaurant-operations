import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateSupplier } from "@/modules/inventory/services/supplier-service";
import { supplierIdParamsSchema, updateSupplierSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ supplierId: string }>(
  { module: "inventory", operation: "update-supplier" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(supplierIdParamsSchema, params);
    const body = await parseJsonBody(request, updateSupplierSchema);

    return { body: await updateSupplier(db, actor, p.supplierId, body) };
  },
);
