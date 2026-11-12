/**
 * Next.js server start hook. In the Node.js runtime only, starts the transactional-outbox
 * processor, so committed events reach realtime clients (README section 23), the maintenance
 * runner, which purges expired rows (Phase 16), and the guest message dispatcher (Phase 22).
 *
 * The runtime test is written inline, not through a helper: Next.js replaces
 * `process.env.NEXT_RUNTIME` at build time, so the Edge bundle drops the imports below and
 * their Node-only modules (`node:crypto`, `node:fs`) entirely (Phase 22 policy 26).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startOutboxProcessor } = await import("./infrastructure/outbox/outbox-runner");
    const { startMaintenanceRunner } = await import("./infrastructure/maintenance/maintenance-runner");
    const { startMessageDispatcher } = await import("./infrastructure/messaging/message-dispatcher");

    startOutboxProcessor();
    startMaintenanceRunner();
    startMessageDispatcher();
  }
}
