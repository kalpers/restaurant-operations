import { readErrorCode } from "../../infrastructure/health/check-database-health";

const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(error: unknown): boolean {
  return readErrorCode(error) === UNIQUE_VIOLATION;
}
