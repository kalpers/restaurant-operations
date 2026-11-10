import type { PublishedEvent } from "../outbox/outbox";

// The realtime adapter (README section 3): an in-process fan-out from the outbox processor
// to the Server-Sent Events connections held by this Node process. It holds no state that
// matters: an event is a "something changed, refetch" signal, and a client that missed one
// refetches when it reconnects. One process serves the POC (a single app instance); several
// instances would each need their own processor feed (for example LISTEN/NOTIFY).

export type RealtimeMessage = {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: string;
};

type Subscriber = {
  organizationId: string;
  locationId: string;
  userId: string;
  send: (message: RealtimeMessage) => void;
};

type Hub = { subscribers: Set<Subscriber> };

const store = globalThis as typeof globalThis & { restaurantOpsRealtimeHub?: Hub };

function hub(): Hub {
  store.restaurantOpsRealtimeHub ??= { subscribers: new Set() };

  return store.restaurantOpsRealtimeHub;
}

export function subscribe(subscriber: Subscriber): () => void {
  hub().subscribers.add(subscriber);

  return () => {
    hub().subscribers.delete(subscriber);
  };
}

export function subscriberCount(): number {
  return hub().subscribers.size;
}

/**
 * Delivers a committed event to every connection that may see it: same organization and
 * location, and, for a recipient-only event, that user alone. The connection's own
 * authorization was checked when it opened.
 */
export function publishToSubscribers(event: PublishedEvent): void {
  const message: RealtimeMessage = {
    id: event.id,
    type: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
    occurredAt: event.occurredAt,
  };

  for (const subscriber of hub().subscribers) {
    if (
      subscriber.organizationId !== event.organizationId ||
      (event.locationId !== null && subscriber.locationId !== event.locationId) ||
      (event.recipientUserId !== null && subscriber.userId !== event.recipientUserId)
    ) {
      continue;
    }

    try {
      subscriber.send(message);
    } catch {
      // A closed stream unsubscribes itself; one bad connection never blocks the rest.
    }
  }
}
