import { AppError } from "./app-error";

/** An update's expected version no longer matches the stored record. */
export class ConcurrencyError extends AppError {
  constructor(
    readonly entityType: string,
    readonly entityId: string,
  ) {
    super(
      "CONCURRENCY_CONFLICT",
      `The ${entityType} was changed by someone else. Reload and try again.`,
      409,
    );
  }
}
