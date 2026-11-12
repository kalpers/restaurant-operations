import { and, asc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";

import type { Database } from "@/db";
import { guestMessages, messageSuppressions } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { writeLog } from "@/infrastructure/logging/logger";
import type { MessageChannel, MessageSender, SendResult } from "@/infrastructure/messaging/message-sender";

import { normalizeMessageAddress, suppressionHash } from "../rules/message-address";
import {
  DISPATCH_BATCH_SIZE,
  isMessageDeadLetter,
  messageRetryDelayMs,
  staleSendingCutoff,
} from "../rules/message-dispatch-policy";

// Phase 22 message dispatch (policy 3). Each pass recovers sends a crashed process left behind,
// claims due QUEUED messages in a short transaction, then sends each one with NO transaction
// open (rule 5) and records the outcome in a statement of its own. Every record is conditional
// on the row still being SENDING under this claim, so an erase or cancel that won the race
// is never overwritten.

export type DispatchSenders = Record<MessageChannel, MessageSender | null>;

export type DispatchOptions = {
  now?: Date;
  maxAttempts: number;
  suppressionKey: string;
  limit?: number;
};

export type DispatchResult = {
  sent: number;
  retried: number;
  failed: number;
  suppressed: number;
  cancelled: number;
  recovered: number;
};

type ClaimedMessage = {
  id: string;
  organizationId: string;
  channel: MessageChannel;
  recipientAddress: string;
  subject: string | null;
  body: string;
  attempts: number;
  claimedAt: Date;
};

/** True when the organization's opt-out list holds this channel and address. */
export async function isSuppressed(
  executor: DatabaseExecutor,
  input: { organizationId: string; channel: MessageChannel; address: string; key: string },
): Promise<boolean> {
  const normalized = normalizeMessageAddress(input.channel, input.address);

  if (!normalized) {
    return false;
  }

  const [row] = await executor
    .select({ id: messageSuppressions.id })
    .from(messageSuppressions)
    .where(
      and(
        eq(messageSuppressions.organizationId, input.organizationId),
        eq(messageSuppressions.channel, input.channel),
        eq(messageSuppressions.addressHash, suppressionHash(input.key, input.channel, normalized)),
      ),
    )
    .limit(1);

  return Boolean(row);
}

/** Adds an address to the opt-out list. Idempotent. */
export async function addSuppression(
  executor: DatabaseExecutor,
  input: {
    organizationId: string;
    channel: MessageChannel;
    address: string;
    key: string;
    reason: "UNSUBSCRIBED" | "PROVIDER_OPT_OUT" | "STAFF";
  },
): Promise<void> {
  const normalized = normalizeMessageAddress(input.channel, input.address);

  if (!normalized) {
    return;
  }

  await executor
    .insert(messageSuppressions)
    .values({
      organizationId: input.organizationId,
      channel: input.channel,
      addressHash: suppressionHash(input.key, input.channel, normalized),
      reason: input.reason,
    })
    .onConflictDoNothing();
}

/** SENDING rows older than the stale cutoff go back to QUEUED (crash recovery, D3). */
async function recoverStaleSends(database: Database, now: Date): Promise<number> {
  const rows = await database
    .update(guestMessages)
    .set({ status: "QUEUED", claimedAt: null, nextAttemptAt: now })
    .where(and(eq(guestMessages.status, "SENDING"), lt(guestMessages.claimedAt, staleSendingCutoff(now))))
    .returning({ id: guestMessages.id });

  return rows.length;
}

async function claimDueMessages(database: Database, now: Date, limit: number): Promise<ClaimedMessage[]> {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select({
        id: guestMessages.id,
        organizationId: guestMessages.organizationId,
        channel: guestMessages.channel,
        recipientAddress: guestMessages.recipientAddress,
        subject: guestMessages.subject,
        body: guestMessages.body,
        attempts: guestMessages.attempts,
      })
      .from(guestMessages)
      .where(
        and(
          eq(guestMessages.status, "QUEUED"),
          lte(guestMessages.sendAfter, now),
          or(isNull(guestMessages.nextAttemptAt), lte(guestMessages.nextAttemptAt, now)),
        ),
      )
      .orderBy(asc(guestMessages.sendAfter), asc(guestMessages.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    if (rows.length === 0) {
      return [];
    }

    await transaction
      .update(guestMessages)
      .set({ status: "SENDING", claimedAt: now })
      .where(inArray(guestMessages.id, rows.map((row) => row.id)));

    return rows.map((row) => ({
      ...row,
      channel: row.channel as MessageChannel,
      // QUEUED rows always have content (guest_messages_content CHECK).
      recipientAddress: row.recipientAddress!,
      body: row.body!,
      claimedAt: now,
    }));
  });
}

/** Only the row still SENDING under this claim is updated. */
function stillClaimed(message: ClaimedMessage) {
  return and(
    eq(guestMessages.id, message.id),
    eq(guestMessages.status, "SENDING"),
    eq(guestMessages.claimedAt, message.claimedAt),
  );
}

type Outcome = keyof Omit<DispatchResult, "recovered">;

async function recordResult(
  database: Database,
  message: ClaimedMessage,
  result: SendResult,
  options: { now: Date; maxAttempts: number; suppressionKey: string },
): Promise<Outcome> {
  const attempts = message.attempts + 1;
  const { now } = options;

  if (result.ok) {
    await database
      .update(guestMessages)
      .set({
        status: "SENT",
        attempts,
        sentAt: now,
        claimedAt: null,
        nextAttemptAt: null,
        lastErrorCode: null,
        providerMessageId: result.providerMessageId.slice(0, 200),
      })
      .where(stillClaimed(message));

    return "sent";
  }

  if (result.kind === "OPTED_OUT") {
    await database.transaction(async (transaction) => {
      await addSuppression(transaction, {
        organizationId: message.organizationId,
        channel: message.channel,
        address: message.recipientAddress,
        key: options.suppressionKey,
        reason: "PROVIDER_OPT_OUT",
      });
      await transaction
        .update(guestMessages)
        .set({ status: "SUPPRESSED", attempts, suppressedAt: now, claimedAt: null, lastErrorCode: result.code })
        .where(stillClaimed(message));
    });

    return "suppressed";
  }

  const failed = result.kind === "PERMANENT" || isMessageDeadLetter(attempts, options.maxAttempts);

  await database
    .update(guestMessages)
    .set(
      failed
        ? { status: "FAILED", attempts, failedAt: now, claimedAt: null, nextAttemptAt: null, lastErrorCode: result.code }
        : {
            status: "QUEUED",
            attempts,
            claimedAt: null,
            nextAttemptAt: new Date(now.getTime() + messageRetryDelayMs(attempts)),
            lastErrorCode: result.code,
          },
    )
    .where(stillClaimed(message));

  if (failed) {
    // Identifiers only: never the address or body.
    writeLog({
      severity: "error",
      module: "messaging",
      operation: "send",
      message: `Guest message failed after ${attempts} attempt(s).`,
      entityId: message.id,
      errorCode: result.code,
    });
  }

  return failed ? "failed" : "retried";
}

/**
 * One dispatch pass. Returns what happened, for the runner's log and for tests. A provider
 * call never runs while this function holds a transaction.
 */
export async function dispatchGuestMessages(
  database: Database,
  senders: DispatchSenders,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const now = options.now ?? new Date();
  const result: DispatchResult = { sent: 0, retried: 0, failed: 0, suppressed: 0, cancelled: 0, recovered: 0 };

  result.recovered = await recoverStaleSends(database, now);

  const claimed = await claimDueMessages(database, now, options.limit ?? DISPATCH_BATCH_SIZE);

  for (const message of claimed) {
    const sender = senders[message.channel];

    if (!sender) {
      // The channel was turned off after the message was queued.
      await database
        .update(guestMessages)
        .set({ status: "CANCELLED", cancelledAt: now, claimedAt: null, lastErrorCode: "channel-off" })
        .where(stillClaimed(message));
      result.cancelled += 1;
      continue;
    }

    const suppressed = await isSuppressed(database, {
      organizationId: message.organizationId,
      channel: message.channel,
      address: message.recipientAddress,
      key: options.suppressionKey,
    });

    if (suppressed) {
      await database
        .update(guestMessages)
        .set({ status: "SUPPRESSED", suppressedAt: now, claimedAt: null })
        .where(stillClaimed(message));
      result.suppressed += 1;
      continue;
    }

    const sendResult = await sender.send({
      id: message.id,
      channel: message.channel,
      to: message.recipientAddress,
      subject: message.subject,
      body: message.body,
    });

    result[await recordResult(database, message, sendResult, { ...options, now })] += 1;
  }

  return result;
}
