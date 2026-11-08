import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listSupplierItemCostHistory } from "@/modules/inventory/services/supplier-service";
import { supplierItemIdParamsSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ supplierItemId: string }>(
  { module: "inventory", operation: "supplier-cost-history" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(supplierItemIdParamsSchema, params);

    return { body: await listSupplierItemCostHistory(db, actor, p.supplierItemId) };
  },
);
