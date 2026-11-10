import type { Database } from "@/db";
import {
  type DatabaseExecutor,
  withExecutorTransaction,
  withTransaction,
} from "@/db/transactions/transaction-context";
import type { FileStorageService } from "@/infrastructure/storage/file-storage-service";
import { StoredFileNotFoundError } from "@/infrastructure/storage/file-storage-service";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";

import type { EmployeeDocumentView } from "../dto/employee-dto";
import {
  findDocumentForDownload,
  findDocumentRows,
  insertDocument,
} from "../repositories/hr-record-repository";
import {
  assertDocumentAcceptable,
  normalizeMimeType,
} from "../rules/document-policy";
import { actorHolds, assertPermission, requireEmployee } from "./access";

/** Sensitive rows are filtered in the query, so they never reach an unauthorized caller. */
export async function listDocuments(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
): Promise<EmployeeDocumentView[]> {
  assertPermission(actor, "hr.documents.view");
  await requireEmployee(executor, actor, employeeId);

  return findDocumentRows(executor, employeeId, {
    includeSensitive: actorHolds(actor, "hr.documents.sensitive.view"),
  });
}

/**
 * Authorizes before touching the bytes, and writes the file before the metadata, outside
 * any transaction. If the insert fails, the file just written is removed; if removal
 * fails too, an unreferenced file remains, which is harmless and holds no metadata.
 */
export async function uploadDocument(
  database: Database,
  storage: FileStorageService,
  actor: Actor,
  input: {
    employeeId: string;
    documentType: string;
    name: string;
    description: string | null;
    sensitive: boolean;
    mimeType: string;
    bytes: Uint8Array;
    maxBytes: number;
  },
): Promise<EmployeeDocumentView> {
  assertPermission(actor, "hr.documents.manage");

  if (input.sensitive) {
    assertPermission(actor, "hr.documents.sensitive.manage");
  }

  await requireEmployee(database, actor, input.employeeId);

  const mimeType = normalizeMimeType(input.mimeType);

  assertDocumentAcceptable({
    bytes: input.bytes,
    mimeType,
    maxBytes: input.maxBytes,
  });

  const storageKey = await storage.put(input.bytes);

  try {
    return await withTransaction(database, async (transaction) => {
      const document = await insertDocument(transaction, {
        employeeId: input.employeeId,
        documentType: input.documentType,
        name: input.name,
        description: input.description,
        storageKey,
        mimeType,
        fileSize: input.bytes.length,
        sensitive: input.sensitive,
        uploadedByUserId: actor.userId,
      });

      await recordAudit(transaction, actor, {
        action: "hr.record-created",
        entityId: input.employeeId,
        details: {
          employeeId: input.employeeId,
          recordId: document.id,
          kind: input.sensitive ? "SENSITIVE_DOCUMENT" : "DOCUMENT",
        },
      });

      return document;
    });
  } catch (error) {
    await storage.remove(storageKey).catch(() => undefined);

    throw error;
  }
}

/** The only way to a file. There is no public URL, and every download is authorized. */
export async function readDocumentForDownload(
  executor: DatabaseExecutor,
  storage: FileStorageService,
  actor: Actor,
  input: { employeeId: string; documentId: string },
): Promise<{ name: string; mimeType: string; bytes: Buffer }> {
  assertPermission(actor, "hr.documents.view");

  // Authorize and record the download together; the bytes are read after commit, because
  // file storage is never called inside a transaction.
  const document = await withExecutorTransaction(executor, async (transaction) => {
    await requireEmployee(transaction, actor, input.employeeId);

    const found = await findDocumentForDownload(
      transaction,
      input.employeeId,
      input.documentId,
    );

    if (!found) {
      throw new NotFoundError("document");
    }

    if (found.sensitive && !actorHolds(actor, "hr.documents.sensitive.view")) {
      throw new AuthorizationError();
    }

    await recordAudit(transaction, actor, {
      action: "hr.document-downloaded",
      entityId: input.employeeId,
      details: {
        employeeId: input.employeeId,
        recordId: input.documentId,
        kind: found.sensitive ? "SENSITIVE_DOCUMENT" : "DOCUMENT",
      },
    });

    return found;
  });

  try {
    return {
      name: document.name,
      mimeType: document.mimeType,
      bytes: await storage.get(document.storageKey),
    };
  } catch (error) {
    if (error instanceof StoredFileNotFoundError) {
      throw new NotFoundError("document");
    }

    throw error;
  }
}
