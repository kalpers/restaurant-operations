import type { Database } from "@/db";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  type DatabaseExecutor,
  type DatabaseTransaction,
  withExecutorTransaction,
  withTransaction,
} from "@/db/transactions/transaction-context";
import { auditedRead, changedFieldNames, recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { ConflictError, NotFoundError } from "@/shared/errors/app-error";

import type { EmployeePersonalDetail } from "../dto/employee-dto";
import {
  findPersonalRow,
  updateEmployeeRow,
} from "../repositories/employee-repository";
import {
  clearPrimaryContact,
  endAddressRow,
  findAddressById,
  findAddresses,
  findEmergencyContacts,
  findOpenAddressOfType,
  insertAddress,
  insertEmergencyContact,
  updateEmergencyContactRow,
} from "../repositories/personal-repository";
import { assertEndDateAllowed, previousDay } from "../rules/employee-rules";
import {
  assertPermission,
  lockEmployee,
  requireEmployee,
  todayAtActorLocation,
} from "./access";

export async function getEmployeePersonal(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
): Promise<EmployeePersonalDetail> {
  assertPermission(actor, "hr.personal.view");

  return auditedRead(
    executor,
    actor,
    { action: "hr.personal-viewed", entityId: employeeId, details: { employeeId, kind: "PERSONAL" } },
    async (transaction) => {
      await requireEmployee(transaction, actor, employeeId);

      const personal = await findPersonalRow(transaction, employeeId);

      if (!personal) {
        throw new NotFoundError("employee");
      }

      return {
        ...personal,
        addresses: await findAddresses(transaction, employeeId),
        emergencyContacts: await findEmergencyContacts(transaction, employeeId),
      };
    },
  );
}

export async function updatePersonalContact(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
  input: {
    personalEmail: string | null;
    phone: string | null;
    expectedVersion: number;
  },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "hr.personal.edit");

  const { expectedVersion, ...changes } = input;

  return withExecutorTransaction(executor, async (transaction) => {
    await requireEmployee(transaction, actor, employeeId);

    const before = await findPersonalRow(transaction, employeeId);
    const result = assertVersionMatched(
      await updateEmployeeRow(transaction, employeeId, expectedVersion, changes),
      { type: "employee", id: employeeId },
    );

    await auditPersonal(transaction, actor, employeeId, "CONTACT", null, {
      changedFields: changedFieldNames(before ?? {}, changes, ["personalEmail", "phone"]),
    });

    return result;
  });
}

/** A new address closes the open one of the same type the day before, keeping history. */
export async function addAddress(
  database: Database,
  actor: Actor,
  employeeId: string,
  input: {
    addressType: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    effectiveFrom: string;
  },
) {
  assertPermission(actor, "hr.personal.edit");

  return withTransaction(database, async (transaction) => {
    await lockEmployee(transaction, actor, employeeId);

    const open = await findOpenAddressOfType(
      transaction,
      employeeId,
      input.addressType,
    );

    if (open) {
      if (input.effectiveFrom <= open.effectiveFrom) {
        throw new ConflictError(
          "ADDRESS_OVERLAP",
          "A new address must start after the current address's start date.",
        );
      }

      await endAddressRow(
        transaction,
        open.id,
        previousDay(input.effectiveFrom),
      );
    }

    const created = await insertAddress(transaction, { ...input, employeeId });

    await auditPersonal(transaction, actor, employeeId, "ADDRESS_ADDED", created.id, {
      changedFields: ["addressType", "addressLine1", "addressLine2", "city", "state", "postalCode", "country", "effectiveFrom"],
    });

    return created;
  });
}

export async function endAddress(
  database: Database,
  actor: Actor,
  input: { employeeId: string; addressId: string; effectiveTo: string },
): Promise<void> {
  assertPermission(actor, "hr.personal.edit");

  await withTransaction(database, async (transaction) => {
    await lockEmployee(transaction, actor, input.employeeId);

    const address = await findAddressById(
      transaction,
      input.employeeId,
      input.addressId,
    );

    if (!address || address.effectiveTo !== null) {
      throw new NotFoundError("address");
    }

    assertEndDateAllowed({
      from: address.effectiveFrom,
      to: input.effectiveTo,
      today: await todayAtActorLocation(transaction, actor),
    });

    await endAddressRow(transaction, address.id, input.effectiveTo);
    await auditPersonal(transaction, actor, input.employeeId, "ADDRESS_ENDED", address.id, {
      changedFields: ["effectiveTo"],
    });
  });
}

type ContactInput = {
  name: string;
  relationship: string;
  phone: string;
  alternatePhone: string | null;
  email: string | null;
  primaryContact: boolean;
};

/** Marking a contact primary demotes the previous one, which stays on record. */
export async function addEmergencyContact(
  database: Database,
  actor: Actor,
  employeeId: string,
  input: ContactInput,
) {
  assertPermission(actor, "hr.personal.edit");

  return withTransaction(database, async (transaction) => {
    await lockEmployee(transaction, actor, employeeId);

    if (input.primaryContact) {
      await clearPrimaryContact(transaction, employeeId);
    }

    const created = await insertEmergencyContact(transaction, { ...input, employeeId });

    await auditPersonal(transaction, actor, employeeId, "EMERGENCY_CONTACT_ADDED", created.id, {
      changedFields: Object.keys(input),
    });

    return created;
  });
}

export async function updateEmergencyContact(
  database: Database,
  actor: Actor,
  input: { employeeId: string; contactId: string; changes: ContactInput },
) {
  assertPermission(actor, "hr.personal.edit");

  return withTransaction(database, async (transaction) => {
    await lockEmployee(transaction, actor, input.employeeId);

    if (input.changes.primaryContact) {
      await clearPrimaryContact(transaction, input.employeeId);
    }

    const contact = await updateEmergencyContactRow(
      transaction,
      input.employeeId,
      input.contactId,
      input.changes,
    );

    if (!contact) {
      throw new NotFoundError("emergency contact");
    }

    await auditPersonal(transaction, actor, input.employeeId, "EMERGENCY_CONTACT_UPDATED", input.contactId, {
      changedFields: Object.keys(input.changes),
    });

    return contact;
  });
}

/** Personal-data changes record which fields changed, never their values. */
function auditPersonal(
  transaction: DatabaseTransaction,
  actor: Actor,
  employeeId: string,
  kind: string,
  recordId: string | null,
  details: { changedFields: string[] },
): Promise<void> {
  return recordAudit(transaction, actor, {
    action: "hr.personal-updated",
    entityId: employeeId,
    details: { employeeId, recordId, kind, ...details },
  });
}
