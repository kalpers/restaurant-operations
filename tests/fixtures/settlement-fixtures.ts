import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { orderStatusHistory, settlements, settlementStatusHistory, settlementTenders } from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { openSettlement, recordTender, type RecordTenderInput } from "@/modules/settlements/services/settlement-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith } from "./employee-fixtures";
import {
  createOrderScenario,
  MANAGER_ORDER_PERMISSIONS,
  newKey,
  orderRow,
  plainItem,
  SERVER_ORDER_PERMISSIONS,
  seatedSession,
} from "./order-fixtures";

/** What the Server role holds for settlement (approved Phase 11 grants). */
export const SERVER_SETTLEMENT_PERMISSIONS: readonly PermissionCode[] = [
  ...SERVER_ORDER_PERMISSIONS,
  "settlements.view",
  "settlements.create",
  "settlements.tender.cash",
  "settlements.tender.external-card",
  "settlements.tender.gift-card",
  "settlements.complete",
];

export const MANAGER_SETTLEMENT_PERMISSIONS: readonly PermissionCode[] = [
  ...MANAGER_ORDER_PERMISSIONS,
  "settlements.view",
  "settlements.create",
  "settlements.tender.cash",
  "settlements.tender.external-card",
  "settlements.tender.gift-card",
  "settlements.tender.house-account",
  "settlements.tender.other",
  "settlements.complete",
  "settlements.void-tender",
  "settlements.view-card-metadata",
];

/** The order scenario plus a cashier (Server grants), a settlement manager and a viewer. */
export async function createSettlementScenario(database: Database) {
  const scenario = await createOrderScenario(database);

  return {
    ...scenario,
    cashier: await actorWith(database, scenario, SERVER_SETTLEMENT_PERMISSIONS),
    settleManager: await actorWith(database, scenario, MANAGER_SETTLEMENT_PERMISSIONS),
    settlementViewer: await actorWith(database, scenario, ["orders.view", "settlements.view"]),
    managerAtB: await actorWith(database, scenario, MANAGER_SETTLEMENT_PERMISSIONS, scenario.locationB),
  };
}

export type SettlementScenario = Awaited<ReturnType<typeof createSettlementScenario>>;

/**
 * Opens an order (takeout by default, or dine-in on the given session), adds one plain item
 * per price, and sends them. `drafts` adds unsent items after the send.
 */
export async function sentOrder(
  database: Database,
  scenario: SettlementScenario,
  prices: readonly string[],
  options: { tableSessionId?: string; drafts?: readonly string[] } = {},
) {
  const actor = scenario.cashier;
  const order = options.tableSessionId
    ? await createOrder(database, actor, { orderType: "DINE_IN", tableSessionId: options.tableSessionId })
    : await createOrder(database, actor, { orderType: "TAKEOUT" });
  let version = order.version;
  const add = async (price: string) => {
    const item = await plainItem(database, scenario.owner, price, `Item ${price}`);

    version = (
      await addDraftItem(database, actor, order.id, {
        expectedVersion: version,
        menuItemId: item.id,
        quantity: 1,
        selections: [],
        specialInstructions: null,
      })
    ).orderVersion;
  };

  for (const price of prices) {
    await add(price);
  }

  if (prices.length > 0) {
    version = (await sendOrderItems(database, actor, order.id, { expectedVersion: version, idempotencyKey: newKey() }))
      .orderVersion;
  }

  for (const price of options.drafts ?? []) {
    await add(price);
  }

  return { id: order.id, version };
}

/** A dine-in session with a seated party. */
export function session(database: Database, scenario: SettlementScenario) {
  return seatedSession(database, scenario);
}

export async function settlementRow(database: Database, settlementId: string) {
  const [row] = await database.select().from(settlements).where(eq(settlements.id, settlementId));

  return row!;
}

export function tendersOf(database: Database, settlementId: string) {
  return database
    .select()
    .from(settlementTenders)
    .where(eq(settlementTenders.settlementId, settlementId))
    .orderBy(asc(settlementTenders.recordedAt), asc(settlementTenders.id));
}

export function settlementHistory(database: Database, settlementId: string) {
  return database
    .select()
    .from(settlementStatusHistory)
    .where(eq(settlementStatusHistory.settlementId, settlementId))
    .orderBy(asc(settlementStatusHistory.occurredAt));
}

export function orderHistory(database: Database, orderId: string) {
  return database
    .select()
    .from(orderStatusHistory)
    .where(eq(orderStatusHistory.orderId, orderId))
    .orderBy(asc(orderStatusHistory.occurredAt));
}

export { orderRow };

type TenderOverrides = Partial<Omit<RecordTenderInput, "expectedVersion">> & { expectedVersion?: number };

/** Records a tender at the settlement's current version, with defaults for every field. */
export async function tender(
  database: Database,
  actor: Actor,
  settlementId: string,
  overrides: TenderOverrides,
) {
  const expectedVersion = overrides.expectedVersion ?? (await settlementRow(database, settlementId)).version;

  return recordTender(database, actor, settlementId, {
    idempotencyKey: newKey(),
    tenderType: "CASH",
    outcome: "RECORDED",
    amount: "0.00",
    tipAmount: null,
    receivedAmount: null,
    externalReference: null,
    providerName: null,
    cardBrand: null,
    cardLastFour: null,
    authorizationReference: null,
    otherDescription: null,
    failureReason: null,
    ...overrides,
    expectedVersion,
  });
}

/** Opens a settlement for an order and returns its ID and version. */
export async function opened(database: Database, actor: Actor, orderId: string) {
  return openSettlement(database, actor, orderId);
}
