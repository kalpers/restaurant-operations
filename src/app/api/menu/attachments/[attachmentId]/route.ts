import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateAttachment } from "@/modules/menu/services/modifier-service";
import { attachmentIdParamsSchema, updateAttachmentSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ attachmentId: string }>(
  { module: "menu", operation: "update-attachment" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(attachmentIdParamsSchema, params);
    const body = await parseJsonBody(request, updateAttachmentSchema);

    return { body: await updateAttachment(db, actor, p.attachmentId, body) };
  },
);
