import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import {
  certificationTypes,
  employeeCertifications,
  employeeDisciplinaryActions,
  employeeDocuments,
  employeeNotes,
  employeePerformanceReviews,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

// --- Certifications ---

const CERTIFICATION_COLUMNS = {
  id: employeeCertifications.id,
  certificationTypeId: employeeCertifications.certificationTypeId,
  certificationName: certificationTypes.name,
  certificationNumber: employeeCertifications.certificationNumber,
  issuedDate: employeeCertifications.issuedDate,
  expirationDate: employeeCertifications.expirationDate,
  documentId: employeeCertifications.documentId,
  verified: employeeCertifications.verified,
  verifiedAt: employeeCertifications.verifiedAt,
};

export function findCertificationRows(
  executor: DatabaseExecutor,
  employeeId: string,
) {
  return executor
    .select(CERTIFICATION_COLUMNS)
    .from(employeeCertifications)
    .innerJoin(
      certificationTypes,
      eq(certificationTypes.id, employeeCertifications.certificationTypeId),
    )
    .where(eq(employeeCertifications.employeeId, employeeId))
    .orderBy(desc(employeeCertifications.expirationDate));
}

export async function findCertificationById(
  executor: DatabaseExecutor,
  employeeId: string,
  certificationId: string,
) {
  const [row] = await executor
    .select(CERTIFICATION_COLUMNS)
    .from(employeeCertifications)
    .innerJoin(
      certificationTypes,
      eq(certificationTypes.id, employeeCertifications.certificationTypeId),
    )
    .where(
      and(
        eq(employeeCertifications.id, certificationId),
        eq(employeeCertifications.employeeId, employeeId),
      ),
    );

  return row;
}

type CertificationFields = {
  certificationNumber: string | null;
  issuedDate: string | null;
  expirationDate: string | null;
  documentId: string | null;
};

export async function insertCertification(
  executor: DatabaseExecutor,
  values: CertificationFields & {
    employeeId: string;
    certificationTypeId: string;
  },
) {
  const [row] = await executor
    .insert(employeeCertifications)
    .values(values)
    .returning({ id: employeeCertifications.id });

  if (!row) {
    throw new Error("Certification insert returned no row.");
  }

  return row;
}

/** Edited details haven't been checked by anyone, so verification is cleared. */
export async function updateCertificationRow(
  executor: DatabaseExecutor,
  certificationId: string,
  changes: CertificationFields,
): Promise<void> {
  await executor
    .update(employeeCertifications)
    .set({
      ...changes,
      verified: false,
      verifiedByUserId: null,
      verifiedAt: null,
    })
    .where(eq(employeeCertifications.id, certificationId));
}

export async function markCertificationVerified(
  executor: DatabaseExecutor,
  certificationId: string,
  verifiedByUserId: string,
): Promise<void> {
  await executor
    .update(employeeCertifications)
    .set({ verified: true, verifiedByUserId, verifiedAt: sql`now()` })
    .where(eq(employeeCertifications.id, certificationId));
}

// --- Documents ---

/** `storage_key` is deliberately absent: it never leaves the document service. */
const DOCUMENT_COLUMNS = {
  id: employeeDocuments.id,
  documentType: employeeDocuments.documentType,
  name: employeeDocuments.name,
  description: employeeDocuments.description,
  mimeType: employeeDocuments.mimeType,
  fileSize: employeeDocuments.fileSize,
  sensitive: employeeDocuments.sensitive,
  uploadedAt: employeeDocuments.uploadedAt,
};

export function findDocumentRows(
  executor: DatabaseExecutor,
  employeeId: string,
  options: { includeSensitive: boolean },
) {
  return executor
    .select(DOCUMENT_COLUMNS)
    .from(employeeDocuments)
    .where(
      and(
        eq(employeeDocuments.employeeId, employeeId),
        options.includeSensitive ? undefined : eq(employeeDocuments.sensitive, false),
      ),
    )
    .orderBy(desc(employeeDocuments.uploadedAt));
}

export async function findDocumentForDownload(
  executor: DatabaseExecutor,
  employeeId: string,
  documentId: string,
) {
  const [document] = await executor
    .select({
      id: employeeDocuments.id,
      name: employeeDocuments.name,
      mimeType: employeeDocuments.mimeType,
      sensitive: employeeDocuments.sensitive,
      storageKey: employeeDocuments.storageKey,
    })
    .from(employeeDocuments)
    .where(
      and(
        eq(employeeDocuments.id, documentId),
        eq(employeeDocuments.employeeId, employeeId),
      ),
    );

  return document;
}

export async function documentBelongsToEmployee(
  executor: DatabaseExecutor,
  employeeId: string,
  documentId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: employeeDocuments.id })
    .from(employeeDocuments)
    .where(
      and(
        eq(employeeDocuments.id, documentId),
        eq(employeeDocuments.employeeId, employeeId),
      ),
    );

  return rows.length > 0;
}

export async function insertDocument(
  executor: DatabaseExecutor,
  values: {
    employeeId: string;
    documentType: string;
    name: string;
    description: string | null;
    storageKey: string;
    mimeType: string;
    fileSize: number;
    sensitive: boolean;
    uploadedByUserId: string;
  },
) {
  const [document] = await executor
    .insert(employeeDocuments)
    .values(values)
    .returning(DOCUMENT_COLUMNS);

  if (!document) {
    throw new Error("Document insert returned no row.");
  }

  return document;
}

// --- Notes ---

const NOTE_COLUMNS = {
  id: employeeNotes.id,
  noteType: employeeNotes.noteType,
  title: employeeNotes.title,
  content: employeeNotes.content,
  sensitive: employeeNotes.sensitive,
  createdAt: employeeNotes.createdAt,
  updatedAt: employeeNotes.updatedAt,
  version: employeeNotes.version,
};

/** Mirrors `noteRequiresSensitiveAccess`, so restricted rows never leave the database. */
function notSensitiveNote(): SQL | undefined {
  return and(
    eq(employeeNotes.sensitive, false),
    sql`${employeeNotes.noteType} NOT IN ('MANAGER', 'PERFORMANCE')`,
  );
}

export function findNoteRows(
  executor: DatabaseExecutor,
  employeeId: string,
  options: { includeSensitive: boolean },
) {
  return executor
    .select(NOTE_COLUMNS)
    .from(employeeNotes)
    .where(
      and(
        eq(employeeNotes.employeeId, employeeId),
        options.includeSensitive ? undefined : notSensitiveNote(),
      ),
    )
    .orderBy(desc(employeeNotes.createdAt));
}

export async function findNoteById(
  executor: DatabaseExecutor,
  employeeId: string,
  noteId: string,
) {
  const [note] = await executor
    .select(NOTE_COLUMNS)
    .from(employeeNotes)
    .where(
      and(eq(employeeNotes.id, noteId), eq(employeeNotes.employeeId, employeeId)),
    );

  return note;
}

type NoteFields = {
  noteType: string;
  title: string;
  content: string;
  sensitive: boolean;
};

export async function insertNote(
  executor: DatabaseExecutor,
  values: NoteFields & { employeeId: string; createdByUserId: string },
) {
  const [note] = await executor
    .insert(employeeNotes)
    .values(values)
    .returning(NOTE_COLUMNS);

  if (!note) {
    throw new Error("Note insert returned no row.");
  }

  return note;
}

/** Returns no rows when the version is stale. */
export function updateNoteRow(
  executor: DatabaseExecutor,
  noteId: string,
  expectedVersion: number,
  changes: NoteFields,
) {
  return executor
    .update(employeeNotes)
    .set({ ...changes, version: nextVersion(employeeNotes.version) })
    .where(
      and(eq(employeeNotes.id, noteId), eq(employeeNotes.version, expectedVersion)),
    )
    .returning(NOTE_COLUMNS);
}

// --- Performance reviews ---

const REVIEW_COLUMNS = {
  id: employeePerformanceReviews.id,
  reviewerEmployeeId: employeePerformanceReviews.reviewerEmployeeId,
  reviewPeriodStart: employeePerformanceReviews.reviewPeriodStart,
  reviewPeriodEnd: employeePerformanceReviews.reviewPeriodEnd,
  reviewDate: employeePerformanceReviews.reviewDate,
  status: employeePerformanceReviews.status,
  overallRating: employeePerformanceReviews.overallRating,
  summary: employeePerformanceReviews.summary,
  employeeComments: employeePerformanceReviews.employeeComments,
  version: employeePerformanceReviews.version,
};

export function findReviewRows(executor: DatabaseExecutor, employeeId: string) {
  return executor
    .select(REVIEW_COLUMNS)
    .from(employeePerformanceReviews)
    .where(eq(employeePerformanceReviews.employeeId, employeeId))
    .orderBy(desc(employeePerformanceReviews.reviewDate));
}

type ReviewFields = {
  reviewPeriodStart: string;
  reviewPeriodEnd: string;
  reviewDate: string;
  status: string;
  overallRating: number | null;
  summary: string | null;
  employeeComments: string | null;
};

export async function insertReview(
  executor: DatabaseExecutor,
  values: ReviewFields & { employeeId: string; reviewerUserId: string },
) {
  const [review] = await executor
    .insert(employeePerformanceReviews)
    .values(values)
    .returning(REVIEW_COLUMNS);

  if (!review) {
    throw new Error("Review insert returned no row.");
  }

  return review;
}

/** Returns no rows when the version is stale or it's another employee's. */
export function updateReviewRow(
  executor: DatabaseExecutor,
  input: { employeeId: string; reviewId: string; expectedVersion: number },
  changes: ReviewFields,
) {
  return executor
    .update(employeePerformanceReviews)
    .set({ ...changes, version: nextVersion(employeePerformanceReviews.version) })
    .where(
      and(
        eq(employeePerformanceReviews.id, input.reviewId),
        eq(employeePerformanceReviews.employeeId, input.employeeId),
        eq(employeePerformanceReviews.version, input.expectedVersion),
      ),
    )
    .returning(REVIEW_COLUMNS);
}

// --- Disciplinary actions ---

const DISCIPLINARY_COLUMNS = {
  id: employeeDisciplinaryActions.id,
  actionType: employeeDisciplinaryActions.actionType,
  incidentDate: employeeDisciplinaryActions.incidentDate,
  actionDate: employeeDisciplinaryActions.actionDate,
  description: employeeDisciplinaryActions.description,
  actionTaken: employeeDisciplinaryActions.actionTaken,
  followUpDate: employeeDisciplinaryActions.followUpDate,
  version: employeeDisciplinaryActions.version,
};

export function findDisciplinaryRows(
  executor: DatabaseExecutor,
  employeeId: string,
) {
  return executor
    .select(DISCIPLINARY_COLUMNS)
    .from(employeeDisciplinaryActions)
    .where(eq(employeeDisciplinaryActions.employeeId, employeeId))
    .orderBy(desc(employeeDisciplinaryActions.actionDate));
}

type DisciplinaryFields = {
  actionType: string;
  incidentDate: string | null;
  actionDate: string;
  description: string;
  actionTaken: string;
  followUpDate: string | null;
};

export async function insertDisciplinaryAction(
  executor: DatabaseExecutor,
  values: DisciplinaryFields & { employeeId: string; createdByUserId: string },
) {
  const [action] = await executor
    .insert(employeeDisciplinaryActions)
    .values(values)
    .returning(DISCIPLINARY_COLUMNS);

  if (!action) {
    throw new Error("Disciplinary action insert returned no row.");
  }

  return action;
}

/** Returns no rows when the version is stale or it's another employee's. */
export function updateDisciplinaryRow(
  executor: DatabaseExecutor,
  input: { employeeId: string; actionId: string; expectedVersion: number },
  changes: DisciplinaryFields,
) {
  return executor
    .update(employeeDisciplinaryActions)
    .set({ ...changes, version: nextVersion(employeeDisciplinaryActions.version) })
    .where(
      and(
        eq(employeeDisciplinaryActions.id, input.actionId),
        eq(employeeDisciplinaryActions.employeeId, input.employeeId),
        eq(employeeDisciplinaryActions.version, input.expectedVersion),
      ),
    )
    .returning(DISCIPLINARY_COLUMNS);
}
