import { getEnv } from "@/config/env";
import { getDatabase } from "@/db";
import { writeLog } from "@/infrastructure/logging/logger";
import { publishToSubscribers } from "@/infrastructure/realtime/realtime-hub";

import { processOutboxBatch } from "./outbox";

type Runner = { timer: ReturnType<typeof setTimeout> | null; running: boolean; failing: boolean };

const store = globalThis as typeof globalThis & { restaurantOpsOutboxRunner?: Runner };

/**
 * Starts this process's outbox processor once (dev hot reloads reuse it). It publishes a
 * batch, then waits the configured interval; a full batch is followed at once by the next.
 * Errors are logged once per failure streak and retried, never thrown into the server.
 */
export function startOutboxProcessor(): void {
  const interval = getEnv().OUTBOX_POLL_INTERVAL_MS;

  if (interval === 0 || store.restaurantOpsOutboxRunner) {
    return;
  }

  const runner: Runner = { timer: null, running: true, failing: false };

  store.restaurantOpsOutboxRunner = runner;

  const tick = async () => {
    let published = 0;

    try {
      published = await processOutboxBatch(getDatabase(), publishToSubscribers);

      if (runner.failing) {
        runner.failing = false;
        writeLog({ severity: "info", module: "outbox", operation: "process-batch", message: "Outbox processing recovered." });
      }
    } catch (error) {
      // Logged once per run of failures (for example while the database restarts).
      if (!runner.failing) {
        runner.failing = true;
        writeLog({
          severity: "error",
          module: "outbox",
          operation: "process-batch",
          message: "Outbox batch failed; it will be retried.",
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }

    if (runner.running) {
      runner.timer = setTimeout(tick, published >= 100 ? 0 : interval);
      runner.timer.unref?.();
    }
  };

  runner.timer = setTimeout(tick, interval);
  runner.timer.unref?.();
  writeLog({
    severity: "info",
    module: "outbox",
    operation: "start",
    message: `Outbox processor started (every ${interval} ms).`,
  });
}
