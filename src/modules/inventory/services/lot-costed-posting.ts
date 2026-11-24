import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

import { inventoryLotMovements, inventoryLots, inventoryTransactions } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import {
  addDecimals,
  isPositiveDecimal,
  negateDecimal,
  subtractDecimals,
  toScale,
} from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

import { baseUnitCost, extendCost } from "../rules/costing";
import { allocateFromLots, settleShortfalls } from "../rules/lot-allocation";
import {
  onHandUnitCost,
  shortfallUnitCost,
  splitArrivingValue,
  sumKnown,
  unitCostOf,
  valueTaken,
} from "../rules/lot-costing";
import { COST_SCALE, type InventoryTransactionType } from "../types";
import { createLot, type LotPostingInput } from "./lot-posting";

// Phase 37 (policies 4–8, D4–D8): the lot side of a posting for an item costed by lot. Called
// only by `postInventoryTransaction`, under the balance lock, BEFORE the ledger row is written:
// the lots decide the row's cost. Lots change at once; the movements are written by `write`
// once the ledger row exists. Every movement of a `LOT` item carries its cost; a lot's value
// moves with its quantity, and a shortfall settled by a new lot leaves the difference between
// the lot value taken and the shortfall value closed on the lot-side movement.

export type LotCostedInput = {
  organizationId: string;
  locationId: string;
  inventoryItemId: string;
  type: InventoryTransactionType;
  baseQuantityDelta: string;
  businessDate: string;
  reversesTransactionId: string | null;
  /** RECEIVE, TRANSFER_IN, SALE_REVERSAL: the exact total cost entering. */
  incomingTotalCost: string | null;
  quantityOnHand: string;
  stockValue: string | null;
  lot: LotPostingInput;
};

export type LotCostedPlan = {
  /** The ledger row's cost: total (magnitude) and per base unit. */
  unitCost: string | null;
  totalCost: string | null;
  /** The signed change to the item's stock value at the location. */
  valueDelta: string;
  write(transactionId: string): Promise<void>;
};

type PendingMovement = {
  /** null: the ledger row being posted. */
  inventoryTransactionId: string | null;
  lotId: string | null;
  baseQuantityDelta: string;
  unitCost: string | null;
  totalCost: string | null;
  settlesMovementId?: string | null;
  costDifference?: string | null;
};

type LotState = {
  id: string;
  quantityRemaining: string;
  carryingUnitCost: string | null;
  valueRemaining: string | null;
};

const ZERO = "0.0000";

function plus(a: string | null, b: string | null): string | null {
  if (a === null) {
    return b;
  }

  return b === null ? a : toScale(addDecimals(a, b), COST_SCALE);
}

function minus(a: string | null, b: string | null): string | null {
  if (a === null || b === null) {
    return a;
  }

  const result = subtractDecimals(a, b);

  return toScale(result.startsWith("-") ? "0" : result, COST_SCALE);
}

async function saveLot(transaction: DatabaseTransaction, lot: LotState, quantityDelta: string) {
  await transaction
    .update(inventoryLots)
    .set({
      quantityRemaining: sql`${inventoryLots.quantityRemaining} + ${quantityDelta}::numeric`,
      carryingUnitCost: lot.carryingUnitCost,
      valueRemaining: lot.valueRemaining,
      version: sql`${inventoryLots.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(inventoryLots.id, lot.id));
}

/** The location's most recently received lot of the item that has a carrying cost. */
async function latestLotCarrying(transaction: DatabaseTransaction, input: Pick<LotCostedInput, "inventoryItemId" | "locationId">) {
  const [row] = await transaction
    .select({ carrying: inventoryLots.carryingUnitCost })
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.inventoryItemId, input.inventoryItemId),
        eq(inventoryLots.locationId, input.locationId),
        isNotNull(inventoryLots.carryingUnitCost),
      ),
    )
    .orderBy(desc(inventoryLots.receivedOn), desc(inventoryLots.sequenceNumber))
    .limit(1);

  return row?.carrying ?? null;
}

/** Open shortfalls of the item at the location, oldest first, with their open value. */
async function openCostedShortfalls(transaction: DatabaseTransaction, input: Pick<LotCostedInput, "inventoryItemId" | "locationId">) {
  const settledQuantity = sql`coalesce((SELECT sum(s.base_quantity_delta) FROM inventory_lot_movements s WHERE s.settles_movement_id = ${inventoryLotMovements.id}), 0)`;
  const settledValue = sql`coalesce((SELECT sum(s.total_cost) FROM inventory_lot_movements s WHERE s.settles_movement_id = ${inventoryLotMovements.id}), 0)`;
  const rows = await transaction
    .select({
      movementId: inventoryLotMovements.id,
      transactionId: inventoryLotMovements.inventoryTransactionId,
      open: sql<string>`(-${inventoryLotMovements.baseQuantityDelta} - ${settledQuantity})::numeric(14, 4)::text`,
      unitCost: inventoryLotMovements.unitCost,
      openValue: sql<string | null>`CASE WHEN ${inventoryLotMovements.totalCost} IS NULL THEN NULL
        ELSE greatest(${inventoryLotMovements.totalCost} - ${settledValue}, 0)::numeric(14, 4)::text END`,
    })
    .from(inventoryLotMovements)
    .innerJoin(inventoryTransactions, eq(inventoryTransactions.id, inventoryLotMovements.inventoryTransactionId))
    .where(
      and(
        isNull(inventoryLotMovements.lotId),
        lt(inventoryLotMovements.baseQuantityDelta, "0"),
        eq(inventoryTransactions.inventoryItemId, input.inventoryItemId),
        eq(inventoryTransactions.locationId, input.locationId),
      ),
    )
    .orderBy(asc(inventoryTransactions.sequence));

  return rows.filter((row) => isPositiveDecimal(row.open));
}

class Planner {
  readonly movements: PendingMovement[] = [];
  /** Lot value taken less shortfall value closed, summed over settlements in this posting. */
  costDifferences = "0";
  /** Shortfall quantity and value settled earlier in this posting, not yet written. */
  private readonly pendingSettled = new Map<string, { quantity: string; value: string }>();

  constructor(
    private readonly transaction: DatabaseTransaction,
    private readonly input: LotCostedInput,
  ) {}

  /** A new lot holding `quantity` at `value`, which first settles open shortfalls. */
  async newLot(lot: Parameters<typeof createLot>[1], value: string | null, carrying: string | null) {
    const lotId = await createLot(this.transaction, { ...lot, carryingUnitCost: carrying, valueRemaining: value });
    const state: LotState = { id: lotId, quantityRemaining: lot.quantity, carryingUnitCost: carrying, valueRemaining: value };

    this.movements.push({ inventoryTransactionId: null, lotId, baseQuantityDelta: lot.quantity, unitCost: carrying, totalCost: value });
    await this.settleFrom(state);
  }

  private async settleFrom(lot: LotState) {
    const shortfalls = (await openCostedShortfalls(this.transaction, this.input))
      .map((row) => {
        const pending = this.pendingSettled.get(row.movementId);

        return pending
          ? { ...row, open: subtractDecimals(row.open, pending.quantity), openValue: minus(row.openValue, pending.value) }
          : row;
      })
      .filter((row) => isPositiveDecimal(row.open));
    const { settlements } = settleShortfalls(shortfalls, lot.quantityRemaining);
    let taken = "0";

    for (const settlement of settlements) {
      const shortfall = shortfalls.find((row) => row.movementId === settlement.movementId)!;
      const closed = valueTaken(
        { quantityRemaining: shortfall.open, carryingUnitCost: shortfall.unitCost, valueRemaining: shortfall.openValue },
        settlement.quantity,
      );
      const lotValue = valueTaken(lot, settlement.quantity);
      const difference = toScale(subtractDecimals(lotValue ?? "0", closed ?? "0"), COST_SCALE);

      lot.quantityRemaining = subtractDecimals(lot.quantityRemaining, settlement.quantity);
      lot.valueRemaining = minus(lot.valueRemaining, lotValue);
      taken = addDecimals(taken, settlement.quantity);
      const pending = this.pendingSettled.get(settlement.movementId) ?? { quantity: "0", value: "0" };
      this.pendingSettled.set(settlement.movementId, {
        quantity: addDecimals(pending.quantity, settlement.quantity),
        value: addDecimals(pending.value, closed ?? "0"),
      });
      this.costDifferences = addDecimals(this.costDifferences, difference);
      this.movements.push(
        {
          inventoryTransactionId: settlement.transactionId,
          lotId: null,
          baseQuantityDelta: settlement.quantity,
          unitCost: shortfall.unitCost,
          totalCost: closed,
          settlesMovementId: settlement.movementId,
        },
        {
          inventoryTransactionId: settlement.transactionId,
          lotId: lot.id,
          baseQuantityDelta: negateDecimal(settlement.quantity),
          unitCost: lot.carryingUnitCost,
          totalCost: lotValue,
          costDifference: difference,
        },
      );
    }

    if (isPositiveDecimal(taken)) {
      await saveLot(this.transaction, lot, negateDecimal(taken));
    }
  }

  lotInput(origin: "RECEIPT" | "TRANSFER" | "OPENING" | "FOUND", quantity: string, unitCost: string | null) {
    return {
      organizationId: this.input.organizationId,
      locationId: this.input.locationId,
      inventoryItemId: this.input.inventoryItemId,
      origin,
      quantity,
      receivedOn: this.input.businessDate,
      expiresOn: this.input.lot.expiresOn ?? null,
      supplierLotCode: this.input.lot.supplierLotCode?.trim() || null,
      unitCost,
    };
  }
}

async function planDecrease(planner: Planner, transaction: DatabaseTransaction, input: LotCostedInput) {
  const magnitude = negateDecimal(input.baseQuantityDelta);
  const lots = await transaction
    .select({
      id: inventoryLots.id,
      expiresOn: inventoryLots.expiresOn,
      receivedOn: inventoryLots.receivedOn,
      sequenceNumber: inventoryLots.sequenceNumber,
      quantityRemaining: inventoryLots.quantityRemaining,
      carryingUnitCost: inventoryLots.carryingUnitCost,
      valueRemaining: inventoryLots.valueRemaining,
    })
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.inventoryItemId, input.inventoryItemId),
        eq(inventoryLots.locationId, input.locationId),
        gt(inventoryLots.quantityRemaining, "0"),
      ),
    )
    .orderBy(asc(inventoryLots.sequenceNumber))
    .for("update");
  const { allocations, shortfall } = allocateFromLots({
    lots,
    quantity: magnitude,
    namedLotId: input.lot.lotId ?? null,
    allowShortfall: input.type === "CONSUME",
  });
  let lastCarrying: string | null = null;

  for (const allocation of allocations) {
    const lot = lots.find((candidate) => candidate.id === allocation.lotId)!;
    const value = valueTaken(lot, allocation.quantity);
    const state: LotState = {
      id: lot.id,
      quantityRemaining: subtractDecimals(lot.quantityRemaining, allocation.quantity),
      carryingUnitCost: lot.carryingUnitCost,
      valueRemaining: minus(lot.valueRemaining, value),
    };

    lastCarrying = lot.carryingUnitCost ?? lastCarrying;
    await saveLot(transaction, state, negateDecimal(allocation.quantity));
    planner.movements.push({
      inventoryTransactionId: null,
      lotId: lot.id,
      baseQuantityDelta: negateDecimal(allocation.quantity),
      unitCost: lot.carryingUnitCost,
      totalCost: value,
    });
  }

  if (isPositiveDecimal(shortfall)) {
    const unitCost = shortfallUnitCost(lastCarrying, await latestLotCarrying(transaction, input));

    planner.movements.push({
      inventoryTransactionId: null,
      lotId: null,
      baseQuantityDelta: negateDecimal(shortfall),
      unitCost,
      totalCost: unitCost === null ? null : extendCost(shortfall, unitCost),
    });
  }

  const total = sumKnown(planner.movements.map((movement) => movement.totalCost));

  return { total, valueDelta: total === null ? "0" : negateDecimal(total) };
}

/** SALE_REVERSAL: stock goes back to exactly the lots its CONSUME took from, at what it took. */
async function planReversal(planner: Planner, transaction: DatabaseTransaction, input: LotCostedInput) {
  const quantity = input.baseQuantityDelta;
  const [originalRow] = await transaction
    .select({ unitCost: inventoryTransactions.unitCost })
    .from(inventoryTransactions)
    .where(eq(inventoryTransactions.id, input.reversesTransactionId!));
  const original = await transaction
    .select({
      id: inventoryLotMovements.id,
      lotId: inventoryLotMovements.lotId,
      delta: inventoryLotMovements.baseQuantityDelta,
      settlesMovementId: inventoryLotMovements.settlesMovementId,
      unitCost: inventoryLotMovements.unitCost,
      totalCost: inventoryLotMovements.totalCost,
    })
    .from(inventoryLotMovements)
    .where(eq(inventoryLotMovements.inventoryTransactionId, input.reversesTransactionId!));

  if (original.length === 0) {
    // Consumed before the item was lot tracked: the returned stock is a found lot.
    const value = input.incomingTotalCost;
    const carrying = unitCostOf(value, quantity);

    await planner.newLot(planner.lotInput("FOUND", quantity, carrying), value, carrying);
    return { total: value, valueDelta: value ?? "0" };
  }

  // What each lot gave, by quantity and value (a movement from before lot costing is valued at
  // the cost its ledger row left at).
  const perLot = new Map<string, { quantity: string; value: string | null }>();

  for (const movement of original) {
    if (!movement.lotId) {
      continue;
    }

    const entry = perLot.get(movement.lotId) ?? { quantity: "0", value: null };
    // Movements on lots under a CONSUME are always removals.
    const magnitude = negateDecimal(movement.delta);
    const value = movement.totalCost ?? (originalRow?.unitCost ? extendCost(magnitude, originalRow.unitCost) : null);

    entry.quantity = addDecimals(entry.quantity, magnitude);
    entry.value = value === null ? entry.value : toScale(addDecimals(entry.value ?? "0", value), COST_SCALE);
    perLot.set(movement.lotId, entry);
  }

  const lotIds = [...perLot.keys()];
  const lots =
    lotIds.length === 0
      ? []
      : await transaction
          .select({
            id: inventoryLots.id,
            quantityRemaining: inventoryLots.quantityRemaining,
            carryingUnitCost: inventoryLots.carryingUnitCost,
            valueRemaining: inventoryLots.valueRemaining,
          })
          .from(inventoryLots)
          .where(inArray(inventoryLots.id, lotIds))
          .orderBy(asc(inventoryLots.sequenceNumber))
          .for("update");
  const values: (string | null)[] = [];

  for (const lot of lots) {
    const given = perLot.get(lot.id)!;

    if (!isPositiveDecimal(given.quantity)) {
      continue;
    }

    const value = given.value;
    const state: LotState = {
      id: lot.id,
      quantityRemaining: addDecimals(lot.quantityRemaining, given.quantity),
      carryingUnitCost: lot.carryingUnitCost ?? unitCostOf(value, given.quantity),
      valueRemaining: value === null ? lot.valueRemaining : plus(lot.valueRemaining ?? ZERO, value),
    };

    await saveLot(transaction, state, given.quantity);
    values.push(value);
    planner.movements.push({
      inventoryTransactionId: null,
      lotId: lot.id,
      baseQuantityDelta: given.quantity,
      unitCost: state.carryingUnitCost,
      totalCost: value,
    });
  }

  // The part never covered by a lot: what remains open of the CONSUME's shortfall.
  const shortfall = original.find((movement) => movement.lotId === null && movement.settlesMovementId === null);

  if (shortfall) {
    const open = (await openCostedShortfalls(transaction, input)).find((row) => row.movementId === shortfall.id);

    if (open) {
      const closed = valueTaken(
        { quantityRemaining: open.open, carryingUnitCost: open.unitCost, valueRemaining: open.openValue },
        open.open,
      );

      values.push(closed);
      planner.movements.push({
        inventoryTransactionId: null,
        lotId: null,
        baseQuantityDelta: open.open,
        unitCost: open.unitCost,
        totalCost: closed,
        settlesMovementId: shortfall.id,
      });
    }
  }

  const total = sumKnown(values);

  return { total, valueDelta: total ?? "0" };
}

/** TRANSFER_IN: the lots the TRANSFER_OUT took arrive here, carrying exactly the value sent. */
async function planTransferIn(planner: Planner, transaction: DatabaseTransaction, input: LotCostedInput) {
  const sources = input.lot.mirrorTransactionId
    ? await transaction
        .select({
          lotId: inventoryLotMovements.lotId,
          delta: inventoryLotMovements.baseQuantityDelta,
          totalCost: inventoryLotMovements.totalCost,
          supplierLotCode: inventoryLots.supplierLotCode,
          expiresOn: inventoryLots.expiresOn,
          receivedOn: inventoryLots.receivedOn,
          unitCost: inventoryLots.unitCost,
          carryingUnitCost: inventoryLots.carryingUnitCost,
        })
        .from(inventoryLotMovements)
        .innerJoin(inventoryLots, eq(inventoryLots.id, inventoryLotMovements.lotId))
        .where(eq(inventoryLotMovements.inventoryTransactionId, input.lot.mirrorTransactionId))
        .orderBy(asc(inventoryLots.sequenceNumber))
    : [];
  const pieces = sources.map((source) => ({ quantity: negateDecimal(source.delta), value: source.totalCost }));
  const covered = pieces.reduce((sum, piece) => addDecimals(sum, piece.quantity), "0");
  const rest = subtractDecimals(input.baseQuantityDelta, covered);
  const split = splitArrivingValue({
    pieces,
    restQuantity: rest,
    valueSent: input.incomingTotalCost,
    unitCostSent: unitCostOf(input.incomingTotalCost, input.baseQuantityDelta),
  });

  for (const [index, source] of sources.entries()) {
    const quantity = pieces[index]!.quantity;
    const value = split.pieces[index] ?? null;
    const carrying = source.carryingUnitCost ?? unitCostOf(value, quantity);

    await planner.newLot(
      {
        ...planner.lotInput("TRANSFER", quantity, source.unitCost),
        receivedOn: source.receivedOn,
        expiresOn: source.expiresOn,
        supplierLotCode: source.supplierLotCode,
        sourceLotId: source.lotId,
      },
      value,
      carrying,
    );
  }

  // Stock the sender didn't hold in lots arrives as a found lot.
  if (isPositiveDecimal(rest)) {
    const carrying = unitCostOf(split.rest, rest);

    await planner.newLot({ ...planner.lotInput("FOUND", rest, carrying), expiresOn: null, supplierLotCode: null }, split.rest, carrying);
  }

  const total = input.incomingTotalCost ?? sumKnown([...split.pieces, split.rest]);
  const arrived = sumKnown([...split.pieces, split.rest]);

  return { total, valueDelta: arrived ?? "0" };
}

export async function planLotCostedPosting(transaction: DatabaseTransaction, input: LotCostedInput): Promise<LotCostedPlan> {
  if (input.lot.lotId && isPositiveDecimal(input.baseQuantityDelta)) {
    throw new BusinessRuleError("LOT_NOT_FOR_INCREASE", "A lot can only be chosen for stock leaving.");
  }

  const planner = new Planner(transaction, input);
  let result: { total: string | null; valueDelta: string };

  if (!isPositiveDecimal(input.baseQuantityDelta)) {
    result = await planDecrease(planner, transaction, input);
  } else if (input.type === "SALE_REVERSAL") {
    result = await planReversal(planner, transaction, input);
  } else if (input.type === "TRANSFER_IN") {
    result = await planTransferIn(planner, transaction, input);
  } else {
    // RECEIVE at its own cost; adjustment and count increases are found stock at the
    // on-hand cost (D5).
    const quantity = input.baseQuantityDelta;
    const carrying =
      input.incomingTotalCost !== null
        ? baseUnitCost(input.incomingTotalCost, quantity)
        : onHandUnitCost({
            quantityOnHand: input.quantityOnHand,
            stockValue: input.stockValue,
            latestLotCarrying: await latestLotCarrying(transaction, input),
          });
    const value = input.incomingTotalCost ?? (carrying === null ? null : extendCost(quantity, carrying));

    await planner.newLot(planner.lotInput(input.type === "RECEIVE" ? "RECEIPT" : "FOUND", quantity, carrying), value, carrying);
    result = { total: value, valueDelta: value ?? "0" };
  }

  const magnitude = input.baseQuantityDelta.replace(/^-/, "");
  const valueDelta = toScale(subtractDecimals(result.valueDelta, planner.costDifferences), COST_SCALE);

  return {
    totalCost: result.total,
    unitCost: input.type === "RECEIVE" && result.total !== null ? baseUnitCost(result.total, magnitude) : unitCostOf(result.total, magnitude),
    valueDelta,
    async write(transactionId: string) {
      if (planner.movements.length === 0) {
        return;
      }

      await transaction.insert(inventoryLotMovements).values(
        planner.movements.map((movement) => ({
          organizationId: input.organizationId,
          inventoryTransactionId: movement.inventoryTransactionId ?? transactionId,
          lotId: movement.lotId,
          baseQuantityDelta: movement.baseQuantityDelta,
          settlesMovementId: movement.settlesMovementId ?? null,
          unitCost: movement.unitCost,
          totalCost: movement.totalCost,
          costDifference: movement.costDifference ?? null,
        })),
      );
    },
  };
}
