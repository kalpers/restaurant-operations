import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { money } from "../helpers/numeric";
import {
  calendarDate,
  createdAt,
  timestamptz,
  updatedAt,
} from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { locations, organizations } from "./organization";

// Overlap protection for effective-dated rows is in migration 0003, because Drizzle
// can't express exclusion constraints. Foreign keys are named here whenever the
// generated name would pass PostgreSQL's 63-character limit.

/** A job performed. Holds no wage and grants no permissions. */
export const positions = pgTable(
  "positions",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("positions_organization_id_code_unique").on(
      table.organizationId,
      table.code,
    ),
    unique("positions_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
  ],
);

/** A person employed by the restaurant. A login is optional and separate. */
export const employees = pgTable(
  "employees",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .unique()
      .references(() => users.id, { onDelete: "restrict" }),
    employeeNumber: text("employee_number").notNull(),
    firstName: text("first_name").notNull(),
    middleName: text("middle_name"),
    lastName: text("last_name").notNull(),
    preferredName: text("preferred_name"),
    personalEmail: text("personal_email"),
    workEmail: text("work_email"),
    phone: text("phone"),
    hireDate: calendarDate("hire_date").notNull(),
    terminationDate: calendarDate("termination_date"),
    employmentStatus: text("employment_status").notNull().default("ACTIVE"),
    employmentType: text("employment_type").notNull(),
    primaryLocationId: uuid("primary_location_id").references(
      () => locations.id,
      { onDelete: "restrict" },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("employees_organization_id_employee_number_unique").on(
      table.organizationId,
      table.employeeNumber,
    ),
    unique("employees_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    check(
      "employees_employment_status_valid",
      sql`${table.employmentStatus} IN ('ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED')`,
    ),
    check(
      "employees_employment_type_valid",
      sql`${table.employmentType} IN ('FULL_TIME', 'PART_TIME', 'SEASONAL', 'TEMPORARY')`,
    ),
    check(
      "employees_terminated_matches_termination_date",
      sql`(${table.employmentStatus} = 'TERMINATED') = (${table.terminationDate} IS NOT NULL)`,
    ),
    check(
      "employees_hire_not_after_termination",
      sql`${table.terminationDate} IS NULL OR ${table.hireDate} <= ${table.terminationDate}`,
    ),
  ],
);

/** A row that has ended keeps its history: `active` is false once `effective_to` is set. */
export const employeeLocations = pgTable(
  "employee_locations",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    primaryLocation: boolean("primary_location").notNull().default(false),
    effectiveFrom: calendarDate("effective_from").notNull(),
    effectiveTo: calendarDate("effective_to"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "employee_locations_effective_range",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveFrom} <= ${table.effectiveTo}`,
    ),
    check(
      "employee_locations_active_matches_end",
      sql`${table.active} = (${table.effectiveTo} IS NULL)`,
    ),
    check(
      "employee_locations_primary_is_active",
      sql`NOT ${table.primaryLocation} OR ${table.active}`,
    ),
    uniqueIndex("employee_locations_one_active_primary_unique")
      .on(table.employeeId)
      .where(sql`${table.primaryLocation} AND ${table.active}`),
    index("employee_locations_location_id_employee_id_idx").on(
      table.locationId,
      table.employeeId,
    ),
    index("employee_locations_employee_id_idx").on(table.employeeId),
  ],
);

/** The work an employee may perform at a location. Never implies a security role. */
export const employeePositions = pgTable(
  "employee_positions",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    primaryPosition: boolean("primary_position").notNull().default(false),
    effectiveFrom: calendarDate("effective_from").notNull(),
    effectiveTo: calendarDate("effective_to"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "employee_positions_effective_range",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveFrom} <= ${table.effectiveTo}`,
    ),
    check(
      "employee_positions_active_matches_end",
      sql`${table.active} = (${table.effectiveTo} IS NULL)`,
    ),
    check(
      "employee_positions_primary_is_active",
      sql`NOT ${table.primaryPosition} OR ${table.active}`,
    ),
    uniqueIndex("employee_positions_one_active_primary_unique")
      .on(table.employeeId, table.locationId)
      .where(sql`${table.primaryPosition} AND ${table.active}`),
    index("employee_positions_employee_id_position_id_idx").on(
      table.employeeId,
      table.positionId,
    ),
    index("employee_positions_position_id_idx").on(table.positionId),
    index("employee_positions_location_id_idx").on(table.locationId),
  ],
);

/** Restricted personal data. */
export const employeeAddresses = pgTable(
  "employee_addresses",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    addressType: text("address_type").notNull(),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    city: text("city").notNull(),
    state: text("state").notNull(),
    postalCode: text("postal_code").notNull(),
    country: text("country").notNull(),
    effectiveFrom: calendarDate("effective_from").notNull(),
    effectiveTo: calendarDate("effective_to"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "employee_addresses_address_type_valid",
      sql`${table.addressType} IN ('HOME', 'MAILING', 'OTHER')`,
    ),
    check(
      "employee_addresses_effective_range",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveFrom} <= ${table.effectiveTo}`,
    ),
    uniqueIndex("employee_addresses_one_open_per_type_unique")
      .on(table.employeeId, table.addressType)
      .where(sql`${table.effectiveTo} IS NULL`),
    index("employee_addresses_employee_id_idx").on(table.employeeId),
  ],
);

/** Restricted personal data. */
export const employeeEmergencyContacts = pgTable(
  "employee_emergency_contacts",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    relationship: text("relationship").notNull(),
    phone: text("phone").notNull(),
    alternatePhone: text("alternate_phone"),
    email: text("email"),
    primaryContact: boolean("primary_contact").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("employee_emergency_contacts_one_primary_unique")
      .on(table.employeeId)
      .where(sql`${table.primaryContact}`),
    index("employee_emergency_contacts_employee_id_idx").on(table.employeeId),
  ],
);

/**
 * Pay belongs to the Employee + Position pair and is not location-specific. Rows are
 * never edited to change a wage: the only update allowed closes a period.
 */
export const employeePositionCompensation = pgTable(
  "employee_position_compensation",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    positionId: uuid("position_id").notNull(),
    compensationType: text("compensation_type").notNull(),
    hourlyRate: money("hourly_rate"),
    annualSalary: money("annual_salary"),
    effectiveFrom: calendarDate("effective_from").notNull(),
    effectiveTo: calendarDate("effective_to"),
    changeReason: text("change_reason"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "employee_position_compensation_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "employee_position_compensation_employee_fk",
      columns: [table.employeeId, table.organizationId],
      foreignColumns: [employees.id, employees.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "employee_position_compensation_position_fk",
      columns: [table.positionId, table.organizationId],
      foreignColumns: [positions.id, positions.organizationId],
    }).onDelete("restrict"),
    check(
      "employee_position_compensation_amount_matches_type",
      sql`(${table.compensationType} = 'HOURLY' AND ${table.hourlyRate} IS NOT NULL AND ${table.hourlyRate} >= 0 AND ${table.annualSalary} IS NULL)
        OR (${table.compensationType} = 'SALARY' AND ${table.annualSalary} IS NOT NULL AND ${table.annualSalary} >= 0 AND ${table.hourlyRate} IS NULL)`,
    ),
    check(
      "employee_position_compensation_effective_range",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveFrom} <= ${table.effectiveTo}`,
    ),
    index("employee_position_compensation_employee_position_idx").on(
      table.employeeId,
      table.positionId,
      table.effectiveFrom,
    ),
    index("employee_position_compensation_position_id_idx").on(table.positionId),
  ],
);

export const certificationTypes = pgTable(
  "certification_types",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    expirationRequired: boolean("expiration_required").notNull().default(false),
    warningDays: integer("warning_days"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("certification_types_organization_id_code_unique").on(
      table.organizationId,
      table.code,
    ),
    check(
      "certification_types_warning_days_not_negative",
      sql`${table.warningDays} IS NULL OR ${table.warningDays} >= 0`,
    ),
  ],
);

/** Metadata only. The file is behind FileStorageService. Rows are never updated. */
export const employeeDocuments = pgTable(
  "employee_documents",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    documentType: text("document_type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    storageKey: text("storage_key").notNull().unique(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    sensitive: boolean("sensitive").notNull().default(true),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    uploadedAt: timestamptz("uploaded_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "employee_documents_document_type_valid",
      sql`${table.documentType} IN ('CONTRACT', 'CERTIFICATION', 'POLICY_ACKNOWLEDGEMENT', 'OTHER')`,
    ),
    check("employee_documents_file_size_positive", sql`${table.fileSize} > 0`),
    index("employee_documents_employee_id_idx").on(table.employeeId),
  ],
);

export const employeeCertifications = pgTable(
  "employee_certifications",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    certificationTypeId: uuid("certification_type_id").notNull(),
    certificationNumber: text("certification_number"),
    issuedDate: calendarDate("issued_date"),
    expirationDate: calendarDate("expiration_date"),
    documentId: uuid("document_id").references(() => employeeDocuments.id, {
      onDelete: "restrict",
    }),
    verified: boolean("verified").notNull().default(false),
    verifiedByUserId: uuid("verified_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    verifiedAt: timestamptz("verified_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "employee_certifications_certification_type_fk",
      columns: [table.certificationTypeId],
      foreignColumns: [certificationTypes.id],
    }).onDelete("restrict"),
    check(
      "employee_certifications_verification_complete",
      sql`(${table.verified} AND ${table.verifiedByUserId} IS NOT NULL AND ${table.verifiedAt} IS NOT NULL)
        OR (NOT ${table.verified} AND ${table.verifiedByUserId} IS NULL AND ${table.verifiedAt} IS NULL)`,
    ),
    check(
      "employee_certifications_issued_not_after_expiration",
      sql`${table.issuedDate} IS NULL OR ${table.expirationDate} IS NULL OR ${table.issuedDate} <= ${table.expirationDate}`,
    ),
    index("employee_certifications_employee_id_idx").on(table.employeeId),
    index("employee_certifications_certification_type_id_idx").on(
      table.certificationTypeId,
    ),
    index("employee_certifications_expiration_date_idx").on(table.expirationDate),
  ],
);

export const employeeNotes = pgTable(
  "employee_notes",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    noteType: text("note_type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    sensitive: boolean("sensitive").notNull().default(false),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    check(
      "employee_notes_note_type_valid",
      sql`${table.noteType} IN ('GENERAL', 'PERFORMANCE', 'RECOGNITION', 'TRAINING', 'MANAGER')`,
    ),
    index("employee_notes_employee_id_idx").on(table.employeeId),
  ],
);

/** Restricted HR data. Details never appear in logs or general queries. */
export const employeeDisciplinaryActions = pgTable(
  "employee_disciplinary_actions",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    actionType: text("action_type").notNull(),
    incidentDate: calendarDate("incident_date"),
    actionDate: calendarDate("action_date").notNull(),
    description: text("description").notNull(),
    actionTaken: text("action_taken").notNull(),
    followUpDate: calendarDate("follow_up_date"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    check(
      "employee_disciplinary_actions_action_type_valid",
      sql`${table.actionType} IN ('VERBAL_WARNING', 'WRITTEN_WARNING', 'FINAL_WARNING', 'SUSPENSION', 'OTHER')`,
    ),
    check(
      "employee_disciplinary_actions_incident_not_after_action",
      sql`${table.incidentDate} IS NULL OR ${table.incidentDate} <= ${table.actionDate}`,
    ),
    index("employee_disciplinary_actions_employee_id_idx").on(table.employeeId),
  ],
);

export const employeePerformanceReviews = pgTable(
  "employee_performance_reviews",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    reviewerEmployeeId: uuid("reviewer_employee_id"),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    reviewPeriodStart: calendarDate("review_period_start").notNull(),
    reviewPeriodEnd: calendarDate("review_period_end").notNull(),
    reviewDate: calendarDate("review_date").notNull(),
    status: text("status").notNull().default("DRAFT"),
    overallRating: integer("overall_rating"),
    summary: text("summary"),
    employeeComments: text("employee_comments"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "employee_performance_reviews_reviewer_employee_fk",
      columns: [table.reviewerEmployeeId],
      foreignColumns: [employees.id],
    }).onDelete("restrict"),
    check(
      "employee_performance_reviews_status_valid",
      sql`${table.status} IN ('DRAFT', 'COMPLETED')`,
    ),
    check(
      "employee_performance_reviews_rating_range",
      sql`${table.overallRating} IS NULL OR ${table.overallRating} BETWEEN 1 AND 5`,
    ),
    check(
      "employee_performance_reviews_period_range",
      sql`${table.reviewPeriodStart} <= ${table.reviewPeriodEnd}`,
    ),
    index("employee_performance_reviews_employee_id_idx").on(table.employeeId),
    index("employee_performance_reviews_reviewer_employee_id_idx").on(
      table.reviewerEmployeeId,
    ),
  ],
);

/** Append-only. Corrections add a row; old rows are never changed. */
export const employeeStatusHistory = pgTable(
  "employee_status_history",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    effectiveAt: timestamptz("effective_at").notNull().defaultNow(),
    reason: text("reason"),
    changedByUserId: uuid("changed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "employee_status_history_status_valid",
      sql`${table.status} IN ('ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED')`,
    ),
    index("employee_status_history_employee_id_effective_at_idx").on(
      table.employeeId,
      table.effectiveAt,
    ),
  ],
);
