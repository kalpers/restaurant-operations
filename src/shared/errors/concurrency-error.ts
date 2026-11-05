/** An update's expected version no longer matches the stored record. */
export class ConcurrencyError extends Error {
  readonly code = "CONCURRENCY_CONFLICT";

  constructor(
    readonly entityType: string,
    readonly entityId: string,
  ) {
    super(`The ${entityType} was changed by someone else. Reload and try again.`);
    this.name = "ConcurrencyError";
  }
}
