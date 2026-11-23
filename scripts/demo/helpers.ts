import { eq } from "drizzle-orm";

import type { Database } from "../../src/db";
import { kitchenTicketItems, seedRuns } from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { transitionTicketItem } from "../../src/modules/kitchen/services/fulfillment-service";
import type { RecordTenderInput } from "../../src/modules/settlements/services/settlement-service";
import { AppError } from "../../src/shared/errors/app-error";

/** A repeatable random sequence, so every run and every machine builds the same demo. */
export function seededRandom(seed: string): () => number {
  let state = 2166136261;

  for (const char of seed) {
    state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  }

  return () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);

    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

export const pickFrom = <T>(random: () => number, list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
export const between = (random: () => number, low: number, high: number) => low + Math.floor(random() * (high - low + 1));
export const timeOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export function need<T>(map: Map<string, T>, key: string, label: string): T {
  const value = map.get(key);

  if (value === undefined) {
    throw new Error(`Demo ${label} ${key} is missing. Run \`npm run db:seed\` and the earlier demo steps first.`);
  }

  return value;
}

/** Ignores the "already there" refusals a rerun meets; anything else still fails. */
export async function unlessExists(codes: readonly string[], work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof AppError && codes.includes(error.code))) {
      throw error;
    }
  }
}

/** The refusal code a piece of work ended with, or null when it succeeded. */
export async function codeOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;

    return null;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    throw error;
  }
}

/** The `seed_runs` keys already recorded, and a way to record one more. */
export async function seedRunTracker(database: Database) {
  const done = new Set((await database.select({ key: seedRuns.seedKey }).from(seedRuns)).map((row) => row.key));

  return {
    done,
    record: async (key: string) => {
      await database.insert(seedRuns).values({ seedKey: key }).onConflictDoNothing();
      done.add(key);
    },
  };
}

/** Kitchen and bar work every ticket item of an order through to completed. */
export async function completeAllTickets(database: Database, actor: Actor, orderId: string): Promise<void> {
  const steps = { NEW: ["start", "ready", "complete"], PREPARING: ["ready", "complete"], READY: ["complete"] } as const;

  for (const item of await database.select().from(kitchenTicketItems).where(eq(kitchenTicketItems.orderId, orderId))) {
    let version = item.version;

    for (const action of steps[item.status as keyof typeof steps] ?? []) {
      version = (await transitionTicketItem(database, actor, item.id, action, { expectedVersion: version })).version;
    }
  }
}

/** The fields of an external card tender that the demo never fills. */
export const CARD_TENDER: Omit<RecordTenderInput, "expectedVersion" | "idempotencyKey" | "tenderType" | "amount"> = {
  outcome: "RECORDED",
  tipAmount: null,
  receivedAmount: null,
  externalReference: null,
  providerName: null,
  cardBrand: null,
  cardLastFour: null,
  authorizationReference: null,
  otherDescription: null,
  failureReason: null,
};
