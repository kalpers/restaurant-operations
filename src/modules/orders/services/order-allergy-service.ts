import { and, asc, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { nextVersion } from "@/db/helpers/versioning";
import { allergens, orderAllergies, orders, tableSessions } from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import type { AllergySeverity, RecordedAllergy } from "@/modules/recipes/rules/allergen-label";
import { assertNoCardNumbers } from "@/modules/reservations/rules/guest-contact";
import { loadPartyGuestFacts, type PartyGuestFacts } from "@/modules/reservations/services/party-allergy-service";
import { ALLERGIES_CHANGED_EVENT, requireAllergenCodes } from "@/modules/reservations/services/guest-profile-service";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import { lockOrder } from "../repositories/order-repository";
import { assertOrderOpen } from "../rules/order-lifecycle";
import { assertPermission } from "./access";

// Phase 21 (policies 8 and 12): the allergies an order's warning checks. A check with a guest
// party uses the party's (the visit's); one without (takeout, a bar tab) records its own here.

export type OrderAllergies = {
  source: "PARTY" | "ORDER";
  guestPartyId: string | null;
  allergies: (RecordedAllergy & { note: string | null })[];
  /** The party's profile, when linked, for the screen. */
  profile: PartyGuestFacts["profile"];
};

/** The party an order belongs to: its own link, or its table session's. */
async function partyOf(executor: DatabaseExecutor, order: { guestPartyId: string | null; tableSessionId: string | null }) {
  if (order.guestPartyId) {
    return order.guestPartyId;
  }

  if (!order.tableSessionId) {
    return null;
  }

  const [session] = await executor
    .select({ guestPartyId: tableSessions.guestPartyId })
    .from(tableSessions)
    .where(eq(tableSessions.id, order.tableSessionId));

  return session?.guestPartyId ?? null;
}

export async function loadOrderAllergies(
  executor: DatabaseExecutor,
  order: { id: string; guestPartyId: string | null; tableSessionId: string | null },
): Promise<OrderAllergies> {
  const partyId = await partyOf(executor, order);

  if (partyId) {
    const facts = (await loadPartyGuestFacts(executor, [partyId])).get(partyId);

    return {
      source: "PARTY",
      guestPartyId: partyId,
      allergies: (facts?.allergies ?? []).map((entry) => ({
        allergenId: entry.allergenId,
        code: entry.code,
        name: entry.name,
        severity: entry.severity,
        note: entry.note,
      })),
      profile: facts?.profile ?? null,
    };
  }

  const rows = await executor
    .select({
      allergenId: orderAllergies.allergenId,
      code: allergens.code,
      name: allergens.name,
      severity: orderAllergies.severity,
      note: orderAllergies.note,
    })
    .from(orderAllergies)
    .innerJoin(allergens, eq(allergens.id, orderAllergies.allergenId))
    .where(eq(orderAllergies.orderId, order.id))
    .orderBy(asc(allergens.displayOrder), asc(allergens.name));

  return {
    source: "ORDER",
    guestPartyId: null,
    allergies: rows.map((row) => ({ ...row, severity: row.severity as AllergySeverity })),
    profile: null,
  };
}

async function lockCheckForAllergies(
  transaction: DatabaseTransaction,
  actor: Actor,
  orderId: string,
  expectedVersion: number,
) {
  const order = await lockOrder(transaction, actor, orderId, expectedVersion);

  assertOrderOpen(order.status);

  if (await partyOf(transaction, order)) {
    throw new BusinessRuleError(
      "ORDER_HAS_PARTY",
      "This check belongs to a seated party. Record allergies on the party instead.",
    );
  }

  return order;
}

async function finish(
  transaction: DatabaseTransaction,
  actor: Actor,
  order: { id: string; orderNumber: number },
  change: { added: string[]; removed: string[] },
) {
  const now = new Date();
  const [row] = await transaction
    .update(orders)
    .set({ version: nextVersion(orders.version), updatedAt: now })
    .where(eq(orders.id, order.id))
    .returning({ version: orders.version });

  await recordAudit(transaction, actor, {
    action: "guests.allergies-changed",
    entityId: order.id,
    details: { orderId: order.id, ...change },
  });
  await writeOutboxEvents(transaction, [
    {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      eventType: ALLERGIES_CHANGED_EVENT,
      aggregateType: "order",
      aggregateId: order.id,
      payload: { orderId: order.id },
      occurredAt: now,
    },
  ]);

  return { orderId: order.id, orderVersion: row!.version };
}

/** Adds or changes one allergy on a check with no party. */
export async function recordOrderAllergy(
  database: Database,
  actor: Actor,
  input: { orderId: string; expectedVersion: number; allergenId: string; severity: AllergySeverity; note: string | null },
) {
  assertPermission(actor, "orders.edit");

  const note = input.note?.trim() || null;

  if (note && note.length > 200) {
    throw new BusinessRuleError("INVALID_NOTE", "Keep the note to 200 characters.");
  }

  assertNoCardNumbers({ note });

  return withTransaction(database, async (transaction) => {
    const order = await lockCheckForAllergies(transaction, actor, input.orderId, input.expectedVersion);
    const [existing] = await transaction
      .select()
      .from(orderAllergies)
      .where(and(eq(orderAllergies.orderId, order.id), eq(orderAllergies.allergenId, input.allergenId)));
    const codes = await requireAllergenCodes(transaction, actor, [input.allergenId], existing ? new Set([input.allergenId]) : new Set());
    const now = new Date();

    if (existing) {
      await transaction
        .update(orderAllergies)
        .set({ severity: input.severity, note, recordedByUserId: actor.userId, recordedAt: now })
        .where(eq(orderAllergies.id, existing.id));
    } else {
      await transaction.insert(orderAllergies).values({
        organizationId: actor.organizationId,
        orderId: order.id,
        allergenId: input.allergenId,
        severity: input.severity,
        note,
        recordedByUserId: actor.userId,
        recordedAt: now,
      });
    }

    const code = codes.get(input.allergenId);

    return finish(transaction, actor, order, {
      added: [`${code}:${input.severity}`],
      removed: existing ? [`${code}:${existing.severity}`] : [],
    });
  });
}

export async function removeOrderAllergy(
  database: Database,
  actor: Actor,
  input: { orderId: string; expectedVersion: number; allergenId: string },
) {
  assertPermission(actor, "orders.edit");

  return withTransaction(database, async (transaction) => {
    const order = await lockCheckForAllergies(transaction, actor, input.orderId, input.expectedVersion);
    const removed = await transaction
      .delete(orderAllergies)
      .where(and(eq(orderAllergies.orderId, order.id), eq(orderAllergies.allergenId, input.allergenId)))
      .returning({ severity: orderAllergies.severity });

    if (removed.length === 0) {
      throw new NotFoundError("check allergy");
    }

    const codes = await requireAllergenCodes(transaction, actor, [input.allergenId], new Set([input.allergenId]));

    return finish(transaction, actor, order, { added: [], removed: [`${codes.get(input.allergenId)}:${removed[0]!.severity}`] });
  });
}
