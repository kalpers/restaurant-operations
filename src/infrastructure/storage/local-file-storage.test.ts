import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StoredFileNotFoundError } from "./file-storage-service";
import { LocalFileStorage } from "./local-file-storage";

describe("LocalFileStorage", () => {
  let parent: string;
  let root: string;
  let storage: LocalFileStorage;

  beforeEach(async () => {
    parent = await mkdtemp(path.join(tmpdir(), "hr-storage-"));
    root = path.join(parent, "files");
    storage = new LocalFileStorage(root);
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("stores bytes under a generated key and reads them back", async () => {
    const key = await storage.put(Buffer.from("hello"));

    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect((await storage.get(key)).toString()).toBe("hello");
    expect(await readdir(root)).toEqual([key]);
  });

  it("gives each file its own key", async () => {
    const first = await storage.put(Buffer.from("a"));
    const second = await storage.put(Buffer.from("b"));

    expect(first).not.toBe(second);
  });

  it.each([
    "../secret.txt",
    "..\\secret.txt",
    "../../etc/passwd",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "subfolder/file",
    "",
  ])("refuses the key %j and can't escape the root", async (key) => {
    const outside = path.join(parent, "secret.txt");

    await writeFile(outside, "secret");

    await expect(storage.get(key)).rejects.toThrow("Invalid storage key");
    await expect(storage.remove(key)).rejects.toThrow("Invalid storage key");
    expect(await readdir(parent)).toContain("secret.txt");
  });

  it("reports a missing file", async () => {
    await expect(
      storage.get("00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(StoredFileNotFoundError);
  });

  it("removes a file, and removing it again succeeds", async () => {
    const key = await storage.put(Buffer.from("a"));

    await storage.remove(key);
    await storage.remove(key);

    await expect(storage.get(key)).rejects.toBeInstanceOf(
      StoredFileNotFoundError,
    );
  });

  it.each(["public", "public/hr", "./public/hr/files"])(
    "refuses a root under the public directory: %s",
    (candidate) => {
      expect(() => new LocalFileStorage(candidate, parent)).toThrow(
        "outside the public directory",
      );
    },
  );

  it("accepts a sibling whose name only starts with public", () => {
    expect(() => new LocalFileStorage("public-files", parent)).not.toThrow();
  });
});
