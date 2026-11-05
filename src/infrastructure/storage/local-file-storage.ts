import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  StoredFileNotFoundError,
  type FileStorageService,
} from "./file-storage-service";

const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Local development storage. Keys are generated UUIDs, never derived from a filename,
 * and any other key is refused before the filesystem is touched.
 */
export class LocalFileStorage implements FileStorageService {
  private readonly root: string;

  constructor(root: string, projectRoot: string = process.cwd()) {
    this.root = path.resolve(projectRoot, root);

    if (isWithin(path.resolve(projectRoot, "public"), this.root)) {
      throw new Error("File storage must be outside the public directory.");
    }
  }

  private pathFor(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new Error("Invalid storage key.");
    }

    return path.join(this.root, storageKey);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const storageKey = randomUUID();

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // "wx" fails rather than overwrites if a key ever collided.
    await writeFile(this.pathFor(storageKey), bytes, { flag: "wx", mode: 0o600 });

    return storageKey;
  }

  async get(storageKey: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(storageKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StoredFileNotFoundError();
      }

      throw error;
    }
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }
}
