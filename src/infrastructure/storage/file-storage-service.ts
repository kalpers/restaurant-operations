/**
 * Where uploaded files live. Domains depend on this interface only, so a later S3
 * adapter doesn't change them. PostgreSQL holds metadata and the storage key.
 */
export interface FileStorageService {
  /** Stores new bytes under a server-generated key and returns that key. */
  put(bytes: Uint8Array): Promise<string>;
  /** Raises `StoredFileNotFoundError` when no file has this key. */
  get(storageKey: string): Promise<Buffer>;
  /** Succeeds when no file has this key, so cleanup can safely be retried. */
  remove(storageKey: string): Promise<void>;
}

export class StoredFileNotFoundError extends Error {
  constructor() {
    super("The stored file was not found.");
    this.name = "StoredFileNotFoundError";
  }
}
