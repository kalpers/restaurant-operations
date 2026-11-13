import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

import { inventoryLotMovements, inventoryLots, inventoryTransactions } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { addDecimals, isPositiveDecimal, negateDecimal, subtractDecimals } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

import { allocateFromLots, settleShortfalls, type OpenShortfall } from "../rules/lot-allocation";
import type { InventoryTransactionType } from "../types";

// Phase 23 (policies 16–19, D9, D11, D12): the lot side of a posting. Called only by
// `postInventoryTransaction`, inside its transaction and after the balance lock, for a
// lot-tracked item. Every ledger row's movements sum to its quantity:
//   decreases take lots first to expire (or a named lot); a CONSUME beyond the lots leaves a
//     shortfall (lot null) where negative stock is allowed;
//   RECEIVE, ADJUST_INCREASE and COUNT_INCREASE create a lot; TRANSFER_IN recreates the lots
//     its TRANSFER_OUT took; SALE_REVERSAL returns stock to the lots its CONSUME took from;
//   a new lot first settles open shortfalls, oldest first.

export type LotPostingInput = {
  /** Decreases: take from this lot only. */
  lotId?: string | null;
  /** New lots (RECEIVE, increases): what the supplier printed and the use-by date. */
  supplierLotCode?: string | null;
  expiresOn?: string | null;
  /** TRANSFER_IN: the TRANSFER_OUT row whose lots arrive. */
  mirrorTransactionId?: string | null;
};

type Posted = {
  organizationId: string;
  locationId: string;
  inventoryItemId: string;
  type: InventoryTransactionType;
  transactionId: string;
  baseQuantityDelta: string;
  businessDate: string;
  unitCost: string | null;
  reversesTransactionId: string | null;
  lot: LotPostingInput;
};

const LOT_ORIGIN: Partial<Record<InventoryTransactionType, "RECEIPT" | "FOUND">> = {
  RECEIVE: "RECEIPT",
  ADJUST_INCREASE: "FOUND",
  COUNT_INCREASE: "FOUND",
};

export function formatLotNumber(sequence: number): string {
  return `L-${String(sequence).padStart(6, "0")}`;
}

function lockAvailableLots(transaction: DatabaseTransaction, posted: Pick<Posted, "inventoryItemId" | "locationId">) {
  return transaction
    .select({
      id: inventoryLots.id,
      expiresOn: inventoryLots.expiresOn,
      receivedOn: inventoryLots.receivedOn,
      sequenceNumber: inventoryLots.sequenceNumber,
      quantityRemaining: inventoryLots.quantityRemaining,
    })
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.inventoryItemId, posted.inventoryItemId),
        eq(inventoryLots.locationId, posted.locationId),
        gt(inventoryLots.quantityRemaining, "0"),
      ),
    )
    .orderBy(asc(inventoryLots.sequenceNumber))
    .for("update");
}

async function changeLot(transaction: DatabaseTransaction, lotId: string, delta: string) {
  await transaction
    .update(inventoryLots)
    .set({
      quantityRemaining: sql`${inventoryLots.quantityRemaining} + ${delta}::numeric`,
      version: sql`${inventoryLots.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(inventoryLots.id, lotId));
}

async function insertMovements(
  transaction: DatabaseTransaction,
  organizationId: string,
  rows: { inventoryTransactionId: string; lotId: string | null; baseQuantityDelta: string; settlesMovementId?: string | null }[],
) {
  if (rows.length === 0) {
    return [];
  }

  return transaction
    .insert(inventoryLotMovements)
    .values(rows.map((row) => ({ organizationId, settlesMovementId: null, ...row })))
    .returning({ id: inventoryLotMovements.id });
}

/** A new lot at the location, numbered per location. Concurrent creations queue on a lock. */
export async function createLot(
  transaction: DatabaseTransaction,
  input: {
    organizationId: string;
    locationId: string;
    inventoryItemId: string;
    origin: "RECEIPT" | "TRANSFER" | "OPENING" | "FOUND";
    quantity: string;
    receivedOn: string;
    expiresOn: string | null;
    supplierLotCode: string | null;
    unitCost: string | null;
    sourceLotId?: string | null;
  },
): Promise<string> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory.lots:${input.locationId}`}))`);
  const [last] = await transaction
    .select({ value: sql<number | null>`max(${inventoryLots.sequenceNumber})` })
    .from(inventoryLots)
    .where(eq(inventoryLots.locationId, input.locationId));
  const sequenceNumber = Number(last?.value ?? 0) + 1;
  const [lot] = await transaction
    .insert(inventoryLots)
    .values({
      organizationId: input.organizationId,
      locationId: input.locationId,
      inventoryItemId: input.inventoryItemId,
      sequenceNumber,
      lotNumber: formatLotNumber(sequenceNumber),
      supplierLotCode: input.supplierLotCode,
      expiresOn: input.expiresOn,
      receivedOn: input.receivedOn,
      origin: input.origin,
      sourceLotId: input.sourceLotId ?? null,
      unitCost: input.unitCost,
      quantityReceived: input.quantity,
      quantityRemaining: input.quantity,
    })
    .returning({ id: inventoryLots.id });

  return lot!.id;
}

/** Shortfalls at the item and location not yet settled, oldest first. */
async function openShortfalls(transaction: DatabaseTransaction, posted: Pick<Posted, "inventoryItemId" | "locationId">) {
  const settled = sql<string>`coalesce((SELECT sum(s.base_quantity_delta) FROM inventory_lot_movements s WHERE s.settles_movement_id = ${inventoryLotMovements.id}), 0)`;
  const rows = await transaction
    .select({
      movementId: inventoryLotMovements.id,
      transactionId: inventoryLotMovements.inventoryTransactionId,
      open: sql<string>`(-${inventoryLotMovements.baseQuantityDelta} - ${settled})::numeric(14, 4)::text`,
    })
    .from(inventoryLotMovements)
    .innerJoin(inventoryTransactions, eq(inventoryTransactions.id, inventoryLotMovements.inventoryTransactionId))
    .where(
      and(
        isNull(inventoryLotMovements.lotId),
        lt(inventoryLotMovements.baseQuantityDelta, "0"),
        eq(inventoryTransactions.inventoryItemId, posted.inventoryItemId),
        eq(inventoryTransactions.locationId, posted.locationId),
      ),
    )
    .orderBy(asc(inventoryTransactions.sequence));

  return rows.filter((row): row is OpenShortfall => isPositiveDecimal(row.open));
}

/** Settles open shortfalls from a newly created lot, before anything else uses it. */
async function settleFromLot(transaction: DatabaseTransaction, posted: Posted, lotId: string, quantity: string) {
  const { settlements } = settleShortfalls(await openShortfalls(transaction, posted), quantity);

  for (const settlement of settlements) {
    await insertMovements(transaction, posted.organizationId, [
      {
        inventoryTransactionId: settlement.transactionId,
        lotId: null,
        baseQuantityDelta: settlement.quantity,
        settlesMovementId: settlement.movementId,
      },
      { inventoryTransactionId: settlement.transactionId, lotId, baseQuantityDelta: negateDecimal(settlement.quantity) },
    ]);
    await changeLot(transaction, lotId, negateDecimal(settlement.quantity));
  }
}

async function postDecrease(transaction: DatabaseTransaction, posted: Posted) {
  const magnitude = negateDecimal(posted.baseQuantityDelta);
  const lots = await lockAvailableLots(transaction, posted);
  const { allocations, shortfall } = allocateFromLots({
    lots,
    quantity: magnitude,
    namedLotId: posted.lot.lotId ?? null,
    allowShortfall: posted.type === "CONSUME",
  });

  await insertMovements(transaction, posted.organizationId, [
    ...allocations.map((allocation) => ({
      inventoryTransactionId: posted.transactionId,
      lotId: allocation.lotId,
      baseQuantityDelta: negateDecimal(allocation.quantity),
    })),
    ...(isPositiveDecimal(shortfall)
      ? [{ inventoryTransactionId: posted.transactionId, lotId: null, baseQuantityDelta: negateDecimal(shortfall) }]
      : []),
  ]);

  for (const allocation of allocations) {
    await changeLot(transaction, allocation.lotId, negateDecimal(allocation.quantity));
  }
}

/** SALE_REVERSAL: stock goes back to exactly the lots its CONSUME took from. */
async function postReversal(transaction: DatabaseTransaction, posted: Posted) {
  const original = await transaction
    .select({
      id: inventoryLotMovements.id,
      lotId: inventoryLotMovements.lotId,
      delta: inventoryLotMovements.baseQuantityDelta,
      settlesMovementId: inventoryLotMovements.settlesMovementId,
    })
    .from(inventoryLotMovements)
    .where(eq(inventoryLotMovements.inventoryTransactionId, posted.reversesTransactionId!));

  if (original.length === 0) {
    // Consumed before the item was lot tracked: the returned stock is a found lot.
    const lotId = await createLot(transaction, {
      organizationId: posted.organizationId,
      locationId: posted.locationId,
      inventoryItemId: posted.inventoryItemId,
      origin: "FOUND",
      quantity: posted.baseQuantityDelta,
      receivedOn: posted.businessDate,
      expiresOn: null,
      supplierLotCode: null,
      unitCost: posted.unitCost,
    });

    await insertMovements(transaction, posted.organizationId, [
      { inventoryTransactionId: posted.transactionId, lotId, baseQuantityDelta: posted.baseQuantityDelta },
    ]);
    await settleFromLot(transaction, posted, lotId, posted.baseQuantityDelta);
    return;
  }

  const perLot = new Map<string, string>();

  for (const movement of original) {
    if (movement.lotId) {
      perLot.set(movement.lotId, addDecimals(perLot.get(movement.lotId) ?? "0", movement.delta));
    }
  }

  // The part never covered by a lot: what remains open of the CONSUME's shortfall.
  const shortfall = original.find((movement) => movement.lotId === null && movement.settlesMovementId === null);
  const settledSoFar = shortfall
    ? (
        await transaction
          .select({ total: sql<string>`coalesce(sum(${inventoryLotMovements.baseQuantityDelta}), 0)::numeric(14, 4)::text` })
          .from(inventoryLotMovements)
          .where(eq(inventoryLotMovements.settlesMovementId, shortfall.id))
      )[0]!.total
    : "0";
  const stillOpen = shortfall ? subtractDecimals(negateDecimal(shortfall.delta), settledSoFar) : "0";
  const rows: Parameters<typeof insertMovements>[2] = [];

  for (const [lotId, net] of perLot) {
    if (isPositiveDecimal(negateDecimal(net))) {
      rows.push({ inventoryTransactionId: posted.transactionId, lotId, baseQuantityDelta: negateDecimal(net) });
    }
  }

  if (isPositiveDecimal(stillOpen)) {
    rows.push({ inventoryTransactionId: posted.transactionId, lotId: null, baseQuantityDelta: stillOpen, settlesMovementId: shortfall!.id });
  }

  if (perLot.size > 0) {
    await transaction
      .select({ id: inventoryLots.id })
      .from(inventoryLots)
      .where(inArray(inventoryLots.id, [...perLot.keys()]))
      .orderBy(asc(inventoryLots.sequenceNumber))
      .for("update");
  }
  await insertMovements(transaction, posted.organizationId, rows);

  for (const row of rows) {
    if (row.lotId) {
      await changeLot(transaction, row.lotId, row.baseQuantityDelta);
    }
  }
}

/** TRANSFER_IN: the lots the TRANSFER_OUT took arrive as lots here, with their dates. */
async function postTransferIn(transaction: DatabaseTransaction, posted: Posted) {
  const sources = posted.lot.mirrorTransactionId
    ? await transaction
        .select({
          lotId: inventoryLotMovements.lotId,
          delta: inventoryLotMovements.baseQuantityDelta,
          supplierLotCode: inventoryLots.supplierLotCode,
          expiresOn: inventoryLots.expiresOn,
          receivedOn: inventoryLots.receivedOn,
          unitCost: inventoryLots.unitCost,
        })
        .from(inventoryLotMovements)
        .innerJoin(inventoryLots, eq(inventoryLots.id, inventoryLotMovements.lotId))
        .where(eq(inventoryLotMovements.inventoryTransactionId, posted.lot.mirrorTransactionId))
        .orderBy(asc(inventoryLots.sequenceNumber))
    : [];
  let covered = "0";

  for (const source of sources) {
    const quantity = negateDecimal(source.delta);
    const lotId = await createLot(transaction, {
      organizationId: posted.organizationId,
      locationId: posted.locationId,
      inventoryItemId: posted.inventoryItemId,
      origin: "TRANSFER",
      quantity,
      receivedOn: source.receivedOn,
      expiresOn: source.expiresOn,
      supplierLotCode: source.supplierLotCode,
      unitCost: source.unitCost,
      sourceLotId: source.lotId,
    });

    await insertMovements(transaction, posted.organizationId, [
      { inventoryTransactionId: posted.transactionId, lotId, baseQuantityDelta: quantity },
    ]);
    await settleFromLot(transaction, posted, lotId, quantity);
    covered = addDecimals(covered, quantity);
  }

  // Stock the sender didn't hold in lots (not tracked there yet) arrives as a found lot.
  const rest = subtractDecimals(posted.baseQuantityDelta, covered);

  if (isPositiveDecimal(rest)) {
    await postNewLot(transaction, { ...posted, baseQuantityDelta: rest }, "FOUND");
  }
}

async function postNewLot(transaction: DatabaseTransaction, posted: Posted, origin: "RECEIPT" | "FOUND") {
  const lotId = await createLot(transaction, {
    organizationId: posted.organizationId,
    locationId: posted.locationId,
    inventoryItemId: posted.inventoryItemId,
    origin,
    quantity: posted.baseQuantityDelta,
    receivedOn: posted.businessDate,
    expiresOn: posted.lot.expiresOn ?? null,
    supplierLotCode: posted.lot.supplierLotCode?.trim() || null,
    unitCost: posted.unitCost,
  });

  await insertMovements(transaction, posted.organizationId, [
    { inventoryTransactionId: posted.transactionId, lotId, baseQuantityDelta: posted.baseQuantityDelta },
  ]);
  await settleFromLot(transaction, posted, lotId, posted.baseQuantityDelta);
}

export async function postLotMovements(transaction: DatabaseTransaction, posted: Posted): Promise<void> {
  if (posted.lot.lotId && isPositiveDecimal(posted.baseQuantityDelta)) {
    throw new BusinessRuleError("LOT_NOT_FOR_INCREASE", "A lot can only be chosen for stock leaving.");
  }

  if (!isPositiveDecimal(posted.baseQuantityDelta)) {
    await postDecrease(transaction, posted);
    return;
  }

  if (posted.type === "SALE_REVERSAL") {
    await postReversal(transaction, posted);
    return;
  }

  if (posted.type === "TRANSFER_IN") {
    await postTransferIn(transaction, posted);
    return;
  }

  await postNewLot(transaction, posted, LOT_ORIGIN[posted.type] ?? "FOUND");
}
