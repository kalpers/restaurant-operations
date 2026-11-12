import type postgres from "postgres";

import { getEnv } from "@/config/env";
import type { Database } from "@/db";
import { notifyTimeBasedSignals } from "@/workflows/notify-time-based-signals/notify-time-based-signals";

// Retention (Phase 16 policies 15-17). Purges only:
// - published outbox events older than OUTBOX_RETENTION_DAYS (never unpublished or
//   dead-lettered ones; the outbox guard trigger refuses those too);
// - sign-in throttle rows whose window and lock have both expired.
// Idempotency records, audit events, ledgers, snapshots and every other history are never
// touched. Deletes run in bounded batches, outside any long transaction.
// Phase 20 (policy 14): the same run, under the same lock, writes the time-based
// notifications (expiring certifications, approaching overtime, missed clock-outs). Each has
// a dedupe key, so an hourly run sends each one once.

export const MAINTENANCE_BATCH_SIZE = 1000;

/** The advisory lock that keeps maintenance to one runner at a time, across processes. */
export const MAINTENANCE_LOCK_KEY = 7_316_016;

export type MaintenanceOptions = {
  retentionDays?: number;
  throttleWindowMs?: number;
  batchSize?: number;
  /** Phase 20: false skips the time-based notification pass (retention-only runs and tests). */
  notify?: boolean;
};

export type MaintenanceResult =
  | { skipped: true }
  | { skipped: false; outboxEventsDeleted: number; loginThrottlesDeleted: number; notificationsCreated: number };

export async function runMaintenance(
  database: Database,
  now: Date = new Date(),
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const env = getEnv();
  const retentionDays = options.retentionDays ?? env.OUTBOX_RETENTION_DAYS;
  const throttleWindowMs = options.throttleWindowMs ?? env.AUTH_LOCKOUT_WINDOW_MINUTES * 60_000;
  const batchSize = options.batchSize ?? MAINTENANCE_BATCH_SIZE;
  const outboxCutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const windowCutoff = new Date(now.getTime() - throttleWindowMs).toISOString();
  const nowText = now.toISOString();

  // A session-level advisory lock needs one connection for the whole run. Every Database is
  // made by drizzle() over a postgres-js pool, which it exposes as `$client`.
  const { $client: pool } = database as Database & { $client: postgres.Sql };
  const connection = await pool.reserve();

  try {
    const [lock] = await connection<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${MAINTENANCE_LOCK_KEY}) AS locked`;

    if (!lock?.locked) {
      return { skipped: true };
    }

    try {
      const deleteInBatches = async (run: () => Promise<{ count: number }>) => {
        let total = 0;

        for (;;) {
          const { count } = await run();

          total += count;

          if (count < batchSize) {
            return total;
          }
        }
      };

      const outboxEventsDeleted = await deleteInBatches(
        () => connection`
          DELETE FROM outbox_events
          WHERE id IN (
            SELECT id FROM outbox_events
            WHERE published_at IS NOT NULL
              AND failed_at IS NULL
              AND published_at < ${outboxCutoff}::timestamptz
            ORDER BY published_at
            LIMIT ${batchSize}
          )`,
      );
      const loginThrottlesDeleted = await deleteInBatches(
        () => connection`
          DELETE FROM login_throttles
          WHERE key_hash IN (
            SELECT key_hash FROM login_throttles
            WHERE window_started_at <= ${windowCutoff}::timestamptz
              AND (locked_until IS NULL OR locked_until <= ${nowText}::timestamptz)
            LIMIT ${batchSize}
          )`,
      );

      const { notificationsCreated } =
        options.notify === false ? { notificationsCreated: 0 } : await notifyTimeBasedSignals(database, now);

      return { skipped: false, outboxEventsDeleted, loginThrottlesDeleted, notificationsCreated };
    } finally {
      await connection`SELECT pg_advisory_unlock(${MAINTENANCE_LOCK_KEY})`;
    }
  } finally {
    connection.release();
  }
}
