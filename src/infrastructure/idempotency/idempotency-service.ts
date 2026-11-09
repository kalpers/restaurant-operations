import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { idempotencyRecords } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { ConflictError } from "@/shared/errors/app-error";

// Client idempotency for critical retryable commands (README section 23). The key is
// claimed inside the command's own transaction, so it commits or rolls back with the work:
// a committed key replays its stored response, and a rolled-back attempt leaves nothing.
// A concurrent duplicate waits on the unique key until the first transaction finishes.

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Order-independent JSON, so the same request always has the same fingerprint. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }

  return JSON.stringify(value ?? null);
}

export function requestFingerprint(request: unknown): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

export type IdempotentOutcome<Response> = { replayed: boolean; response: Response };

export async function runIdempotent<Response>(
  transaction: DatabaseTransaction,
  claim: {
    organizationId: string;
    scope: string;
    key: string;
    actorUserId: string;
    request: unknown;
  },
  command: (idempotencyRecordId: string) => Promise<Response>,
): Promise<IdempotentOutcome<Response>> {
  // The actor is part of the request: another user can't replay someone else's key.
  const fingerprint = requestFingerprint({ actorUserId: claim.actorUserId, request: claim.request });
  const [claimed] = await transaction
    .insert(idempotencyRecords)
    .values({
      organizationId: claim.organizationId,
      scope: claim.scope,
      idempotencyKey: claim.key,
      actorUserId: claim.actorUserId,
      requestFingerprint: fingerprint,
    })
    .onConflictDoNothing({
      target: [idempotencyRecords.organizationId, idempotencyRecords.scope, idempotencyRecords.idempotencyKey],
    })
    .returning({ id: idempotencyRecords.id });

  if (claimed) {
    const response = await command(claimed.id);

    await transaction
      .update(idempotencyRecords)
      .set({ response: response as never })
      .where(eq(idempotencyRecords.id, claimed.id));

    return { replayed: false, response };
  }

  const [existing] = await transaction
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.organizationId, claim.organizationId),
        eq(idempotencyRecords.scope, claim.scope),
        eq(idempotencyRecords.idempotencyKey, claim.key),
      ),
    );

  if (!existing || existing.requestFingerprint !== fingerprint || existing.response === null) {
    throw new ConflictError(
      "IDEMPOTENCY_KEY_REUSED",
      "That request key was already used for a different request.",
    );
  }

  return { replayed: true, response: existing.response as Response };
}
