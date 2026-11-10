import { getEnv } from "@/config/env";
import { getDatabase } from "@/db";
import { readErrorCode } from "@/infrastructure/health/check-database-health";
import { writeLog } from "@/infrastructure/logging/logger";

import { runMaintenance } from "./run-maintenance";

type Runner = { timer: ReturnType<typeof setInterval> };

const store = globalThis as typeof globalThis & { restaurantOpsMaintenanceRunner?: Runner };

/**
 * Starts this process's maintenance timer once (dev hot reloads reuse it). The advisory lock
 * in `runMaintenance` keeps concurrent runners from overlapping. A failure is logged and never
 * thrown into the server; the next interval tries again.
 */
export function startMaintenanceRunner(): void {
  const interval = getEnv().MAINTENANCE_INTERVAL_MS;

  if (interval === 0 || store.restaurantOpsMaintenanceRunner) {
    return;
  }

  const tick = async () => {
    try {
      const result = await runMaintenance(getDatabase());

      if (!result.skipped && (result.outboxEventsDeleted > 0 || result.loginThrottlesDeleted > 0)) {
        writeLog({
          severity: "info",
          module: "maintenance",
          operation: "run",
          message: `Maintenance purged ${result.outboxEventsDeleted} published outbox events and ${result.loginThrottlesDeleted} expired sign-in throttles.`,
        });
      }
    } catch (error) {
      writeLog({
        severity: "error",
        module: "maintenance",
        operation: "run",
        message: "Maintenance failed; it will run again at the next interval.",
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorCode: readErrorCode(error),
      });
    }
  };

  const timer = setInterval(() => void tick(), interval);

  timer.unref?.();
  store.restaurantOpsMaintenanceRunner = { timer };
  writeLog({
    severity: "info",
    module: "maintenance",
    operation: "start",
    message: `Maintenance runner started (every ${interval} ms).`,
  });
}
