import { getMessagingConfig } from "@/config/messaging-env";
import { getDatabase } from "@/db";
import { readErrorCode } from "@/infrastructure/health/check-database-health";
import { writeLog } from "@/infrastructure/logging/logger";
import { dispatchGuestMessages } from "@/modules/reservations/services/guest-message-dispatch";

import { getMessageSenders } from "./index";

type Runner = { timer: ReturnType<typeof setTimeout> | null; running: boolean; failing: boolean };

const store = globalThis as typeof globalThis & { restaurantOpsMessageDispatcher?: Runner };

/**
 * Starts this process's guest message dispatcher once (Phase 22 policy 3; dev hot reloads
 * reuse it). Like the outbox processor: a pass, then the configured wait, with a full batch
 * followed at once by the next. Failures are logged once per streak and never thrown.
 */
export function startMessageDispatcher(): void {
  const config = getMessagingConfig();

  if (config.dispatchIntervalMs === 0 || store.restaurantOpsMessageDispatcher) {
    return;
  }

  const runner: Runner = { timer: null, running: true, failing: false };

  store.restaurantOpsMessageDispatcher = runner;

  const tick = async () => {
    let handled = 0;

    try {
      const result = await dispatchGuestMessages(getDatabase(), getMessageSenders(), {
        maxAttempts: config.maxAttempts,
        suppressionKey: config.suppressionKey,
      });

      handled = result.sent + result.retried + result.failed + result.suppressed + result.cancelled;

      if (runner.failing) {
        runner.failing = false;
        writeLog({ severity: "info", module: "messaging", operation: "dispatch", message: "Message dispatch recovered." });
      }
    } catch (error) {
      if (!runner.failing) {
        runner.failing = true;
        writeLog({
          severity: "error",
          module: "messaging",
          operation: "dispatch",
          message: "Message dispatch failed; it will be retried.",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorCode: readErrorCode(error),
        });
      }
    }

    if (runner.running) {
      runner.timer = setTimeout(tick, handled >= 20 ? 0 : config.dispatchIntervalMs);
      runner.timer.unref?.();
    }
  };

  runner.timer = setTimeout(tick, config.dispatchIntervalMs);
  runner.timer.unref?.();
  writeLog({
    severity: "info",
    module: "messaging",
    operation: "start",
    message: `Message dispatcher started (every ${config.dispatchIntervalMs} ms; email ${config.email.provider}, SMS ${config.sms.provider}).`,
  });
}
