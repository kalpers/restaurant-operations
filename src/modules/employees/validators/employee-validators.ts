import { z } from "zod";

import {
  ADDRESS_TYPES,
  COMPENSATION_TYPES,
  DISCIPLINARY_ACTION_TYPES,
  DOCUMENT_TYPES,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  NOTE_TYPES,
  REVIEW_STATUSES,
} from "../types";

// Shape only. Business rules are in the services and PostgreSQL has the final word.

const expectedVersion = z.int().positive();
const date = z.iso.date();
const optionalDate = date.nullable().default(null);

const requiredText = (max: number) => z.string().trim().min(1).max(max);

/** Blank becomes null, so "no value" has one representation. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((value) => (value === "" ? null : value));

const optionalEmail = z.email().max(320).nullable().default(null);

/** A decimal string. Scale and sign are the service's rule; never coerced to a number. */
const moneyString = z.string().trim().max(32).nullable().default(null);

export const employeeIdParamsSchema = z.object({ employeeId: z.uuid() });

const childParams = <Key extends string>(key: Key) =>
  z.object({ employeeId: z.uuid(), [key]: z.uuid() }) as z.ZodObject<
    { employeeId: z.ZodUUID } & Record<Key, z.ZodUUID>
  >;

export const assignmentParamsSchema = childParams("assignmentId");
export const addressParamsSchema = childParams("addressId");
export const contactParamsSchema = childParams("contactId");
export const certificationParamsSchema = childParams("certificationId");
export const documentParamsSchema = childParams("documentId");
export const noteParamsSchema = childParams("noteId");
export const reviewParamsSchema = childParams("reviewId");
export const disciplinaryParamsSchema = childParams("actionId");
export const positionParamsSchema = z.object({ positionId: z.uuid() });
export const certificationTypeParamsSchema = z.object({
  certificationTypeId: z.uuid(),
});

const nameFields = {
  firstName: requiredText(100),
  middleName: optionalText(100),
  lastName: requiredText(100),
  preferredName: optionalText(100),
  workEmail: optionalEmail,
  employmentType: z.enum(EMPLOYMENT_TYPES),
};

export const createEmployeeSchema = z.object({
  ...nameFields,
  employeeNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/),
  hireDate: date,
  positionId: z.uuid().nullable().default(null),
});

export const updateEmployeeSchema = z.object({ ...nameFields, expectedVersion });

export const updatePersonalContactSchema = z.object({
  personalEmail: optionalEmail,
  phone: optionalText(50),
  expectedVersion,
});

export const changeStatusSchema = z.object({
  status: z.enum(EMPLOYMENT_STATUSES),
  reason: optionalText(500),
  expectedVersion,
});

export const terminateEmployeeSchema = z.object({
  terminationDate: date,
  reason: optionalText(500),
  expectedVersion,
});

export const assignLocationSchema = z.object({
  locationId: z.uuid(),
  effectiveFrom: date,
  expectedVersion,
});

export const assignPositionSchema = z.object({
  positionId: z.uuid(),
  locationId: z.uuid(),
  primaryPosition: z.boolean().default(false),
  effectiveFrom: date,
  expectedVersion,
});

export const endAssignmentSchema = z.object({
  effectiveTo: date,
  expectedVersion,
});

export const setPrimarySchema = z.object({ expectedVersion });

export const linkUserSchema = z.object({ userId: z.uuid(), expectedVersion });
export const unlinkUserSchema = z.object({ expectedVersion });

export const changeCompensationSchema = z.object({
  positionId: z.uuid(),
  compensationType: z.enum(COMPENSATION_TYPES),
  hourlyRate: moneyString,
  annualSalary: moneyString,
  effectiveFrom: date,
  changeReason: optionalText(500),
});

export const addAddressSchema = z.object({
  addressType: z.enum(ADDRESS_TYPES),
  addressLine1: requiredText(200),
  addressLine2: optionalText(200),
  city: requiredText(100),
  state: requiredText(100),
  postalCode: requiredText(20),
  country: requiredText(100),
  effectiveFrom: date,
});

export const endAddressSchema = z.object({ effectiveTo: date });

export const emergencyContactSchema = z.object({
  name: requiredText(200),
  relationship: requiredText(100),
  phone: requiredText(50),
  alternatePhone: optionalText(50),
  email: optionalEmail,
  primaryContact: z.boolean().default(false),
});

const certificationDetails = {
  certificationNumber: optionalText(100),
  issuedDate: optionalDate,
  expirationDate: optionalDate,
  documentId: z.uuid().nullable().default(null),
};

export const addCertificationSchema = z.object({
  ...certificationDetails,
  certificationTypeId: z.uuid(),
});

export const updateCertificationSchema = z.object(certificationDetails);

export const documentFieldsSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  name: requiredText(200),
  description: optionalText(500),
  sensitive: z.boolean(),
});

const noteFields = {
  noteType: z.enum(NOTE_TYPES),
  title: requiredText(200),
  content: requiredText(10_000),
  sensitive: z.boolean().default(false),
};

export const addNoteSchema = z.object(noteFields);
export const updateNoteSchema = z.object({ ...noteFields, expectedVersion });

const reviewFields = {
  reviewPeriodStart: date,
  reviewPeriodEnd: date,
  reviewDate: date,
  status: z.enum(REVIEW_STATUSES).default("DRAFT"),
  overallRating: z.int().min(1).max(5).nullable().default(null),
  summary: optionalText(10_000),
  employeeComments: optionalText(10_000),
};

export const addReviewSchema = z.object(reviewFields);
export const updateReviewSchema = z.object({ ...reviewFields, expectedVersion });

const disciplinaryFields = {
  actionType: z.enum(DISCIPLINARY_ACTION_TYPES),
  incidentDate: optionalDate,
  actionDate: date,
  description: requiredText(10_000),
  actionTaken: requiredText(10_000),
  followUpDate: optionalDate,
};

export const addDisciplinarySchema = z.object(disciplinaryFields);
export const updateDisciplinarySchema = z.object({
  ...disciplinaryFields,
  expectedVersion,
});

const configCode = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,49}$/);

const positionFields = {
  name: requiredText(100),
  description: optionalText(500),
};

export const createPositionSchema = z.object({
  ...positionFields,
  code: configCode,
});

export const updatePositionSchema = z.object({
  ...positionFields,
  active: z.boolean(),
  expectedVersion,
});

const certificationTypeFields = {
  name: requiredText(100),
  description: optionalText(500),
  expirationRequired: z.boolean().default(false),
  warningDays: z.int().min(0).max(3650).nullable().default(null),
};

export const createCertificationTypeSchema = z.object({
  ...certificationTypeFields,
  code: configCode,
});

export const updateCertificationTypeSchema = z.object({
  ...certificationTypeFields,
  active: z.boolean(),
  expectedVersion,
});
