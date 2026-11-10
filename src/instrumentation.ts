import { isNodeServerRuntime } from "./config/runtime";

/**
 * Next.js server start hook. In the Node.js runtime only, starts the transactional-outbox
 * processor, so committed events reach realtime clients (README section 23), and the
 * maintenance runner, which purges expired rows (Phase 16).
 */
export async function register(): Promise<void> {
  if (!isNodeServerRuntime()) {
    return;
  }

  const { startOutboxProcessor } = await import("./infrastructure/outbox/outbox-runner");
  const { startMaintenanceRunner } = await import("./infrastructure/maintenance/maintenance-runner");

  startOutboxProcessor();
  startMaintenanceRunner();
}
