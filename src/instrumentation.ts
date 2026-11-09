import { isNodeServerRuntime } from "./config/runtime";

/**
 * Next.js server start hook. Starts the transactional-outbox processor in the Node.js
 * runtime only, so committed events reach realtime clients (README section 23).
 */
export async function register(): Promise<void> {
  if (!isNodeServerRuntime()) {
    return;
  }

  const { startOutboxProcessor } = await import("./infrastructure/outbox/outbox-runner");

  startOutboxProcessor();
}
