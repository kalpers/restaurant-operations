import { tmpdir } from "node:os";
import path from "node:path";

/** Disposable. E2E documents never go in the permanent development storage. */
export const E2E_DOCUMENT_STORAGE_PATH = path.join(
  tmpdir(),
  "restaurant-ops-e2e-hr-files",
);
