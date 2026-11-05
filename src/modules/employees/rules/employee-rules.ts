import { BusinessRuleError, ValidationError } from "@/shared/errors/app-error";

import type {
  CompensationType,
  EmploymentStatus,
  NoteType,
} from "../types";

// ISO dates compare correctly as strings, so no date arithmetic happens except
// previousDay, which works in UTC so a daylight-saving change can't shift it.

/** `from` and `to` are inclusive. */
export function assertEffectiveRange(from: string, to: string | null): void {
  if (to !== null && from > to) {
    throw new ValidationError("The start date must not be after the end date.");
  }
}

export function previousDay(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);

  instant.setUTCDate(instant.getUTCDate() - 1);

  return instant.toISOString().slice(0, 10);
}

/** The calendar date at a location. This is not a restaurant business date. */
export function calendarDateIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * An ended row stops being active at once, so an end date can't be in the future. A
 * row that hasn't started yet may be closed on its own start date.
 */
export function assertEndDateAllowed(input: {
  from: string;
  to: string;
  today: string;
}): void {
  assertEffectiveRange(input.from, input.to);

  if (input.to > input.today && input.to !== input.from) {
    throw new BusinessRuleError(
      "END_DATE_IN_FUTURE",
      "The end date can't be in the future.",
    );
  }
}

export function assertTerminationDateAllowed(input: {
  hireDate: string;
  terminationDate: string;
  today: string;
}): void {
  if (input.terminationDate < input.hireDate) {
    throw new BusinessRuleError(
      "TERMINATION_BEFORE_HIRE",
      "The termination date can't be before the hire date.",
    );
  }

  if (input.terminationDate > input.today) {
    throw new BusinessRuleError(
      "TERMINATION_IN_FUTURE",
      "The termination date can't be in the future.",
    );
  }
}

/** Termination has its own workflow, and TERMINATED is final. */
export function assertStatusChangeAllowed(
  current: string,
  next: EmploymentStatus,
): void {
  if (current === "TERMINATED") {
    throw new BusinessRuleError(
      "EMPLOYEE_TERMINATED",
      "A terminated employee can't be changed.",
    );
  }

  if (next === "TERMINATED") {
    throw new BusinessRuleError(
      "USE_TERMINATION_WORKFLOW",
      "Use the termination action to terminate an employee.",
    );
  }

  if (current === next) {
    throw new BusinessRuleError(
      "STATUS_UNCHANGED",
      "The employee already has this status.",
    );
  }
}

const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

/**
 * NUMERIC(12,2) as a decimal string. PostgreSQL silently rounds extra decimal places,
 * so anything beyond two is rejected here. The value is never converted to a number.
 */
export function isValidMoney(value: string): boolean {
  return MONEY_PATTERN.test(value);
}

export function assertCompensationAmounts(input: {
  compensationType: CompensationType;
  hourlyRate: string | null;
  annualSalary: string | null;
}): void {
  const { compensationType, hourlyRate, annualSalary } = input;
  const required = compensationType === "HOURLY" ? hourlyRate : annualSalary;
  const other = compensationType === "HOURLY" ? annualSalary : hourlyRate;

  if (required === null || other !== null) {
    throw new ValidationError(
      compensationType === "HOURLY"
        ? "Hourly pay needs an hourly rate and no annual salary."
        : "Salaried pay needs an annual salary and no hourly rate.",
    );
  }

  if (!isValidMoney(required)) {
    throw new ValidationError(
      "Enter a non-negative amount with at most two decimal places.",
    );
  }
}

const SENSITIVE_NOTE_TYPES: ReadonlySet<NoteType> = new Set([
  "MANAGER",
  "PERFORMANCE",
]);

/** Manager and performance notes need the sensitive permissions, whatever the flag says. */
export function noteRequiresSensitiveAccess(note: {
  noteType: string;
  sensitive: boolean;
}): boolean {
  return note.sensitive || SENSITIVE_NOTE_TYPES.has(note.noteType as NoteType);
}

export function assertCertificationDates(input: {
  expirationRequired: boolean;
  issuedDate: string | null;
  expirationDate: string | null;
}): void {
  if (input.expirationRequired && input.expirationDate === null) {
    throw new BusinessRuleError(
      "CERTIFICATION_EXPIRATION_REQUIRED",
      "This certification type needs an expiration date.",
    );
  }

  if (input.issuedDate !== null) {
    assertEffectiveRange(input.issuedDate, input.expirationDate);
  }
}
