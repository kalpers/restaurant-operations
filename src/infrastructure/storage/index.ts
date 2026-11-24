import { getEnv } from "@/config/env";

import type { FileStorageService } from "./file-storage-service";
import { LocalFileStorage } from "./local-file-storage";

let employeeDocumentStorage: FileStorageService | undefined;
let supplierInvoiceStorage: FileStorageService | undefined;

/** The one place that chooses the adapter. A later S3 adapter is selected here. */
export function getEmployeeDocumentStorage(): FileStorageService {
  employeeDocumentStorage ??= new LocalFileStorage(
    getEnv().EMPLOYEE_DOCUMENT_STORAGE_PATH,
  );

  return employeeDocumentStorage;
}

/** Phase 36 (policy 8): scanned supplier invoices, in their own root. */
export function getSupplierInvoiceStorage(): FileStorageService {
  supplierInvoiceStorage ??= new LocalFileStorage(getEnv().SUPPLIER_INVOICE_STORAGE_PATH);

  return supplierInvoiceStorage;
}
