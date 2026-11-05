import { readErrorCode } from "../../infrastructure/health/check-database-health";

const UNIQUE_VIOLATION = "23505";
const EXCLUSION_VIOLATION = "23P01";

export function isUniqueViolation(error: unknown): boolean {
  return readErrorCode(error) === UNIQUE_VIOLATION;
}

export function isExclusionViolation(error: unknown): boolean {
  return readErrorCode(error) === EXCLUSION_VIOLATION;
}
