import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import {
  addCertification,
  listCertifications,
  updateCertification,
  verifyCertification,
} from "@/modules/employees/services/certification-service";
import {
  getEmployeeGeneral,
  listEmployees,
} from "@/modules/employees/services/employee-service";
import { addNote, listNotes, updateNote } from "@/modules/employees/services/note-service";
import {
  addAddress,
  addEmergencyContact,
  endAddress,
  getEmployeePersonal,
  updateEmergencyContact,
  updatePersonalContact,
} from "@/modules/employees/services/personal-service";
import {
  listCertificationTypes,
} from "@/modules/employees/services/reference-service";
import {
  addDisciplinaryAction,
  addPerformanceReview,
  listDisciplinaryActions,
  listPerformanceReviews,
  updateDisciplinaryAction,
  updatePerformanceReview,
} from "@/modules/employees/services/review-service";
import { getEmployeeEmployment } from "@/modules/employees/services/status-service";
import {
  AuthorizationError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  actorWith,
  clearEmployeeData,
  createCertificationTypeFixture,
  createEmployeeFixture,
  createHrScenario,
  type HrScenario,
} from "../../fixtures/employee-fixtures";

const database = () => getDatabase();

const ADDRESS = {
  addressType: "HOME",
  addressLine1: "1 Private Street",
  addressLine2: null,
  city: "Detroit",
  state: "MI",
  postalCode: "48201",
  country: "US",
  effectiveFrom: "2024-01-15",
};

const CONTACT = {
  name: "Sam Smith",
  relationship: "Sibling",
  phone: "555-0100",
  alternatePhone: null,
  email: null,
  primaryContact: true,
};

const REVIEW = {
  reviewPeriodStart: "2024-01-01",
  reviewPeriodEnd: "2024-06-30",
  reviewDate: "2024-07-01",
  status: "DRAFT",
  overallRating: 4,
  summary: "Confidential review summary",
  employeeComments: null,
};

const DISCIPLINARY = {
  actionType: "WRITTEN_WARNING",
  incidentDate: "2024-03-01",
  actionDate: "2024-03-02",
  description: "Confidential incident",
  actionTaken: "Written warning issued",
  followUpDate: null,
};

const note = (noteType: string, sensitive = false) => ({
  noteType,
  title: `${noteType} note`,
  content: `Confidential ${noteType} content`,
  sensitive,
});

describe("HR authorization", () => {
  let scenario: HrScenario;
  let employeeId: string;
  let generalViewer: Actor;

  beforeAll(async () => {
    scenario = await createHrScenario(database());
    ({ id: employeeId } = await createEmployeeFixture(database(), scenario.owner));
    generalViewer = await actorWith(database(), scenario, ["employees.view"]);

    await addAddress(database(), scenario.owner, employeeId, ADDRESS);
    await addEmergencyContact(database(), scenario.owner, employeeId, CONTACT);
    await addDisciplinaryAction(database(), scenario.owner, employeeId, DISCIPLINARY);
    await addPerformanceReview(database(), scenario.owner, employeeId, REVIEW);
    await addNote(database(), scenario.owner, employeeId, note("GENERAL"));
    await addNote(database(), scenario.owner, employeeId, note("MANAGER"));
    await addNote(database(), scenario.owner, employeeId, note("PERFORMANCE"));
    await addNote(database(), scenario.owner, employeeId, note("TRAINING", true));
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  describe("employees.view alone", () => {
    it.each<[string, (actor: Actor) => Promise<unknown>]>([
      ["personal data", (actor) => getEmployeePersonal(database(), actor, employeeId)],
      ["disciplinary records", (actor) => listDisciplinaryActions(database(), actor, employeeId)],
      ["performance reviews", (actor) => listPerformanceReviews(database(), actor, employeeId)],
      ["notes", (actor) => listNotes(database(), actor, employeeId)],
      ["certifications", (actor) => listCertifications(database(), actor, employeeId)],
      ["employment status and history", (actor) => getEmployeeEmployment(database(), actor, employeeId)],
      ["certification types", (actor) => listCertificationTypes(database(), actor)],
    ])("can't read %s", async (_label, read) => {
      await expect(read(generalViewer)).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("gets no restricted field in the list", async () => {
      const [row] = (await listEmployees(database(), generalViewer)).filter(
        (employee) => employee.id === employeeId,
      );

      expect(Object.keys(row!).sort()).toEqual([
        "employeeNumber",
        "employmentType",
        "firstName",
        "id",
        "lastName",
        "preferredName",
        "primaryLocationName",
        "primaryPositionName",
      ]);
    });

    it("gets no restricted field in the detail", async () => {
      const detail = await getEmployeeGeneral(
        database(),
        generalViewer,
        employeeId,
      );

      for (const key of [
        "employmentStatus",
        "terminationDate",
        "personalEmail",
        "phone",
        "userId",
        "addresses",
        "emergencyContacts",
        "compensation",
      ]) {
        expect(detail, key).not.toHaveProperty(key);
      }

      expect(JSON.stringify(detail)).not.toContain("Private Street");
    });
  });

  describe("employment status follows the README tier", () => {
    it("appears in the list only with hr.view", async () => {
      const withHr = await actorWith(database(), scenario, [
        "employees.view",
        "hr.view",
      ]);
      const [row] = (await listEmployees(database(), withHr)).filter(
        (employee) => employee.id === employeeId,
      );

      expect(row?.employmentStatus).toBe("ACTIVE");
    });

    it("is readable with hr.view, which grants nothing restricted", async () => {
      const withHr = await actorWith(database(), scenario, ["hr.view"]);

      expect(
        (await getEmployeeEmployment(database(), withHr, employeeId))
          .employmentStatus,
      ).toBe("ACTIVE");
      await expect(
        getEmployeePersonal(database(), withHr, employeeId),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("the right permission allows exactly its own data", () => {
    it.each<[PermissionCode, (actor: Actor) => Promise<unknown>]>([
      ["hr.personal.view", (actor) => getEmployeePersonal(database(), actor, employeeId)],
      ["hr.disciplinary.view", (actor) => listDisciplinaryActions(database(), actor, employeeId)],
      ["hr.performance.view", (actor) => listPerformanceReviews(database(), actor, employeeId)],
      ["hr.notes.view", (actor) => listNotes(database(), actor, employeeId)],
      ["hr.certifications.view", (actor) => listCertifications(database(), actor, employeeId)],
    ])("%s", async (permission, read) => {
      const actor = await actorWith(database(), scenario, [permission]);

      await expect(read(actor)).resolves.toBeDefined();
      await expect(
        permission === "hr.personal.view"
          ? listDisciplinaryActions(database(), actor, employeeId)
          : getEmployeePersonal(database(), actor, employeeId),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("returns the restricted data to its holder", async () => {
      const personal = await actorWith(database(), scenario, ["hr.personal.view"]);
      const disciplinary = await actorWith(database(), scenario, [
        "hr.disciplinary.view",
      ]);

      expect(
        (await getEmployeePersonal(database(), personal, employeeId)).addresses[0],
      ).toMatchObject({ addressLine1: "1 Private Street" });
      expect(
        (await listDisciplinaryActions(database(), disciplinary, employeeId))[0],
      ).toMatchObject({ description: "Confidential incident" });
    });
  });

  describe("view doesn't imply write", () => {
    it.each<[string, PermissionCode, (actor: Actor) => Promise<unknown>]>([
      ["personal contact", "hr.personal.view", (actor) => updatePersonalContact(database(), actor, employeeId, { personalEmail: null, phone: null, expectedVersion: 1 })],
      ["address", "hr.personal.view", (actor) => addAddress(database(), actor, employeeId, ADDRESS)],
      ["emergency contact", "hr.personal.view", (actor) => addEmergencyContact(database(), actor, employeeId, CONTACT)],
      ["disciplinary record", "hr.disciplinary.view", (actor) => addDisciplinaryAction(database(), actor, employeeId, DISCIPLINARY)],
      ["review", "hr.performance.view", (actor) => addPerformanceReview(database(), actor, employeeId, REVIEW)],
      ["note", "hr.notes.view", (actor) => addNote(database(), actor, employeeId, note("GENERAL"))],
    ])("%s", async (_label, permission, write) => {
      const actor = await actorWith(database(), scenario, [permission]);

      await expect(write(actor)).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("notes", () => {
    const titles = async (actor: Actor) =>
      (await listNotes(database(), actor, employeeId))
        .map((row) => row.title)
        .sort();

    it("filters sensitive, manager and performance notes in the query", async () => {
      const actor = await actorWith(database(), scenario, ["hr.notes.view"]);

      expect(await titles(actor)).toEqual(["GENERAL note"]);
    });

    it("shows them all with hr.notes.sensitive.view", async () => {
      const actor = await actorWith(database(), scenario, [
        "hr.notes.view",
        "hr.notes.sensitive.view",
      ]);

      expect(await titles(actor)).toEqual([
        "GENERAL note",
        "MANAGER note",
        "PERFORMANCE note",
        "TRAINING note",
      ]);
    });

    it("needs the sensitive permission to add a sensitive note of any kind", async () => {
      const actor = await actorWith(database(), scenario, ["hr.notes.manage"]);

      for (const input of [
        note("MANAGER"),
        note("PERFORMANCE"),
        note("GENERAL", true),
      ]) {
        await expect(
          addNote(database(), actor, employeeId, input),
        ).rejects.toBeInstanceOf(AuthorizationError);
      }
    });

    it("hides a sensitive note from an editor without access, by ID", async () => {
      const created = await addNote(
        database(),
        scenario.owner,
        employeeId,
        note("MANAGER"),
      );
      const actor = await actorWith(database(), scenario, ["hr.notes.manage"]);

      await expect(
        updateNote(database(), actor, {
          employeeId,
          noteId: created.id,
          expectedVersion: 1,
          changes: note("GENERAL"),
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("won't let an ordinary editor reclassify a note upward or downward", async () => {
      const created = await addNote(
        database(),
        scenario.owner,
        employeeId,
        note("GENERAL"),
      );
      const actor = await actorWith(database(), scenario, ["hr.notes.manage"]);

      await expect(
        updateNote(database(), actor, {
          employeeId,
          noteId: created.id,
          expectedVersion: 1,
          changes: note("GENERAL", true),
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("rejects a stale edit", async () => {
      const created = await addNote(
        database(),
        scenario.owner,
        employeeId,
        note("GENERAL"),
      );

      await updateNote(database(), scenario.owner, {
        employeeId,
        noteId: created.id,
        expectedVersion: 1,
        changes: { ...note("GENERAL"), title: "Edited" },
      });

      await expect(
        updateNote(database(), scenario.owner, {
          employeeId,
          noteId: created.id,
          expectedVersion: 1,
          changes: note("GENERAL"),
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });
  });

  describe("other organizations and locations", () => {
    it("treats every restricted read of an out-of-scope employee as not found", async () => {
      const other = await createHrScenario(database());

      for (const read of [
        () => getEmployeePersonal(database(), other.owner, employeeId),
        () => listDisciplinaryActions(database(), other.owner, employeeId),
        () => listPerformanceReviews(database(), other.owner, employeeId),
        () => listNotes(database(), other.owner, employeeId),
        () => listCertifications(database(), other.owner, employeeId),
        () => getEmployeeEmployment(database(), other.owner, employeeId),
      ]) {
        await expect(read()).rejects.toBeInstanceOf(NotFoundError);
      }
    });

    it("a permission at Location B doesn't reach Location A's employee", async () => {
      await expect(
        getEmployeePersonal(database(), scenario.ownerAtB, employeeId),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("personal data", () => {
    it("closes the open address of a type when a new one starts, keeping history", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await addAddress(database(), scenario.owner, id, ADDRESS);
      await addAddress(database(), scenario.owner, id, {
        ...ADDRESS,
        addressLine1: "2 New Street",
        effectiveFrom: "2024-03-01",
      });

      const { addresses } = await getEmployeePersonal(
        database(),
        scenario.owner,
        id,
      );

      expect(addresses).toHaveLength(2);
      expect(
        addresses.find((row) => row.addressLine1 === "1 Private Street"),
      ).toMatchObject({ effectiveTo: "2024-02-29" });
      expect(
        addresses.find((row) => row.addressLine1 === "2 New Street"),
      ).toMatchObject({ effectiveTo: null });
    });

    it("rejects a new address not after the open one, and ends one explicitly", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const address = await addAddress(database(), scenario.owner, id, ADDRESS);

      await expect(
        addAddress(database(), scenario.owner, id, ADDRESS),
      ).rejects.toMatchObject({ code: "ADDRESS_OVERLAP" });

      await endAddress(database(), scenario.owner, {
        employeeId: id,
        addressId: address.id,
        effectiveTo: "2024-06-30",
      });

      await expect(
        endAddress(database(), scenario.owner, {
          employeeId: id,
          addressId: address.id,
          effectiveTo: "2024-07-30",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("keeps one primary contact, demoting rather than removing the previous", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const first = await addEmergencyContact(
        database(),
        scenario.owner,
        id,
        CONTACT,
      );
      const second = await addEmergencyContact(database(), scenario.owner, id, {
        ...CONTACT,
        name: "Alex Smith",
      });

      const primaryNames = async () =>
        (await getEmployeePersonal(database(), scenario.owner, id)).emergencyContacts
          .filter((row) => row.primaryContact)
          .map((row) => row.name);

      expect(await primaryNames()).toEqual(["Alex Smith"]);

      await updateEmergencyContact(database(), scenario.owner, {
        employeeId: id,
        contactId: first.id,
        changes: CONTACT,
      });

      expect(await primaryNames()).toEqual(["Sam Smith"]);
      expect(second.id).not.toBe(first.id);
      expect(
        (await getEmployeePersonal(database(), scenario.owner, id)).emergencyContacts,
      ).toHaveLength(2);
    });

    it("won't update another employee's contact", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const other = await createEmployeeFixture(database(), scenario.owner);
      const contact = await addEmergencyContact(
        database(),
        scenario.owner,
        id,
        CONTACT,
      );

      await expect(
        updateEmergencyContact(database(), scenario.owner, {
          employeeId: other.id,
          contactId: contact.id,
          changes: CONTACT,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("reviews and disciplinary records", () => {
    it("rejects a review period that ends before it starts", async () => {
      await expect(
        addPerformanceReview(database(), scenario.owner, employeeId, {
          ...REVIEW,
          reviewPeriodStart: "2024-07-01",
          reviewPeriodEnd: "2024-01-01",
        }),
      ).rejects.toMatchObject({ httpStatus: 400 });
    });

    it("rejects a stale or misdirected review edit", async () => {
      const review = await addPerformanceReview(
        database(),
        scenario.owner,
        employeeId,
        REVIEW,
      );
      const other = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        updatePerformanceReview(database(), scenario.owner, {
          employeeId: other.id,
          reviewId: review.id,
          expectedVersion: 1,
          changes: REVIEW,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
      await expect(
        updatePerformanceReview(database(), scenario.owner, {
          employeeId,
          reviewId: review.id,
          expectedVersion: 99,
          changes: REVIEW,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("rejects an incident after the action, and a stale disciplinary edit", async () => {
      await expect(
        addDisciplinaryAction(database(), scenario.owner, employeeId, {
          ...DISCIPLINARY,
          incidentDate: "2024-04-01",
        }),
      ).rejects.toMatchObject({ httpStatus: 400 });

      const action = await addDisciplinaryAction(
        database(),
        scenario.owner,
        employeeId,
        DISCIPLINARY,
      );

      await expect(
        updateDisciplinaryAction(database(), scenario.owner, {
          employeeId,
          actionId: action.id,
          expectedVersion: 99,
          changes: DISCIPLINARY,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
      await expect(
        updateDisciplinaryAction(database(), scenario.owner, {
          employeeId,
          actionId: action.id,
          expectedVersion: 1,
          changes: { ...DISCIPLINARY, actionTaken: "Revised" },
        }),
      ).resolves.toMatchObject({ actionTaken: "Revised", version: 2 });
    });
  });

  describe("certifications", () => {
    const CERTIFICATE = {
      certificationNumber: "C-1",
      issuedDate: "2024-01-01",
      expirationDate: "2026-01-01",
      documentId: null,
    };

    it("creates a certification, unverified", async () => {
      const typeId = await createCertificationTypeFixture(
        database(),
        scenario.organizationId,
      );
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await addCertification(database(), scenario.owner, id, {
        ...CERTIFICATE,
        certificationTypeId: typeId,
      });

      expect(
        (await listCertifications(database(), scenario.owner, id))[0],
      ).toMatchObject({ verified: false, verifiedAt: null });
    });

    it("rejects a type from another organization or an inactive one", async () => {
      const other = await createHrScenario(database());
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const types = [
        await createCertificationTypeFixture(database(), other.organizationId),
        await createCertificationTypeFixture(
          database(),
          scenario.organizationId,
          { active: false },
        ),
      ];

      for (const certificationTypeId of types) {
        await expect(
          addCertification(database(), scenario.owner, id, {
            ...CERTIFICATE,
            certificationTypeId,
          }),
        ).rejects.toMatchObject({ httpStatus: 400 });
      }
    });

    it("requires an expiration date when the type does", async () => {
      const typeId = await createCertificationTypeFixture(
        database(),
        scenario.organizationId,
        { expirationRequired: true },
      );
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        addCertification(database(), scenario.owner, id, {
          ...CERTIFICATE,
          expirationDate: null,
          certificationTypeId: typeId,
        }),
      ).rejects.toMatchObject({ code: "CERTIFICATION_EXPIRATION_REQUIRED" });
    });

    it("records who verified and when, and clears it when details change", async () => {
      const typeId = await createCertificationTypeFixture(
        database(),
        scenario.organizationId,
      );
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const certification = await addCertification(
        database(),
        scenario.owner,
        id,
        { ...CERTIFICATE, certificationTypeId: typeId },
      );
      const key = { employeeId: id, certificationId: certification.id };

      await verifyCertification(database(), scenario.owner, key);

      const verified = (
        await listCertifications(database(), scenario.owner, id)
      )[0];

      expect(verified?.verified).toBe(true);
      expect(verified?.verifiedAt).toBeInstanceOf(Date);

      await expect(
        verifyCertification(database(), scenario.owner, key),
      ).rejects.toMatchObject({ code: "CERTIFICATION_ALREADY_VERIFIED" });

      await updateCertification(database(), scenario.owner, {
        ...key,
        details: { ...CERTIFICATE, certificationNumber: "C-2" },
      });

      expect(
        (await listCertifications(database(), scenario.owner, id))[0],
      ).toMatchObject({
        certificationNumber: "C-2",
        verified: false,
        verifiedAt: null,
      });
    });

    it("denies a write or verification without the manage permission", async () => {
      const typeId = await createCertificationTypeFixture(
        database(),
        scenario.organizationId,
      );
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const certification = await addCertification(
        database(),
        scenario.owner,
        id,
        { ...CERTIFICATE, certificationTypeId: typeId },
      );
      const actor = await actorWith(database(), scenario, [
        "hr.certifications.view",
      ]);

      await expect(
        addCertification(database(), actor, id, {
          ...CERTIFICATE,
          certificationTypeId: typeId,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        verifyCertification(database(), actor, {
          employeeId: id,
          certificationId: certification.id,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });
});
