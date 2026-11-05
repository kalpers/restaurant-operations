import { getDatabase } from "@/db";
import { getEmployeeDocumentStorage } from "@/infrastructure/storage";
import { requireApiPermission } from "@/modules/auth/guards";
import { attachmentDisposition } from "@/modules/employees/rules/document-policy";
import { readDocumentForDownload } from "@/modules/employees/services/document-service";
import { documentParamsSchema } from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string; documentId: string }>(
  { module: "employees", operation: "download-document" },
  async ({ params }) => {
    const actor = await requireApiPermission("hr.documents.view");
    const ids = parseWith(documentParamsSchema, params);
    const document = await readDocumentForDownload(
      getDatabase(),
      getEmployeeDocumentStorage(),
      actor,
      ids,
    );

    return {
      response: new Response(new Uint8Array(document.bytes), {
        headers: {
          "Content-Type": document.mimeType,
          "Content-Disposition": attachmentDisposition(document.name),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        },
      }),
    };
  },
);
