// Phase 22 message dispatch policy (policy 3). Pure, so the backoff, dead-letter boundary and
// crash recovery are unit-tested.

export const MESSAGE_RETRY_BASE_MS = 5_000;
export const MESSAGE_RETRY_CAP_MS = 15 * 60 * 1000;
/** A message SENDING for longer than this was left by a crashed process (D3). */
export const STALE_SENDING_MS = 5 * 60 * 1000;
export const DISPATCH_BATCH_SIZE = 20;

/** Delay before the next try after `attempts` failures: 5 s, 10 s, 20 s ... capped at 15 min. */
export function messageRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);

  return exponent >= 8 ? MESSAGE_RETRY_CAP_MS : Math.min(MESSAGE_RETRY_BASE_MS * 2 ** exponent, MESSAGE_RETRY_CAP_MS);
}

/** Failed for good once the attempt count reaches the maximum. */
export function isMessageDeadLetter(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

export function staleSendingCutoff(now: Date): Date {
  return new Date(now.getTime() - STALE_SENDING_MS);
}
