import { DocumentUploadForm } from "@/components/employees/document-upload-form";
import { dateRange, humanize, optionsFrom } from "@/components/employees/format";
import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import type { Actor } from "@/modules/auth/types";
import type { EmployeeGeneralDetail } from "@/modules/employees/dto/employee-dto";
import { actorHolds } from "@/modules/employees/services/access";
import { listCertifications } from "@/modules/employees/services/certification-service";
import { getCompensationHistory } from "@/modules/employees/services/compensation-service";
import { listDocuments } from "@/modules/employees/services/document-service";
import { listNotes } from "@/modules/employees/services/note-service";
import { listCertificationTypes } from "@/modules/employees/services/reference-service";
import {
  listDisciplinaryActions,
  listPerformanceReviews,
} from "@/modules/employees/services/review-service";
import {
  COMPENSATION_TYPES,
  DISCIPLINARY_ACTION_TYPES,
  DOCUMENT_TYPES,
  NOTE_TYPES,
  REVIEW_STATUSES,
} from "@/modules/employees/types";

type SectionProps = { actor: Actor; employeeId: string };

const CARD = "rounded-lg border border-neutral-200 bg-surface shadow-sm p-3";

export async function CompensationSection({
  actor,
  employeeId,
  employee,
}: SectionProps & { employee: EmployeeGeneralDetail }) {
  const history = await getCompensationHistory(getDatabase(), actor, employeeId);
  const positionOptions = [
    ...new Map(
      employee.positions.map((assignment) => [
        assignment.positionId,
        { value: assignment.positionId, label: assignment.positionName },
      ]),
    ).values(),
  ];

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold">Compensation</h2>
      <p className="mb-3 text-sm text-neutral-600">
        Each position has its own wage. A change starts a new period and keeps the
        old one. This isn&apos;t payroll.
      </p>
      <ul className="mb-6 grid gap-3">
        {history.map((period) => (
          <li key={period.id} className={CARD}>
            <p className="font-medium">{period.positionName}</p>
            <p>
              {period.compensationType === "HOURLY"
                ? `${period.hourlyRate} per hour`
                : `${period.annualSalary} per year`}
            </p>
            <p className="text-sm text-neutral-600">
              {dateRange(period.effectiveFrom, period.effectiveTo)}
              {period.changeReason && `. ${period.changeReason}`}
            </p>
          </li>
        ))}
        {history.length === 0 && (
          <li className="text-neutral-600">No compensation on record.</li>
        )}
      </ul>
      {actorHolds(actor, "hr.compensation.edit") && (
        <>
          <h3 className="mb-2 font-medium">Set a wage</h3>
          <EntityForm
            method="POST"
            url={`/api/employees/${employeeId}/compensation`}
            submitLabel="Save wage"
            resetOnSuccess
            fields={[
              { name: "positionId", label: "Position", type: "select", required: true, options: positionOptions },
              { name: "compensationType", label: "Pay type", type: "select", required: true, options: optionsFrom(COMPENSATION_TYPES) },
              { name: "hourlyRate", label: "Hourly rate" },
              { name: "annualSalary", label: "Annual salary" },
              { name: "effectiveFrom", label: "Effective date", type: "date", required: true },
              { name: "changeReason", label: "Reason" },
            ]}
          />
        </>
      )}
    </section>
  );
}

export async function CertificationsSection({ actor, employeeId }: SectionProps) {
  const database = getDatabase();
  const certifications = await listCertifications(database, actor, employeeId);
  const canManage = actorHolds(actor, "hr.certifications.manage");
  const types = canManage
    ? (await listCertificationTypes(database, actor)).filter((type) => type.active)
    : [];
  const base = `/api/employees/${employeeId}/certifications`;

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">Certifications</h2>
      <ul className="mb-6 grid gap-3">
        {certifications.map((certification) => (
          <li key={certification.id} className={CARD}>
            <p className="font-medium">{certification.certificationName}</p>
            <p className="text-sm text-neutral-600">
              {certification.certificationNumber ?? "No number"}. Expires{" "}
              {certification.expirationDate ?? "never"}.{" "}
              {certification.verified ? "Verified." : "Not verified."}
            </p>
            {canManage && !certification.verified && (
              <div className="mt-2">
                <ActionButton
                  method="PUT"
                  url={`${base}/${certification.id}/verify`}
                  label="Mark verified"
                />
              </div>
            )}
          </li>
        ))}
        {certifications.length === 0 && (
          <li className="text-neutral-600">No certifications on record.</li>
        )}
      </ul>
      {canManage && (
        <>
          <h3 className="mb-2 font-medium">Add a certification</h3>
          <EntityForm
            method="POST"
            url={base}
            submitLabel="Add certification"
            resetOnSuccess
            fields={[
              { name: "certificationTypeId", label: "Certification", type: "select", required: true, options: types.map((type) => ({ value: type.id, label: type.name })) },
              { name: "certificationNumber", label: "Certificate number" },
              { name: "issuedDate", label: "Issued date", type: "date" },
              { name: "expirationDate", label: "Expiration date", type: "date" },
            ]}
          />
        </>
      )}
    </section>
  );
}

export async function DocumentsSection({ actor, employeeId }: SectionProps) {
  const documents = await listDocuments(getDatabase(), actor, employeeId);
  const base = `/api/employees/${employeeId}/documents`;

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">Documents</h2>
      <ul className="mb-6 grid gap-3">
        {documents.map((document) => (
          <li key={document.id} className={CARD}>
            <a href={`${base}/${document.id}`} className="font-medium break-all underline">
              {document.name}
            </a>
            <p className="text-sm text-neutral-600">
              {humanize(document.documentType)}
              {document.sensitive && ", sensitive"}
              {document.description && `. ${document.description}`}
            </p>
          </li>
        ))}
        {documents.length === 0 && (
          <li className="text-neutral-600">No documents you can view.</li>
        )}
      </ul>
      {actorHolds(actor, "hr.documents.manage") && (
        <>
          <h3 className="mb-2 font-medium">Upload a document</h3>
          <p className="mb-3 text-sm text-neutral-600">
            PDF, PNG, JPEG or plain text. Don&apos;t upload bank or card details.
          </p>
          <DocumentUploadForm
            url={base}
            documentTypes={DOCUMENT_TYPES}
            allowSensitive={actorHolds(actor, "hr.documents.sensitive.manage")}
          />
        </>
      )}
    </section>
  );
}

export async function NotesSection({ actor, employeeId }: SectionProps) {
  const notes = await listNotes(getDatabase(), actor, employeeId);
  const canManage = actorHolds(actor, "hr.notes.manage");
  const canManageSensitive = actorHolds(actor, "hr.notes.sensitive.manage");
  const noteTypes = canManageSensitive
    ? NOTE_TYPES
    : NOTE_TYPES.filter((type) => type !== "MANAGER" && type !== "PERFORMANCE");

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">Notes</h2>
      <ul className="mb-6 grid gap-3">
        {notes.map((note) => (
          <li key={note.id} className={CARD}>
            <p className="font-medium">{note.title}</p>
            <p className="text-sm text-neutral-600">
              {humanize(note.noteType)}
              {note.sensitive && ", sensitive"}
            </p>
            <p className="whitespace-pre-wrap">{note.content}</p>
          </li>
        ))}
        {notes.length === 0 && (
          <li className="text-neutral-600">No notes you can view.</li>
        )}
      </ul>
      {canManage && (
        <>
          <h3 className="mb-2 font-medium">Add a note</h3>
          <EntityForm
            method="POST"
            url={`/api/employees/${employeeId}/notes`}
            submitLabel="Add note"
            resetOnSuccess
            fields={[
              { name: "noteType", label: "Note type", type: "select", required: true, options: optionsFrom(noteTypes) },
              { name: "title", label: "Title", required: true },
              { name: "content", label: "Note", type: "textarea", required: true },
              ...(canManageSensitive
                ? [{ name: "sensitive", label: "Sensitive note", type: "checkbox" as const }]
                : []),
            ]}
          />
        </>
      )}
    </section>
  );
}

export async function PerformanceSection({ actor, employeeId }: SectionProps) {
  const reviews = await listPerformanceReviews(getDatabase(), actor, employeeId);

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">Performance reviews</h2>
      <ul className="mb-6 grid gap-3">
        {reviews.map((review) => (
          <li key={review.id} className={CARD}>
            <p className="font-medium">
              {dateRange(review.reviewPeriodStart, review.reviewPeriodEnd)}
            </p>
            <p className="text-sm text-neutral-600">
              {humanize(review.status)}, reviewed {review.reviewDate}
              {review.overallRating !== null &&
                `, rated ${review.overallRating} of 5`}
            </p>
            {review.summary && (
              <p className="whitespace-pre-wrap">{review.summary}</p>
            )}
          </li>
        ))}
        {reviews.length === 0 && (
          <li className="text-neutral-600">No performance reviews on record.</li>
        )}
      </ul>
      {actorHolds(actor, "hr.performance.manage") && (
        <>
          <h3 className="mb-2 font-medium">Add a review</h3>
          <EntityForm
            method="POST"
            url={`/api/employees/${employeeId}/performance-reviews`}
            submitLabel="Add review"
            resetOnSuccess
            fields={[
              { name: "reviewPeriodStart", label: "Period start", type: "date", required: true },
              { name: "reviewPeriodEnd", label: "Period end", type: "date", required: true },
              { name: "reviewDate", label: "Review date", type: "date", required: true },
              { name: "status", label: "Review status", type: "select", required: true, options: optionsFrom(REVIEW_STATUSES) },
              { name: "overallRating", label: "Rating (1 to 5)", type: "number" },
              { name: "summary", label: "Summary", type: "textarea" },
            ]}
          />
        </>
      )}
    </section>
  );
}

export async function DisciplinarySection({ actor, employeeId }: SectionProps) {
  const actions = await listDisciplinaryActions(
    getDatabase(),
    actor,
    employeeId,
  );

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">Disciplinary records</h2>
      <ul className="mb-6 grid gap-3">
        {actions.map((action) => (
          <li key={action.id} className={CARD}>
            <p className="font-medium">{humanize(action.actionType)}</p>
            <p className="text-sm text-neutral-600">
              {action.actionDate}
              {action.followUpDate && `, follow up ${action.followUpDate}`}
            </p>
            <p className="whitespace-pre-wrap">{action.description}</p>
            <p className="whitespace-pre-wrap">{action.actionTaken}</p>
          </li>
        ))}
        {actions.length === 0 && (
          <li className="text-neutral-600">No disciplinary records.</li>
        )}
      </ul>
      {actorHolds(actor, "hr.disciplinary.manage") && (
        <>
          <h3 className="mb-2 font-medium">Add a record</h3>
          <EntityForm
            method="POST"
            url={`/api/employees/${employeeId}/disciplinary-actions`}
            submitLabel="Add record"
            resetOnSuccess
            fields={[
              { name: "actionType", label: "Action type", type: "select", required: true, options: optionsFrom(DISCIPLINARY_ACTION_TYPES) },
              { name: "actionDate", label: "Action date", type: "date", required: true },
              { name: "incidentDate", label: "Incident date", type: "date" },
              { name: "followUpDate", label: "Follow-up date", type: "date" },
              { name: "description", label: "Description", type: "textarea", required: true },
              { name: "actionTaken", label: "Action taken", type: "textarea", required: true },
            ]}
          />
        </>
      )}
    </section>
  );
}
