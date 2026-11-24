import { z } from "zod";

import { getDatabase } from "@/db";
import { getSupplierInvoiceStorage } from "@/infrastructure/storage";
import { requireApiActor } from "@/modules/auth/guards";
import { attachmentDisposition } from "@/modules/employees/rules/document-policy";
import { INVOICE_FILE_MAX_BYTES, readInvoiceFile, uploadInvoiceFile } from "@/modules/inventory/services/invoice-service";
import { invoiceIdParamsSchema } from "@/modules/inventory/validators/invoice-validators";
import { ValidationError } from "@/shared/errors/app-error";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Room for the multipart boundary and the other fields around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** Phase 36 (policy 8): downloads an invoice's scanned copy. */
export const GET = apiRoute<{ invoiceId: string }>({ module: "inventory", operation: "download-supplier-invoice-file" }, async ({ params }) => {
  const actor = await requireApiActor();
  const p = parseWith(invoiceIdParamsSchema, params);
  const file = await readInvoiceFile(getDatabase(), getSupplierInvoiceStorage(), actor, p.invoiceId);

  return {
    response: new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": attachmentDisposition(file.fileName),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    }),
  };
});

/** Attaches (or replaces) a draft or disputed invoice's scanned copy. */
export const POST = apiRoute<{ invoiceId: string }>({ module: "inventory", operation: "upload-supplier-invoice-file" }, async ({ request, params }) => {
  const actor = await requireApiActor();
  const p = parseWith(invoiceIdParamsSchema, params);
  const declaredLength = Number(request.headers.get("content-length"));

  if (!declaredLength) {
    throw new ValidationError("The upload must declare its length.");
  }

  if (declaredLength > INVOICE_FILE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw new ValidationError("The file is too large.");
  }

  const form = await request.formData().catch(() => {
    throw new ValidationError("The upload must be multipart form data.");
  });
  const file = form.get("file");

  if (!(file instanceof File)) {
    throw new ValidationError("Choose a file to upload.");
  }

  const { expectedVersion } = parseWith(z.object({ expectedVersion: z.coerce.number().int().positive() }), {
    expectedVersion: form.get("expectedVersion"),
  });

  return {
    body: await uploadInvoiceFile(getDatabase(), getSupplierInvoiceStorage(), actor, p.invoiceId, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      fileName: file.name || "invoice",
      expectedVersion,
    }),
    status: 201,
  };
});
