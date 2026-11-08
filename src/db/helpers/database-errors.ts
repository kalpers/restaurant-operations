import { readErrorCode } from "../../infrastructure/health/check-database-health";

const UNIQUE_VIOLATION = "23505";
const EXCLUSION_VIOLATION = "23P01";

export function isUniqueViolation(error: unknown): boolean {
  return readErrorCode(error) === UNIQUE_VIOLATION;
}

export function isExclusionViolation(error: unknown): boolean {
  return readErrorCode(error) === EXCLUSION_VIOLATION;
}

/** The violated constraint's name, from the driver error or the `cause` chain beneath it. */
export function readConstraintName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  if ("constraint_name" in error && typeof error.constraint_name === "string") {
    return error.constraint_name;
  }

  return "cause" in error ? readConstraintName(error.cause) : undefined;
}
