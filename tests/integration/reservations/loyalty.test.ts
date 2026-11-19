import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  auditEvents,
  guestLoyaltyBalances,
  guestLoyaltyEntries,
  guestLoyaltyRedemptions,
  inventoryTransactions,
  kitchenTickets,
  orderDiscounts,
  orderItemDiscounts,
  orderItemInventoryConsumption,
  orders,
} from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import {
  applyOrderDiscount,
  listDiscountDefinitions,
  removeDiscount,
  updateDiscountDefinition,
} from "@/modules/orders/services/discount-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { runReport } from "@/modules/reporting/services/report-service";
import {
  createGuestProfile,
  eraseGuestProfile,
  mergeGuestProfiles,
  unlinkPartyProfile,
  type ProfileFields,
} from "@/modules/reservations/services/guest-profile-service";
import {
  adjustLoyaltyPoints,
  createLoyaltyReward,
  getProfileLoyalty,
  getVisitEarningForOrder,
  listLoyaltyRewards,
  updateLoyaltyProgram,
  updateLoyaltyReward,
} from "@/modules/reservations/services/loyalty-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { AppError, AuthorizationError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { completeTableSession } from "@/workflows/end-table-session/end-table-session";
import { redeemLoyaltyReward } from "@/workflows/redeem-loyalty-reward/redeem-loyalty-reward";
import { seatWalkIn } from "@/workflows/seat-guest-party/seat-guest-party";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith, clearRestaurantData } from "../../fixtures/employee-fixtures";
import { createKitchenScenario, type KitchenScenario } from "../../fixtures/kitchen-fixtures";
import { newKey, orderRow, SERVER_ORDER_PERMISSIONS } from "../../fixtures/order-fixtures";
import { sessionRow, tableFixture } from "../../fixtures/restaurant-fixtures";
import { settlementRow, tender } from "../../fixtures/settlement-fixtures";

// Phase 30 policies 4-14 and amendments 3-8: earning at session end, rewards as reward-only
// discounts, posting at close, merge, erase, unlink, the guards and the report.

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : `DB:${(error as Error).message}`;
  }

  return undefined;
}

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

describe("guest loyalty (Phase 30)", () => {
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
      "orders.discount.apply",
      "orders.discount.manage",
      "orders.view",
      "reports.view",
      "reports.sales",
    ]);
  });

  afterAll(async () => {
    await clearRestaurantData(database());
    await closeDatabase();
  });

  async function enable(pointsPerDollar = 1, pointsPerVisit = 5) {
    const current = await database().execute<{ version: number }>(
      sql`SELECT version FROM guest_loyalty_programs WHERE organization_id = ${manager.organizationId}`,
    );

    return updateLoyaltyProgram(database(), manager, {
      enabled: true,
      pointsPerDollar,
      pointsPerVisit,
      expectedVersion: [...current][0]?.version ?? 0,
    });
  }

  async function profile(name = "Loyal Guest") {
    return createGuestProfile(database(), host, fields(name));
  }

  /** A walk-in linked to the profile, with one check holding the given items, sent. */
  async function visit(profileId: string | null, items: { menuItemId: string; selections?: unknown[] }[] = [{ menuItemId: scenario.fries.id }]) {
    const tableId = await tableFixture(database(), scenario.base, { areaId: scenario.base.dining });
    const seated = await seatWalkIn(database(), host, {
      guestName: "Guest",
      partySize: 2,
      tableIds: [tableId],
      ...(profileId ? { guestProfileId: profileId } : {}),
    });
    const order = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: seated.id });

    for (const item of items) {
      await addDraftItem(database(), server, order.id, {
        expectedVersion: (await orderRow(database(), order.id)).version,
        menuItemId: item.menuItemId,
        quantity: 1,
        selections: (item.selections ?? []) as never,
        specialInstructions: null,
      });
    }

    await sendOrderItems(database(), server, order.id, {
      expectedVersion: (await orderRow(database(), order.id)).version,
      idempotencyKey: newKey(),
    });

    return { sessionId: seated.id, partyId: seated.guestPartyId, orderId: order.id };
  }

  async function settle(orderId: string) {
    const { settlementId, orderAmountSnapshot } = await openSettlement(database(), server, orderId);

    if (orderAmountSnapshot !== "0.00") {
      await tender(database(), server, settlementId, { amount: orderAmountSnapshot, receivedAmount: orderAmountSnapshot });
    }

    return completeSettlement(database(), server, settlementId, {
      expectedVersion: (await settlementRow(database(), settlementId)).version,
      idempotencyKey: newKey(),
    });
  }

  async function endSession(sessionId: string) {
    return completeTableSession(database(), host, sessionId, {
      expectedVersion: (await sessionRow(database(), sessionId)).version,
    });
  }

  const entriesOf = (profileId: string) =>
    database()
      .select()
      .from(guestLoyaltyEntries)
      .where(eq(guestLoyaltyEntries.guestProfileId, profileId))
      .orderBy(guestLoyaltyEntries.sequence);

  async function balanceOf(profileId: string) {
    const [row] = await database()
      .select({ balance: guestLoyaltyBalances.balance })
      .from(guestLoyaltyBalances)
      .where(eq(guestLoyaltyBalances.guestProfileId, profileId));

    return row?.balance ?? 0;
  }

  async function expectBalanceMatchesLedger(profileId: string) {
    const entries = await entriesOf(profileId);

    expect(await balanceOf(profileId)).toBe(entries.reduce((sum, entry) => sum + entry.points, 0));
  }

  async function reward(overrides: Partial<Parameters<typeof createLoyaltyReward>[2]> = {}) {
    return createLoyaltyReward(database(), manager, {
      name: "Five off",
      pointsCost: 20,
      scope: "ORDER",
      discountType: "FIXED_AMOUNT",
      value: "1.00",
      ...overrides,
    });
  }

  function redeem(orderId: string, rewardId: string, key = newKey(), actor = server, orderItemId?: string) {
    return orderRow(database(), orderId).then((order) =>
      redeemLoyaltyReward(database(), actor, orderId, {
        rewardId,
        expectedVersion: order.version,
        idempotencyKey: key,
        ...(orderItemId ? { orderItemId } : {}),
      }),
    );
  }

  describe("earning (policies 4, 5)", () => {
    it("earns once, when the session ends, from the CLOSED checks with the rates stored", async () => {
      await enable(2, 5);

      const guest = await profile();
      const seated = await visit(guest.id);

      await settle(seated.orderId);

      // Closing the check alone earns nothing; the link can still change.
      expect(await entriesOf(guest.id)).toHaveLength(0);

      await endSession(seated.sessionId);

      const subtotal = (await orderRow(database(), seated.orderId)).subtotal;
      const [earned] = await entriesOf(guest.id);
      const expected = Math.floor(Number(subtotal) * 2) + 5;

      expect(earned).toMatchObject({
        kind: "EARNED",
        points: expected,
        balanceAfter: expected,
        guestPartyId: seated.partyId,
        eligibleSubtotal: subtotal,
        pointsPerDollarSnapshot: 2,
        pointsPerVisitSnapshot: 5,
        locationId: scenario.base.locationA,
      });
      expect(earned!.businessDate).not.toBeNull();
      await expectBalanceMatchesLedger(guest.id);

      // A later rate change leaves what was earned alone.
      await enable(10, 0);

      expect((await entriesOf(guest.id))[0]).toEqual(earned);
      expect(await getVisitEarningForOrder(database(), manager, seated.orderId)).toMatchObject({
        profileId: guest.id,
        points: expected,
      });
    });

    it("earns nothing with the program off, without a link, or for a visit before the program", async () => {
      const guest = await profile();
      const before = await visit(guest.id);

      await settle(before.orderId);
      await endSession(before.sessionId);
      await enable();

      // Nothing retroactive for the visit that finished while the program was never on.
      expect(await entriesOf(guest.id)).toHaveLength(0);

      const unlinked = await visit(null);

      await settle(unlinked.orderId);
      await endSession(unlinked.sessionId);

      expect(await database().select().from(guestLoyaltyEntries).where(eq(guestLoyaltyEntries.organizationId, manager.organizationId))).toHaveLength(0);

      await updateLoyaltyProgram(database(), manager, { enabled: false, pointsPerDollar: 1, pointsPerVisit: 5, expectedVersion: 1 });

      const off = await visit(guest.id);

      await settle(off.orderId);
      await endSession(off.sessionId);

      expect(await entriesOf(guest.id)).toHaveLength(0);
    });

    it("keeps the canonical Bacon Cheeseburger SEND unchanged with the program on, and earns once", async () => {
      await enable(1, 0);

      const guest = await profile();
      const tableId = await tableFixture(database(), scenario.base, { areaId: scenario.base.dining });
      const seated = await seatWalkIn(database(), host, { guestName: "Guest", partySize: 2, tableIds: [tableId], guestProfileId: guest.id });
      const order = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: seated.id });

      await addDraftItem(database(), server, order.id, {
        expectedVersion: (await orderRow(database(), order.id)).version,
        menuItemId: scenario.burger.menuItem.id,
        quantity: 1,
        selections: scenario.burger.canonicalSelections,
        specialInstructions: null,
      });

      const key = newKey();
      const expectedVersion = (await orderRow(database(), order.id)).version;
      const first = await sendOrderItems(database(), server, order.id, { expectedVersion, idempotencyKey: key });
      const counts = async () => ({
        tickets: (await database().select().from(kitchenTickets).where(eq(kitchenTickets.orderId, order.id))).length,
        ledger: (await database().select().from(inventoryTransactions)).length,
        consumption: (await database().select().from(orderItemInventoryConsumption)).length,
        loyalty: (
          await database().select().from(guestLoyaltyEntries).where(eq(guestLoyaltyEntries.organizationId, manager.organizationId))
        ).length,
      });
      const afterFirst = await counts();
      const retry = await sendOrderItems(database(), server, order.id, { expectedVersion, idempotencyKey: key });

      expect(retry.replayed).toBe(true);
      expect(retry.orderVersion).toBe(first.orderVersion);
      expect(await counts()).toEqual(afterFirst);
      expect(afterFirst.loyalty).toBe(0);

      await settle(order.id);
      await endSession(seated.id);

      const subtotal = (await orderRow(database(), order.id)).subtotal;

      expect(await entriesOf(guest.id)).toEqual([
        expect.objectContaining({ kind: "EARNED", points: Math.floor(Number(subtotal)) }),
      ]);
    });
  });

  describe("rewards and redemption (policies 7-9, amendments 3, 4, 6)", () => {
    it("redeems as an ordinary discount, holds the points until close, and retries apply nothing", async () => {
      await enable();

      const guest = await profile();
      const prize = await reward({ pointsCost: 20 });
      const seated = await visit(guest.id);

      expect(await codeOf(redeem(seated.orderId, prize.id))).toBe("INSUFFICIENT_POINTS");
      expect(await database().select().from(guestLoyaltyRedemptions).where(eq(guestLoyaltyRedemptions.organizationId, manager.organizationId))).toHaveLength(0);

      await adjustLoyaltyPoints(database(), manager, guest.id, { points: 30, reason: "Welcome" });

      const key = newKey();
      const first = await redeem(seated.orderId, prize.id, key);

      expect(first).toMatchObject({ pointsCost: 20, available: 10, replayed: false });

      const replay = await redeemLoyaltyReward(database(), server, seated.orderId, {
        rewardId: prize.id,
        expectedVersion: first.orderVersion - 1,
        idempotencyKey: key,
      });

      expect(replay).toMatchObject({ redemptionId: first.redemptionId, replayed: true });
      expect(await database().select().from(orderDiscounts).where(eq(orderDiscounts.orderId, seated.orderId))).toHaveLength(1);

      const [discount] = await database().select().from(orderDiscounts).where(eq(orderDiscounts.id, first.discountId));

      expect(discount).toMatchObject({ status: "APPLIED", appliedAmount: "1.00", reason: "Loyalty: Five off", codeSnapshot: "LOYALTY-1" });

      // Pending: still on the balance, not available, and a second one can't be afforded.
      expect(await balanceOf(guest.id)).toBe(30);
      expect(await getProfileLoyalty(database(), manager, guest.id)).toMatchObject({ balance: 30, available: 10 });
      expect(await codeOf(redeem(seated.orderId, prize.id))).toBe("INSUFFICIENT_POINTS");
      expect(await codeOf(adjustLoyaltyPoints(database(), manager, guest.id, { points: -11, reason: "Oops" }))).toBe(
        "INSUFFICIENT_POINTS",
      );

      await settle(seated.orderId);

      const entries = await entriesOf(guest.id);

      expect(entries.map((entry) => [entry.kind, entry.points])).toEqual([
        ["ADJUSTED", 30],
        ["REDEEMED", -20],
      ]);
      expect(entries[1]).toMatchObject({ orderId: seated.orderId, redemptionId: first.redemptionId });
      await expectBalanceMatchesLedger(guest.id);

      // Ending the session earns on the subtotal after the reward.
      await endSession(seated.sessionId);

      const subtotal = (await orderRow(database(), seated.orderId)).subtotal;

      expect((await entriesOf(guest.id)).at(-1)).toMatchObject({ kind: "EARNED", points: Math.floor(Number(subtotal)) + 5 });
      await expectBalanceMatchesLedger(guest.id);
    });

    it("posts nothing for a reward whose discount was removed before close", async () => {
      await enable();

      const guest = await profile();
      const prize = await reward({ pointsCost: 10 });

      await adjustLoyaltyPoints(database(), manager, guest.id, { points: 50, reason: "Start" });

      const seated = await visit(guest.id);
      const redeemed = await redeem(seated.orderId, prize.id);

      await removeDiscount(database(), manager, seated.orderId, redeemed.discountId, {
        reason: "Guest saving points",
        expectedVersion: (await orderRow(database(), seated.orderId)).version,
      });

      expect(await getProfileLoyalty(database(), manager, guest.id)).toMatchObject({ balance: 50, available: 50 });

      await settle(seated.orderId);

      expect((await entriesOf(guest.id)).map((entry) => entry.kind)).toEqual(["ADJUSTED"]);
    });

    it("applies item rewards to a sent item and refuses the wrong shape", async () => {
      await enable();

      const guest = await profile();
      const free = await reward({ name: "Free fries", scope: "ITEM", discountType: "PERCENTAGE", value: "100", pointsCost: 5 });

      await adjustLoyaltyPoints(database(), manager, guest.id, { points: 5, reason: "Start" });

      const seated = await visit(guest.id);
      const [item] = await database().execute<{ id: string }>(sql`SELECT id FROM order_items WHERE order_id = ${seated.orderId}`);

      expect(await codeOf(redeem(seated.orderId, free.id))).toBe("REWARD_NEEDS_ITEM");

      const done = await redeem(seated.orderId, free.id, newKey(), server, item!.id);
      const [discount] = await database().select().from(orderItemDiscounts).where(eq(orderItemDiscounts.id, done.discountId));

      expect(discount).toMatchObject({ isComp: true, status: "APPLIED" });
    });

    it("refuses with no linked guest, program off, an inactive reward or a settlement in progress, writing nothing", async () => {
      await enable();

      const guest = await profile();
      const prize = await reward({ pointsCost: 1 });

      await adjustLoyaltyPoints(database(), manager, guest.id, { points: 10, reason: "Start" });

      const unlinked = await visit(null);
      const takeout = await createOrder(database(), server, { orderType: "TAKEOUT" });

      expect(await codeOf(redeem(unlinked.orderId, prize.id))).toBe("NO_LINKED_GUEST");
      expect(await codeOf(redeem(takeout.id, prize.id))).toBe("NO_LINKED_GUEST");

      const seated = await visit(guest.id);

      await openSettlement(database(), server, seated.orderId);

      expect(await codeOf(redeem(seated.orderId, prize.id))).toBe("SETTLEMENT_IN_PROGRESS");

      const other = await visit(guest.id);

      await updateLoyaltyReward(database(), manager, prize.id, {
        name: prize.name,
        pointsCost: 1,
        value: prize.value,
        active: false,
        expectedVersion: prize.version,
      });

      expect(await codeOf(redeem(other.orderId, prize.id))).toBe("REWARD_INACTIVE");

      await updateLoyaltyProgram(database(), manager, { enabled: false, pointsPerDollar: 1, pointsPerVisit: 5, expectedVersion: 1 });

      expect(await codeOf(redeem(other.orderId, prize.id))).toBe("LOYALTY_NOT_ENABLED");
      expect(await database().select().from(guestLoyaltyRedemptions).where(eq(guestLoyaltyRedemptions.organizationId, manager.organizationId))).toHaveLength(0);
      expect(
        await database()
          .select({ id: orderDiscounts.id })
          .from(orderDiscounts)
          .innerJoin(orders, eq(orders.id, orderDiscounts.orderId))
          .where(eq(orders.organizationId, manager.organizationId)),
      ).toHaveLength(0);
    });

    it("keeps reward-only discounts out of the ordinary discount paths", async () => {
      const prize = await reward();
      const definitions = await listDiscountDefinitions(database(), manager, { includeInactive: true });
      const own = definitions.find((entry) => entry.code === `LOYALTY-${prize.rewardNumber}`)!;

      expect(own.rewardOnly).toBe(true);
      expect((await listDiscountDefinitions(database(), manager)).some((entry) => entry.id === own.id)).toBe(false);
      expect(
        await codeOf(updateDiscountDefinition(database(), manager, own.id, { name: "X", value: "2.00", active: true, expectedVersion: own.version })),
      ).toBe("REWARD_ONLY_DISCOUNT");

      const seated = await visit(null);

      expect(
        await codeOf(
          applyOrderDiscount(database(), manager, seated.orderId, {
            discountDefinitionId: own.id,
            reason: "Trying",
            expectedVersion: (await orderRow(database(), seated.orderId)).version,
          }),
        ),
      ).toBe("REWARD_ONLY_DISCOUNT");
    });

    it("never lets two redemptions at once spend more than the guest has", async () => {
      await enable();

      const guest = await profile();
      const prize = await reward({ pointsCost: 20 });

      await adjustLoyaltyPoints(database(), manager, guest.id, { points: 30, reason: "Start" });

      // Two checks for the same guest (two tables), redeemed at the same moment: the balance
      // lock serializes them, so the second sees the first as pending.
      const tableA = await visit(guest.id);
      const tableB = await visit(guest.id);
      const results = await Promise.allSettled([redeem(tableA.orderId, prize.id), redeem(tableB.orderId, prize.id)]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect((failures[0]!.reason as AppError).code).toBe("INSUFFICIENT_POINTS");
      expect(
        await database()
          .select()
          .from(guestLoyaltyRedemptions)
          .where(eq(guestLoyaltyRedemptions.organizationId, manager.organizationId)),
      ).toHaveLength(1);
    });
  });

  describe("unlink, merge and erase (policy 10)", () => {
    it("refuses to unlink a visit with a reward, and moves points on merge", async () => {
      await enable();

      const kept = await profile("Kept");
      const duplicate = await profile("Duplicate");
      const prize = await reward({ pointsCost: 5 });

      await adjustLoyaltyPoints(database(), manager, duplicate.id, { points: 40, reason: "Start" });

      const seated = await visit(duplicate.id);

      await redeem(seated.orderId, prize.id);

      const party = await database().execute<{ version: number }>(sql`SELECT version FROM guest_parties WHERE id = ${seated.partyId}`);

      expect(
        await codeOf(unlinkPartyProfile(database(), host, { guestPartyId: seated.partyId, expectedPartyVersion: [...party][0]!.version })),
      ).toBe("REWARD_APPLIED");

      const versions = async () => {
        const rows = await database().execute<{ id: string; version: number }>(
          sql`SELECT id, version FROM guest_profiles WHERE id IN (${kept.id}, ${duplicate.id})`,
        );

        return new Map([...rows].map((row) => [row.id, row.version]));
      };
      const merge = async () => {
        const map = await versions();

        return mergeGuestProfiles(database(), manager, {
          duplicateProfileId: duplicate.id,
          duplicateVersion: map.get(duplicate.id)!,
          keptProfileId: kept.id,
          keptVersion: map.get(kept.id)!,
          reason: "Same guest",
        });
      };

      expect(await codeOf(merge())).toBe("REWARD_PENDING");

      await settle(seated.orderId);
      await merge();

      expect((await entriesOf(duplicate.id)).at(-1)).toMatchObject({ kind: "MERGED_OUT", points: -35, balanceAfter: 0, relatedProfileId: kept.id });
      expect(await entriesOf(kept.id)).toEqual([
        expect.objectContaining({ kind: "MERGED_IN", points: 35, relatedProfileId: duplicate.id }),
      ]);
      expect(await balanceOf(kept.id)).toBe(35);
      await expectBalanceMatchesLedger(kept.id);
      await expectBalanceMatchesLedger(duplicate.id);

      const [audit] = await database()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "guests.profile-merged"), eq(auditEvents.entityId, duplicate.id)));

      expect(audit!.details).toMatchObject({ pointsMoved: 35 });
    });

    it("erases the balance with an entry, keeps the entries, and is refused while a reward is pending", async () => {
      await enable();

      const guest = await profile();
      const prize = await reward({ pointsCost: 5 });

      await adjustLoyaltyPoints(database(), manager, guest.id, { points: 25, reason: "Start" });

      const seated = await visit(guest.id);

      await redeem(seated.orderId, prize.id);

      const version = async () =>
        [...(await database().execute<{ version: number }>(sql`SELECT version FROM guest_profiles WHERE id = ${guest.id}`))][0]!
          .version;

      expect(await codeOf(eraseGuestProfile(database(), manager, { profileId: guest.id, expectedVersion: await version(), reason: "Request" }))).toBe(
        "REWARD_PENDING",
      );

      await settle(seated.orderId);
      await eraseGuestProfile(database(), manager, { profileId: guest.id, expectedVersion: await version(), reason: "Request" });

      const entries = await entriesOf(guest.id);

      expect(entries.map((entry) => entry.kind)).toEqual(["ADJUSTED", "REDEEMED", "ERASED"]);
      expect(entries.at(-1)).toMatchObject({ points: -20, balanceAfter: 0 });
      expect(await balanceOf(guest.id)).toBe(0);

      // An erased profile never earns (amendment 5).
      await endSession(seated.sessionId);

      expect(await entriesOf(guest.id)).toHaveLength(3);
    });
  });

  describe("guards (policy 6, amendment 8)", () => {
    it("refuses to change or delete entries, a broken running balance and a balance out of step", async () => {
      const guest = await profile();

      await adjustLoyaltyPoints(database(), manager, guest.id, { points: 10, reason: "Start" });

      const [entry] = await entriesOf(guest.id);

      expect(await codeOf(database().update(guestLoyaltyEntries).set({ points: 99 }).where(eq(guestLoyaltyEntries.id, entry!.id)))).toMatch(
        /^DB:/,
      );
      expect(await codeOf(database().delete(guestLoyaltyEntries).where(eq(guestLoyaltyEntries.id, entry!.id)))).toMatch(/^DB:/);
      expect(await codeOf(database().update(guestLoyaltyBalances).set({ balance: 11 }).where(eq(guestLoyaltyBalances.guestProfileId, guest.id)))).toMatch(
        /^DB:/,
      );
      expect(
        await codeOf(
          database().insert(guestLoyaltyEntries).values({
            organizationId: manager.organizationId,
            guestProfileId: guest.id,
            kind: "ADJUSTED",
            points: 5,
            balanceAfter: 99,
            reason: "Forged",
            createdByUserId: manager.userId,
            occurredAt: new Date(),
          }),
        ),
      ).toMatch(/^DB:/);
      await expectBalanceMatchesLedger(guest.id);
    });
  });

  describe("authorization (policy 13)", () => {
    it("refuses each action without its permission", async () => {
      const nobody = await actorWith(database(), scenario.base, ["orders.view"]);
      const guest = await profile();

      await expect(updateLoyaltyProgram(database(), nobody, { enabled: true, pointsPerDollar: 1, pointsPerVisit: 0, expectedVersion: 0 })).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(reward().then(() => createLoyaltyReward(database(), nobody, { name: "X", pointsCost: 1, scope: "ORDER", discountType: "FIXED_AMOUNT", value: "1.00" }))).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(adjustLoyaltyPoints(database(), nobody, guest.id, { points: 1, reason: "X" })).rejects.toBeInstanceOf(AuthorizationError);
      await expect(getProfileLoyalty(database(), nobody, guest.id)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(listLoyaltyRewards(database(), nobody)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        redeemLoyaltyReward(database(), nobody, guest.id, { rewardId: guest.id, expectedVersion: 1, idempotencyKey: newKey() }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("report (policy 16, amendment 1)", () => {
    it("adds earned, redeemed and outstanding points in the Sales area, with no guest names", async () => {
      await enable(1, 0);

      const guest = await profile("Report Guest");
      const prize = await reward({ pointsCost: 5, name: "Report reward" });

      await adjustLoyaltyPoints(database(), manager, guest.id, { points: 20, reason: "Start" });

      const seated = await visit(guest.id);

      await redeem(seated.orderId, prize.id);
      await settle(seated.orderId);
      await endSession(seated.sessionId);

      const [{ business_date: day }] = [
        ...(await database().execute<{ business_date: string }>(sql`SELECT business_date::text FROM ${orders} WHERE id = ${seated.orderId}`)),
      ];
      const report = await runReport(database(), manager, "sales", {
        locationId: scenario.base.locationA,
        from: day!,
        to: day!,
      } as never);
      const section = (key: string) => report.sections.find((entry) => entry.key === key)!;
      const earned = (await entriesOf(guest.id)).find((entry) => entry.kind === "EARNED")!.points;

      expect(section("loyaltyPoints").rows).toEqual([
        expect.objectContaining({ businessDate: day, earned, redeemed: 5, adjusted: 20, guests: 1 }),
      ]);
      expect(section("loyaltyRewards").rows).toEqual([
        expect.objectContaining({ reward: "Report reward", redeemed: 1, points: 5, discount: "1.00" }),
      ]);
      expect(section("loyaltyOutstanding").rows[0]).toMatchObject({ profiles: 1, points: 20 - 5 + earned });
      expect(JSON.stringify(report)).not.toContain("Report Guest");
    });
  });
});
