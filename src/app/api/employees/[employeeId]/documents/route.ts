import { getEnv } from "@/config/env";
import { getDatabase } from "@/db";
import { getEmployeeDocumentStorage } from "@/infrastructure/storage";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  listDocuments,
  uploadDocument,
} from "@/modules/employees/services/document-service";
import {
  documentFieldsSchema,
  employeeIdParamsSchema,
} from "@/modules/employees/validators/employee-validators";
import { ValidationError } from "@/shared/errors/app-error";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Room for the multipart boundary and the other fields around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export const GET = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "list-documents" },
  async ({ params }) => {
    const actor = await requireApiPermission("hr.documents.view");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);

    return {
      body: { documents: await listDocuments(getDatabase(), actor, employeeId) },
    };
  },
);

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "upload-document" },
  async ({ request, params }) => {
    // Authorize and check the declared size before the body is read into memory.
    const actor = await requireApiPermission("hr.documents.manage");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const maxBytes = getEnv().EMPLOYEE_DOCUMENT_MAX_BYTES;
    const declaredLength = Number(request.headers.get("content-length"));

    if (!declaredLength) {
      throw new ValidationError("The upload must declare its length.");
    }

    if (declaredLength > maxBytes + MULTIPART_OVERHEAD_BYTES) {
      throw new ValidationError("The file is too large.");
    }

    const form = await request.formData().catch(() => {
      throw new ValidationError("The upload must be multipart form data.");
    });
    const file = form.get("file");

    if (!(file instanceof File)) {
      throw new ValidationError("Choose a file to upload.");
    }

    const fields = parseWith(documentFieldsSchema, {
      documentType: form.get("documentType"),
      name: form.get("name") || file.name,
      description: form.get("description") || null,
      // Sensitive unless explicitly marked otherwise.
      sensitive: form.get("sensitive") !== "false",
    });

    return {
      body: await uploadDocument(
        getDatabase(),
        getEmployeeDocumentStorage(),
        actor,
        {
          ...fields,
          employeeId,
          mimeType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
          maxBytes,
        },
      ),
      status: 201,
    };
  },
);
