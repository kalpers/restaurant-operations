import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { employeeDocuments } from "@/db/schema";
import { LocalFileStorage } from "@/infrastructure/storage/local-file-storage";
import { addCertification } from "@/modules/employees/services/certification-service";
import {
  listDocuments,
  readDocumentForDownload,
  uploadDocument,
} from "@/modules/employees/services/document-service";
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";

import {
  ABSENT_ID,
  actorWith,
  clearEmployeeData,
  createCertificationTypeFixture,
  createEmployeeFixture,
  createHrScenario,
  type HrScenario,
} from "../../fixtures/employee-fixtures";

const database = () => getDatabase();
const PDF_BYTES = Buffer.from("%PDF-1.7\nfixture");
const MAX_BYTES = 1024;

describe("employee documents", () => {
  let scenario: HrScenario;
  let employeeId: string;
  let root: string;
  let storage: LocalFileStorage;

  beforeAll(async () => {
    scenario = await createHrScenario(database());
    ({ id: employeeId } = await createEmployeeFixture(database(), scenario.owner));
    root = await mkdtemp(path.join(tmpdir(), "hr-documents-"));
    storage = new LocalFileStorage(root);
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const upload = (
    actor: HrScenario["owner"],
    overrides: Partial<Parameters<typeof uploadDocument>[3]> = {},
  ) =>
    uploadDocument(database(), storage, actor, {
      employeeId,
      documentType: "CONTRACT",
      name: "Employment contract.pdf",
      description: null,
      sensitive: true,
      mimeType: "application/pdf",
      bytes: PDF_BYTES,
      maxBytes: MAX_BYTES,
      ...overrides,
    });

  it("stores the file outside PostgreSQL and only metadata in it", async () => {
    const document = await upload(scenario.owner);
    const [row] = await database()
      .select()
      .from(employeeDocuments)
      .where(eq(employeeDocuments.id, document.id));

    expect(row).toMatchObject({
      name: "Employment contract.pdf",
      mimeType: "application/pdf",
      fileSize: PDF_BYTES.length,
      sensitive: true,
      uploadedByUserId: scenario.owner.userId,
    });
    expect(row?.storageKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.storageKey).not.toContain("contract");
    expect(await readdir(root)).toContain(row?.storageKey);
  });

  it("keeps the storage root outside the public directory", () => {
    expect(path.relative(path.resolve("public"), root).startsWith("..")).toBe(true);
    expect(() => new LocalFileStorage("public/hr-files")).toThrow();
  });

  it("never exposes the storage key in a response", async () => {
    const created = await upload(scenario.owner);
    const listed = await listDocuments(database(), scenario.owner, employeeId);

    expect(created).not.toHaveProperty("storageKey");
    expect(listed[0]).not.toHaveProperty("storageKey");
    expect(JSON.stringify(listed)).not.toContain(root);
  });

  it("downloads the exact bytes for an authorized actor", async () => {
    const { id: documentId } = await upload(scenario.owner);
    const download = await readDocumentForDownload(
      database(),
      storage,
      scenario.owner,
      { employeeId, documentId },
    );

    expect(download.bytes.equals(PDF_BYTES)).toBe(true);
    expect(download).toMatchObject({
      name: "Employment contract.pdf",
      mimeType: "application/pdf",
    });
  });

  it("uses the server's key, whatever the display name says", async () => {
    const document = await upload(scenario.owner, {
      name: "../../../etc/passwd",
    });
    const [row] = await database()
      .select({ key: employeeDocuments.storageKey })
      .from(employeeDocuments)
      .where(eq(employeeDocuments.id, document.id));

    expect(row?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readdir(root)).toContain(row?.key);
  });

  describe("authorization", () => {
    let sensitiveId: string;
    let ordinaryId: string;

    beforeAll(async () => {
      ({ id: sensitiveId } = await upload(scenario.owner, { name: "Sensitive" }));
      ({ id: ordinaryId } = await upload(scenario.owner, {
        name: "Ordinary",
        sensitive: false,
      }));
    });

    const download = (actor: HrScenario["owner"], documentId: string) =>
      readDocumentForDownload(database(), storage, actor, {
        employeeId,
        documentId,
      });

    it("denies employees.view alone, even knowing a document ID", async () => {
      const viewer = await actorWith(database(), scenario, ["employees.view"]);

      await expect(
        listDocuments(database(), viewer, employeeId),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(download(viewer, sensitiveId)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(download(viewer, ordinaryId)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("hr.documents.view reaches only non-sensitive documents", async () => {
      const actor = await actorWith(database(), scenario, ["hr.documents.view"]);
      const listed = await listDocuments(database(), actor, employeeId);

      expect(listed.every((document) => !document.sensitive)).toBe(true);
      expect(listed.map((document) => document.id)).toContain(ordinaryId);
      await expect(download(actor, ordinaryId)).resolves.toBeDefined();
      await expect(download(actor, sensitiveId)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("the sensitive permission reaches sensitive documents", async () => {
      const actor = await actorWith(database(), scenario, [
        "hr.documents.view",
        "hr.documents.sensitive.view",
      ]);

      await expect(download(actor, sensitiveId)).resolves.toBeDefined();
    });

    it("the sensitive permission alone isn't enough", async () => {
      const actor = await actorWith(database(), scenario, [
        "hr.documents.sensitive.view",
      ]);

      await expect(download(actor, sensitiveId)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("needs the sensitive manage permission to upload a sensitive document", async () => {
      const actor = await actorWith(database(), scenario, ["hr.documents.manage"]);

      await expect(upload(actor)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(upload(actor, { sensitive: false })).resolves.toBeDefined();
    });

    it("writes no file when the upload is refused", async () => {
      const viewer = await actorWith(database(), scenario, ["employees.view"]);
      const before = await readdir(root);

      await expect(upload(viewer)).rejects.toBeInstanceOf(AuthorizationError);

      expect(await readdir(root)).toEqual(before);
    });

    it("can't reach a document through the wrong employee", async () => {
      const other = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        readDocumentForDownload(database(), storage, scenario.owner, {
          employeeId: other.id,
          documentId: sensitiveId,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("treats an employee in another organization as not found", async () => {
      const outsider = await createHrScenario(database());

      await expect(
        readDocumentForDownload(database(), storage, outsider.owner, {
          employeeId,
          documentId: sensitiveId,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("reports an unknown document, and a missing file, as not found", async () => {
      await expect(download(scenario.owner, ABSENT_ID)).rejects.toBeInstanceOf(
        NotFoundError,
      );

      const { id } = await upload(scenario.owner, { name: "Removed" });
      const [row] = await database()
        .select({ key: employeeDocuments.storageKey })
        .from(employeeDocuments)
        .where(eq(employeeDocuments.id, id));

      await storage.remove(row!.key);

      await expect(download(scenario.owner, id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe("validation", () => {
    it("rejects an over-size file before storing anything", async () => {
      const before = await readdir(root);

      await expect(
        upload(scenario.owner, {
          bytes: Buffer.alloc(MAX_BYTES + 1, 0x41),
          mimeType: "text/plain",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await readdir(root)).toEqual(before);
    });

    it("rejects an unsupported type, and contents that don't match their type", async () => {
      const before = await readdir(root);

      await expect(
        upload(scenario.owner, { mimeType: "text/html" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        upload(scenario.owner, { bytes: Buffer.from("<script>") }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await readdir(root)).toEqual(before);
    });

    it("rejects a document for an out-of-scope employee without storing it", async () => {
      const before = await readdir(root);

      await expect(
        upload(scenario.owner, { employeeId: ABSENT_ID }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(await readdir(root)).toEqual(before);
    });

    it("removes the file just written when the metadata insert fails", async () => {
      const before = await readdir(root);

      await expect(
        // The CHECK constraint refuses this type after the file has been written.
        upload(scenario.owner, { documentType: "NOT_A_TYPE" }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });

      expect(await readdir(root)).toEqual(before);
    });

    it("still reports the database failure when cleanup fails too", async () => {
      vi.spyOn(storage, "remove").mockRejectedValueOnce(new Error("disk"));

      await expect(
        upload(scenario.owner, { documentType: "NOT_A_TYPE" }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  describe("certificates", () => {
    it("links only a document that belongs to the same employee", async () => {
      const typeId = await createCertificationTypeFixture(
        database(),
        scenario.organizationId,
      );
      const document = await upload(scenario.owner, { sensitive: false });
      const other = await createEmployeeFixture(database(), scenario.owner);
      const details = {
        certificationTypeId: typeId,
        certificationNumber: null,
        issuedDate: null,
        expirationDate: null,
        documentId: document.id,
      };

      await expect(
        addCertification(database(), scenario.owner, employeeId, details),
      ).resolves.toBeDefined();
      await expect(
        addCertification(database(), scenario.owner, other.id, details),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
