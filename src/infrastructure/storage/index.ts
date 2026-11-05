import { getEnv } from "@/config/env";

import type { FileStorageService } from "./file-storage-service";
import { LocalFileStorage } from "./local-file-storage";

let employeeDocumentStorage: FileStorageService | undefined;

/** The one place that chooses the adapter. A later S3 adapter is selected here. */
export function getEmployeeDocumentStorage(): FileStorageService {
  employeeDocumentStorage ??= new LocalFileStorage(
    getEnv().EMPLOYEE_DOCUMENT_STORAGE_PATH,
  );

  return employeeDocumentStorage;
}
