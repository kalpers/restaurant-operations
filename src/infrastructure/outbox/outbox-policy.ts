// Outbox failure handling (Phase 16 policies 10-11). Pure, so the backoff and the
// dead-letter boundary are unit-tested.

export const OUTBOX_RETRY_BASE_MS = 1000;
export const OUTBOX_RETRY_CAP_MS = 5 * 60 * 1000;

/** Delay before the next claim after `attempts` failures: 1 s, 2 s, 4 s … capped at 5 min. */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);

  // 2^9 s already exceeds the cap, so larger exponents never overflow.
  return exponent >= 9 ? OUTBOX_RETRY_CAP_MS : Math.min(OUTBOX_RETRY_BASE_MS * 2 ** exponent, OUTBOX_RETRY_CAP_MS);
}

/** Dead-lettered once the attempt count reaches the maximum. */
export function isDeadLetter(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}
