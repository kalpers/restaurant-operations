import { requireApiActor } from "@/modules/auth/guards";
import { subscribe, type RealtimeMessage } from "@/infrastructure/realtime/realtime-hub";
import { apiRoute } from "@/shared/http/api-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 25_000;
/**
 * A stream lives at most this long. The browser's EventSource then reconnects, which
 * re-resolves the user, location and permissions from the database like any other request.
 */
const MAX_LIFETIME_MS = 5 * 60_000;

/**
 * Server-Sent Events: committed outbox events for the actor's location (and their own
 * notifications). Messages carry identifiers only and mean "refetch"; the data itself always
 * comes from the authorized query endpoints.
 */
export const GET = apiRoute({ module: "realtime", operation: "stream" }, async ({ request }) => {
  const actor = await requireApiActor();
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (text: string) => {
        if (!closed) {
          controller.enqueue(encoder.encode(text));
        }
      };
      const unsubscribe = subscribe({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        userId: actor.userId,
        send: (message: RealtimeMessage) => {
          write(`id: ${message.id}\nevent: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`);
        },
      });
      const heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);
      const lifetime = setTimeout(() => cleanup(), MAX_LIFETIME_MS);

      cleanup = () => {
        if (closed) {
          return;
        }

        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();

        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      request.signal.addEventListener("abort", () => cleanup());
      write("retry: 3000\nevent: ready\ndata: {}\n\n");
    },
    cancel() {
      cleanup();
    },
  });

  return {
    response: new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }),
  };
});
