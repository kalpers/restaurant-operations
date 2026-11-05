import { dateRange, humanize, optionsFrom } from "@/components/employees/format";
import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import type { Actor } from "@/modules/auth/types";
import { actorHolds } from "@/modules/employees/services/access";
import { getEmployeePersonal } from "@/modules/employees/services/personal-service";
import { ADDRESS_TYPES } from "@/modules/employees/types";

export async function PersonalSection({
  actor,
  employeeId,
}: {
  actor: Actor;
  employeeId: string;
}) {
  const personal = await getEmployeePersonal(getDatabase(), actor, employeeId);
  const canEdit = actorHolds(actor, "hr.personal.edit");
  const base = `/api/employees/${employeeId}`;

  return (
    <div className="grid gap-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold">Personal contact</h2>
        {canEdit ? (
          <EntityForm
            method="PATCH"
            url={`${base}/personal`}
            submitLabel="Save personal contact"
            hidden={{ expectedVersion: personal.version }}
            fields={[
              { name: "personalEmail", label: "Personal email", type: "email", defaultValue: personal.personalEmail },
              { name: "phone", label: "Phone", defaultValue: personal.phone },
            ]}
          />
        ) : (
          <dl className="grid gap-2">
            <div>
              <dt className="text-sm text-neutral-600">Personal email</dt>
              <dd className="break-all">{personal.personalEmail ?? "None"}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-600">Phone</dt>
              <dd>{personal.phone ?? "None"}</dd>
            </div>
          </dl>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Addresses</h2>
        <ul className="mb-4 grid gap-3">
          {personal.addresses.map((address) => (
            <li key={address.id} className="rounded border border-neutral-200 p-3">
              <p className="font-medium">{humanize(address.addressType)}</p>
              <p>
                {address.addressLine1}
                {address.addressLine2 && `, ${address.addressLine2}`}
              </p>
              <p>
                {address.city}, {address.state} {address.postalCode},{" "}
                {address.country}
              </p>
              <p className="mb-2 text-sm text-neutral-600">
                {dateRange(address.effectiveFrom, address.effectiveTo)}
              </p>
              {canEdit && address.effectiveTo === null && (
                <EntityForm
                  method="PATCH"
                  url={`${base}/addresses/${address.id}`}
                  submitLabel="End address"
                  fields={[{ name: "effectiveTo", label: "End date", type: "date", required: true }]}
                />
              )}
            </li>
          ))}
          {personal.addresses.length === 0 && (
            <li className="text-neutral-600">No addresses on record.</li>
          )}
        </ul>
        {canEdit && (
          <EntityForm
            method="POST"
            url={`${base}/addresses`}
            submitLabel="Add address"
            resetOnSuccess
            fields={[
              { name: "addressType", label: "Address type", type: "select", required: true, options: optionsFrom(ADDRESS_TYPES) },
              { name: "addressLine1", label: "Address line 1", required: true },
              { name: "addressLine2", label: "Address line 2" },
              { name: "city", label: "City", required: true },
              { name: "state", label: "State", required: true },
              { name: "postalCode", label: "Postal code", required: true },
              { name: "country", label: "Country", required: true, defaultValue: "US" },
              { name: "effectiveFrom", label: "Start date", type: "date", required: true },
            ]}
          />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Emergency contacts</h2>
        <ul className="mb-4 grid gap-3">
          {personal.emergencyContacts.map((contact) => (
            <li key={contact.id} className="rounded border border-neutral-200 p-3">
              {canEdit ? (
                <EntityForm
                  method="PATCH"
                  url={`${base}/emergency-contacts/${contact.id}`}
                  submitLabel="Save contact"
                  fields={[
                    { name: "name", label: "Name", required: true, defaultValue: contact.name },
                    { name: "relationship", label: "Relationship", required: true, defaultValue: contact.relationship },
                    { name: "phone", label: "Phone", required: true, defaultValue: contact.phone },
                    { name: "alternatePhone", label: "Alternate phone", defaultValue: contact.alternatePhone },
                    { name: "email", label: "Email", type: "email", defaultValue: contact.email },
                    { name: "primaryContact", label: "Primary contact", type: "checkbox", defaultValue: contact.primaryContact },
                  ]}
                />
              ) : (
                <>
                  <p className="font-medium">
                    {contact.name}
                    {contact.primaryContact && " (primary)"}
                  </p>
                  <p>
                    {contact.relationship}, {contact.phone}
                  </p>
                </>
              )}
            </li>
          ))}
          {personal.emergencyContacts.length === 0 && (
            <li className="text-neutral-600">No emergency contacts on record.</li>
          )}
        </ul>
        {canEdit && (
          <EntityForm
            method="POST"
            url={`${base}/emergency-contacts`}
            submitLabel="Add contact"
            resetOnSuccess
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "relationship", label: "Relationship", required: true },
              { name: "phone", label: "Phone", required: true },
              { name: "alternatePhone", label: "Alternate phone" },
              { name: "email", label: "Email", type: "email" },
              { name: "primaryContact", label: "Primary contact", type: "checkbox" },
            ]}
          />
        )}
      </section>
    </div>
  );
}
