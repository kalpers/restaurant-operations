import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, guestLoyaltyBalances, guestLoyaltyEntries, orderRefunds } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import {
  createGuestProfile,
  eraseGuestProfile,
  mergeGuestProfiles,
  type ProfileFields,
} from "@/modules/reservations/services/guest-profile-service";
import { adjustLoyaltyPoints, createLoyaltyReward, updateLoyaltyProgram } from "@/modules/reservations/services/loyalty-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { completeTableSession } from "@/workflows/end-table-session/end-table-session";
import { recordRefund } from "@/workflows/record-refund/record-refund";
import { redeemLoyaltyReward } from "@/workflows/redeem-loyalty-reward/redeem-loyalty-reward";
import { seatWalkIn } from "@/workflows/seat-guest-party/seat-guest-party";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidRefund } from "@/workflows/void-refund/void-refund";

import { actorWith, clearRestaurantData } from "../../fixtures/employee-fixtures";
import { createKitchenScenario, type KitchenScenario } from "../../fixtures/kitchen-fixtures";
import { newKey, orderRow, SERVER_ORDER_PERMISSIONS } from "../../fixtures/order-fixtures";
import { sessionRow, tableFixture } from "../../fixtures/restaurant-fixtures";
import { settlementRow, tender } from "../../fixtures/settlement-fixtures";

// Phase 33 policies 7–12: refunds take back the loyalty points they paid for, on the visit's
// running total and from the earning snapshot, never below what the guest can spend; voiding a
// refund puts them back; earning leaves out refunds already recorded.

const database = () => getDatabase();

const fields = (displayName: string): ProfileFields => ({
  displayName,
  phone: null,
  email: null,
  vip: false,
  vipReason: null,
  preferences: null,
  notes: null,
  otherDietaryNeeds: null,
});

describe("loyalty points and refunds (Phase 33)", () => {
  let scenario: KitchenScenario;
  let host: Actor;
  let server: Actor;
  let manager: Actor;

  beforeEach(async () => {
    scenario = await createKitchenScenario(database());
    host = await actorWith(database(), scenario.base, [
      "restaurant.view",
      "restaurant.seat",
      "restaurant.complete-session",
      "waitlist.manage",
      "guests.view",
      "guests.manage",
    ]);
    server = await actorWith(database(), scenario.base, [
      ...SERVER_ORDER_PERMISSIONS,
      "settlements.view",
      "settlements.create",
      "settlements.tender.cash",
      "settlements.complete",
      "settlements.refund",
      "settlements.refund-void",
      "guests.view",
      "loyalty.redeem",
    ]);
    manager = await actorWith(database(), scenario.base, [
      "guests.view",
      "guests.manage",
      "guests.merge",
      "guests.erase",
      "loyalty.manage",
      "loyalty.adjust",
    ]);
  });

  afterAll(async () => {
    await clearRestaurantData(database());
    await closeDatabase();
  });

  async function setProgram(enabled: boolean, pointsPerDollar = 2, pointsPerVisit = 5) {
    const current = await database().execute<{ version: number }>(
      sql`SELECT version FROM guest_loyalty_programs WHERE organization_id = ${manager.organizationId}`,
    );

    return updateLoyaltyProgram(database(), manager, {
      enabled,
      pointsPerDollar,
      pointsPerVisit,
      expectedVersion: [...current][0]?.version ?? 0,
    });
  }

  async function profileVersion(profileId: string) {
    const [row] = [...(await database().execute<{ version: number }>(sql`SELECT version FROM guest_profiles WHERE id = ${profileId}`))];

    return row!.version;
  }

  /** A linked walk-in with fries and a cocktail, settled; the session still open. */
  async function closedVisit(profileId: string) {
    const tableId = await tableFixture(database(), scenario.base, { areaId: scenario.base.dining });
    const seated = await seatWalkIn(database(), host, { guestName: "Guest", partySize: 2, tableIds: [tableId], guestProfileId: profileId });
    const order = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: seated.id });

    for (const menuItemId of [scenario.fries.id, scenario.cocktail.id]) {
      await addDraftItem(database(), server, order.id, {
        expectedVersion: (await orderRow(database(), order.id)).version,
        menuItemId,
        quantity: 1,
        selections: [],
        specialInstructions: null,
      });
    }

    await sendOrderItems(database(), server, order.id, { expectedVersion: (await orderRow(database(), order.id)).version, idempotencyKey: newKey() });

    const { settlementId, orderAmountSnapshot } = await openSettlement(database(), server, order.id);

    await tender(database(), server, settlementId, { amount: orderAmountSnapshot, receivedAmount: orderAmountSnapshot });
    await completeSettlement(database(), server, settlementId, {
      expectedVersion: (await settlementRow(database(), settlementId)).version,
      idempotencyKey: newKey(),
    });

    return { sessionId: seated.id, partyId: seated.guestPartyId, orderId: order.id };
  }

  async function endSession(sessionId: string) {
    return completeTableSession(database(), host, sessionId, { expectedVersion: (await sessionRow(database(), sessionId)).version });
  }

  function refund(orderId: string, amount: string, taxAmount = "0.00", key = newKey()) {
    return recordRefund(database(), server, orderId, {
      idempotencyKey: key,
      tenderType: "EXTERNAL_CARD",
      amount,
      taxAmount,
      reason: "Guest unhappy",
      otherDescription: null,
      externalReference: null,
    });
  }

  const entriesOf = (profileId: string) =>
    database().select().from(guestLoyaltyEntries).where(eq(guestLoyaltyEntries.guestProfileId, profileId)).orderBy(guestLoyaltyEntries.sequence);

  async function balanceOf(profileId: string) {
    const [row] = await database()
      .select({ balance: guestLoyaltyBalances.balance })
      .from(guestLoyaltyBalances)
      .where(eq(guestLoyaltyBalances.guestProfileId, profileId));

    return row?.balance ?? 0;
  }

  async function earnedVisit(name = "Refund Guest") {
    await setProgram(true);

    const guest = await createGuestProfile(database(), host, fields(name));
    const visit = await closedVisit(guest.id);

    await endSession(visit.sessionId);

    const [earned] = await entriesOf(guest.id);

    return { guest, visit, earned: earned! };
  }

  // The scenario's items carry no tax; refunds net of tax are covered by the unit tests.
  it("takes back the dollar points of the refunded amount, from the earning snapshot, once per key", async () => {
    const { guest, visit, earned } = await earnedVisit();
    // The program changes after earning; the snapshot decides.
    await setProgram(true, 10, 50);

    const key = newKey();
    const first = await refund(visit.orderId, "3.00", "0.00", key);
    const net = 3;
    const expected = Math.floor(Number(earned.eligibleSubtotal) * 2) - Math.floor((Number(earned.eligibleSubtotal) - net) * 2);

    expect(first).toMatchObject({ loyaltyPointsTaken: expected, loyaltyPointsShort: 0, replayed: false });

    const retry = await refund(visit.orderId, "3.00", "0.00", key);

    expect(retry).toMatchObject({ replayed: true, loyaltyPointsTaken: expected });

    const entries = await entriesOf(guest.id);

    expect(entries.map((entry) => entry.kind)).toEqual(["EARNED", "REFUND_REVERSED"]);
    expect(entries[1]).toMatchObject({ points: -expected, refundId: first.refundId, orderId: visit.orderId, guestPartyId: visit.partyId });
    expect(await balanceOf(guest.id)).toBe(earned.points - expected);

    const [audit] = await database().select().from(auditEvents).where(eq(auditEvents.entityId, first.refundId));

    expect(audit!.after).toMatchObject({ loyaltyPointsTaken: expected, loyaltyPointsShort: 0 });
  });

  it("takes the rest of the dollar points over several refunds, and never the visit points", async () => {
    const { guest, visit, earned } = await earnedVisit();
    const subtotal = earned.eligibleSubtotal!;
    const dollarPoints = Math.floor(Number(subtotal) * 2);
    const half = (Number(subtotal) / 2).toFixed(2);
    const rest = (Number(subtotal) - Number(half)).toFixed(2);
    const a = await refund(visit.orderId, half);
    const b = await refund(visit.orderId, rest);

    expect(a.loyaltyPointsTaken + b.loyaltyPointsTaken).toBe(dollarPoints);
    expect(await balanceOf(guest.id)).toBe(5);
  });

  it("puts back exactly what a voided refund took, and nothing for one that took nothing", async () => {
    const { guest, visit, earned } = await earnedVisit();
    const recorded = await refund(visit.orderId, "4.00");
    const [row] = await database().select({ version: orderRefunds.version }).from(orderRefunds).where(eq(orderRefunds.id, recorded.refundId));
    const voided = await voidRefund(database(), server, recorded.refundId, { expectedVersion: row!.version, reason: "Entered by mistake" });

    expect(voided.loyaltyPointsRestored).toBe(recorded.loyaltyPointsTaken);
    expect((await entriesOf(guest.id)).map((entry) => entry.kind)).toEqual(["EARNED", "REFUND_REVERSED", "REFUND_RESTORED"]);
    expect(await balanceOf(guest.id)).toBe(earned.points);
  });

  it("stops at the points the guest can spend, keeps a pending reward whole, and never refuses the refund", async () => {
    const { guest, visit, earned } = await earnedVisit();
    const reward = await createLoyaltyReward(database(), manager, {
      name: "Small reward",
      pointsCost: earned.points - 2,
      scope: "ORDER",
      discountType: "FIXED_AMOUNT",
      value: "1.00",
    });
    // A second visit, still open, holds a reward for nearly the whole balance.
    const tableId = await tableFixture(database(), scenario.base, { areaId: scenario.base.dining });
    const seated = await seatWalkIn(database(), host, { guestName: "Guest", partySize: 2, tableIds: [tableId], guestProfileId: guest.id });
    const open = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: seated.id });

    await addDraftItem(database(), server, open.id, {
      expectedVersion: (await orderRow(database(), open.id)).version,
      menuItemId: scenario.fries.id,
      quantity: 1,
      selections: [],
      specialInstructions: null,
    });
    await sendOrderItems(database(), server, open.id, { expectedVersion: (await orderRow(database(), open.id)).version, idempotencyKey: newKey() });
    await redeemLoyaltyReward(database(), server, open.id, {
      rewardId: reward.id,
      expectedVersion: (await orderRow(database(), open.id)).version,
      idempotencyKey: newKey(),
    });

    const result = await refund(visit.orderId, earned.eligibleSubtotal!);

    expect(result.loyaltyPointsTaken).toBe(2);
    expect(result.loyaltyPointsShort).toBe(Math.floor(Number(earned.eligibleSubtotal) * 2) - 2);
    expect(await balanceOf(guest.id)).toBe(earned.points - 2);
  });

  it("takes from the profile the points were merged into, and from nobody once erased", async () => {
    const { guest, visit } = await earnedVisit("Duplicate Guest");
    const kept = await createGuestProfile(database(), host, fields("Kept Guest"));

    await mergeGuestProfiles(database(), manager, {
      duplicateProfileId: guest.id,
      duplicateVersion: await profileVersion(guest.id),
      keptProfileId: kept.id,
      keptVersion: await profileVersion(kept.id),
      reason: "Same guest",
    });

    const keptBefore = await balanceOf(kept.id);
    const first = await refund(visit.orderId, "2.00");

    expect(first.loyaltyPointsTaken).toBeGreaterThan(0);
    expect(await balanceOf(kept.id)).toBe(keptBefore - first.loyaltyPointsTaken);

    await eraseGuestProfile(database(), manager, { profileId: kept.id, expectedVersion: await profileVersion(kept.id), reason: "Guest asked" });

    const second = await refund(visit.orderId, "2.00");

    expect(second).toMatchObject({ loyaltyPointsTaken: 0, loyaltyPointsShort: 0 });
  });

  it("leaves out refunds recorded before the visit earned, with no reversal entry", async () => {
    await setProgram(true);

    const guest = await createGuestProfile(database(), host, fields("Early Refund"));
    const visit = await closedVisit(guest.id);
    const subtotal = (await orderRow(database(), visit.orderId)).subtotal;
    const early = await refund(visit.orderId, "3.00");

    expect(early).toMatchObject({ loyaltyPointsTaken: 0, loyaltyPointsShort: 0 });

    await endSession(visit.sessionId);

    const entries = await entriesOf(guest.id);
    const net = (Number(subtotal) - 3).toFixed(2);

    expect(entries.map((entry) => entry.kind)).toEqual(["EARNED"]);
    expect(entries[0]).toMatchObject({ eligibleSubtotal: net, points: Math.floor(Number(net) * 2) + 5 });
  });

  it("reverses whether or not the program is still on, and adjustments still work after", async () => {
    const { guest, visit, earned } = await earnedVisit();

    await setProgram(false);

    const result = await refund(visit.orderId, "1.00");

    expect(result.loyaltyPointsTaken).toBe(Math.floor(Number(earned.eligibleSubtotal) * 2) - Math.floor((Number(earned.eligibleSubtotal) - 1) * 2));

    await adjustLoyaltyPoints(database(), manager, guest.id, { points: 3, reason: "Goodwill" });
    expect(await balanceOf(guest.id)).toBe(earned.points - result.loyaltyPointsTaken + 3);
  });
});
