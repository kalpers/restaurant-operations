import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { employeeAddresses, employeeEmergencyContacts } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

/** Restricted. Only the personal-data service calls this file. */

const ADDRESS_COLUMNS = {
  id: employeeAddresses.id,
  addressType: employeeAddresses.addressType,
  addressLine1: employeeAddresses.addressLine1,
  addressLine2: employeeAddresses.addressLine2,
  city: employeeAddresses.city,
  state: employeeAddresses.state,
  postalCode: employeeAddresses.postalCode,
  country: employeeAddresses.country,
  effectiveFrom: employeeAddresses.effectiveFrom,
  effectiveTo: employeeAddresses.effectiveTo,
};

export function findAddresses(executor: DatabaseExecutor, employeeId: string) {
  return executor
    .select(ADDRESS_COLUMNS)
    .from(employeeAddresses)
    .where(eq(employeeAddresses.employeeId, employeeId))
    .orderBy(asc(employeeAddresses.addressType), desc(employeeAddresses.effectiveFrom));
}

export async function findAddressById(
  executor: DatabaseExecutor,
  employeeId: string,
  addressId: string,
) {
  const [address] = await executor
    .select(ADDRESS_COLUMNS)
    .from(employeeAddresses)
    .where(
      and(
        eq(employeeAddresses.id, addressId),
        eq(employeeAddresses.employeeId, employeeId),
      ),
    );

  return address;
}

export async function findOpenAddressOfType(
  executor: DatabaseExecutor,
  employeeId: string,
  addressType: string,
) {
  const [address] = await executor
    .select({
      id: employeeAddresses.id,
      effectiveFrom: employeeAddresses.effectiveFrom,
    })
    .from(employeeAddresses)
    .where(
      and(
        eq(employeeAddresses.employeeId, employeeId),
        eq(employeeAddresses.addressType, addressType),
        isNull(employeeAddresses.effectiveTo),
      ),
    );

  return address;
}

export async function endAddressRow(
  executor: DatabaseExecutor,
  addressId: string,
  effectiveTo: string,
): Promise<void> {
  await executor
    .update(employeeAddresses)
    .set({ effectiveTo })
    .where(eq(employeeAddresses.id, addressId));
}

export async function insertAddress(
  executor: DatabaseExecutor,
  values: {
    employeeId: string;
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
  const [address] = await executor
    .insert(employeeAddresses)
    .values(values)
    .returning(ADDRESS_COLUMNS);

  if (!address) {
    throw new Error("Address insert returned no row.");
  }

  return address;
}

const CONTACT_COLUMNS = {
  id: employeeEmergencyContacts.id,
  name: employeeEmergencyContacts.name,
  relationship: employeeEmergencyContacts.relationship,
  phone: employeeEmergencyContacts.phone,
  alternatePhone: employeeEmergencyContacts.alternatePhone,
  email: employeeEmergencyContacts.email,
  primaryContact: employeeEmergencyContacts.primaryContact,
};

export function findEmergencyContacts(
  executor: DatabaseExecutor,
  employeeId: string,
) {
  return executor
    .select(CONTACT_COLUMNS)
    .from(employeeEmergencyContacts)
    .where(eq(employeeEmergencyContacts.employeeId, employeeId))
    .orderBy(
      desc(employeeEmergencyContacts.primaryContact),
      asc(employeeEmergencyContacts.name),
    );
}

export async function clearPrimaryContact(
  executor: DatabaseExecutor,
  employeeId: string,
): Promise<void> {
  await executor
    .update(employeeEmergencyContacts)
    .set({ primaryContact: false })
    .where(
      and(
        eq(employeeEmergencyContacts.employeeId, employeeId),
        eq(employeeEmergencyContacts.primaryContact, true),
      ),
    );
}

type ContactFields = {
  name: string;
  relationship: string;
  phone: string;
  alternatePhone: string | null;
  email: string | null;
  primaryContact: boolean;
};

export async function insertEmergencyContact(
  executor: DatabaseExecutor,
  values: ContactFields & { employeeId: string },
) {
  const [contact] = await executor
    .insert(employeeEmergencyContacts)
    .values(values)
    .returning(CONTACT_COLUMNS);

  if (!contact) {
    throw new Error("Emergency contact insert returned no row.");
  }

  return contact;
}

export async function updateEmergencyContactRow(
  executor: DatabaseExecutor,
  employeeId: string,
  contactId: string,
  changes: ContactFields,
) {
  const [contact] = await executor
    .update(employeeEmergencyContacts)
    .set(changes)
    .where(
      and(
        eq(employeeEmergencyContacts.id, contactId),
        eq(employeeEmergencyContacts.employeeId, employeeId),
      ),
    )
    .returning(CONTACT_COLUMNS);

  return contact;
}
