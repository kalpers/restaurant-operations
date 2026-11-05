/** Stable values. PostgreSQL CHECK constraints in the schema enforce the same lists. */
export const EMPLOYMENT_STATUSES = [
  "ACTIVE",
  "ON_LEAVE",
  "SUSPENDED",
  "TERMINATED",
] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const EMPLOYMENT_TYPES = [
  "FULL_TIME",
  "PART_TIME",
  "SEASONAL",
  "TEMPORARY",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const ADDRESS_TYPES = ["HOME", "MAILING", "OTHER"] as const;

export const COMPENSATION_TYPES = ["HOURLY", "SALARY"] as const;
export type CompensationType = (typeof COMPENSATION_TYPES)[number];

export const NOTE_TYPES = [
  "GENERAL",
  "PERFORMANCE",
  "RECOGNITION",
  "TRAINING",
  "MANAGER",
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const DOCUMENT_TYPES = [
  "CONTRACT",
  "CERTIFICATION",
  "POLICY_ACKNOWLEDGEMENT",
  "OTHER",
] as const;

export const DISCIPLINARY_ACTION_TYPES = [
  "VERBAL_WARNING",
  "WRITTEN_WARNING",
  "FINAL_WARNING",
  "SUSPENSION",
  "OTHER",
] as const;

export const REVIEW_STATUSES = ["DRAFT", "COMPLETED"] as const;
