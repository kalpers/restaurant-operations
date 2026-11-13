import type { Database } from "@/db";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { seatParty } from "@/workflows/seat-party/seat-party";

import { newKey, orderRow } from "./order-fixtures";
import { tableFixture } from "./restaurant-fixtures";
import { at } from "./restaurant-day";
import { sentOrder, settlementRow, tender, type SettlementScenario } from "./settlement-fixtures";

/**
 * Phase 24 (D11): one real closed check at a local date and time, through the order,
 * SEND and settlement services. Dine-in when `partySize` is given (a new table session),
 * takeout otherwise. Needs `startFakeClock()`; the clock is left at that time. Kept apart
 * from `forecast-fixtures.ts` because the fake clock imports vitest, which E2E helpers
 * must not load.
 */
export async function closedCheckAt(
  database: Database,
  scenario: SettlementScenario,
  input: { date: string; time: string; partySize?: number },
): Promise<string> {
  at(input.date, input.time);

  const session = input.partySize
    ? await seatParty(database, scenario.owner, {
        tableIds: [await tableFixture(database, scenario, { capacity: Math.max(4, input.partySize) })],
        partySize: input.partySize,
        serverEmployeeId: null,
      })
    : null;
  const order = await sentOrder(database, scenario, ["10.00"], session ? { tableSessionId: session.id } : {});
  const { totalDue } = await orderRow(database, order.id);
  const { settlementId } = await openSettlement(database, scenario.cashier, order.id);

  await tender(database, scenario.cashier, settlementId, { amount: totalDue, receivedAmount: totalDue });
  await completeSettlement(database, scenario.cashier, settlementId, {
    expectedVersion: (await settlementRow(database, settlementId)).version,
    idempotencyKey: newKey(),
  });

  return order.id;
}
