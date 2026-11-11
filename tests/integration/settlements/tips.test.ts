import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, employees, tipDistributionLines, tipDistributions } from "@/db/schema";
import { createOrder } from "@/modules/orders/services/order-service";
import { runReport } from "@/modules/reporting/services/report-service";
import { adjustEntry, clockIn, voidEntry } from "@/modules/scheduling/services/timeclock-service";
import {
  getMyTipShares,
  getTipRule,
  listDistributions,
  saveTipRule,
  voidDistribution,
} from "@/modules/settlements/services/tip-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import {
  finalizeTipDistribution,
  previewTipDistribution,
} from "@/workflows/finalize-tip-distribution/finalize-tip-distribution";

import { actorWith, clearEmployeeData, createEmployeeFixture } from "../../fixtures/employee-fixtures";
import { newKey } from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  opened,
  orderRow,
  sentOrder,
  settlementRow,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";
import { insertClosedEntry, key } from "../../fixtures/timeclock-fixtures";

const database = () => getDatabase();
const HOUR = 3_600_000;

describe("tip pools", () => {
  let scenario: SettlementScenario;
  let businessDate: string;

  async function closedCheckWithTip(price: string, tip: string, tenderType: "CASH" | "EXTERNAL_CARD") {
    const order = await sentOrder(database(), scenario, [price]);
    const { settlementId } = await opened(database(), scenario.cashier, order.id);

    await tender(database(), scenario.cashier, settlementId, {
      tenderType,
      amount: price,
      tipAmount: tip,
      receivedAmount: tenderType === "CASH" ? (Number(price) + Number(tip)).toFixed(2) : null,
      ...(tenderType === "EXTERNAL_CARD" ? { cardBrand: "VISA", cardLastFour: "4242" } : {}),
    });
    await completeSettlement(database(), scenario.cashier, settlementId, {
      expectedVersion: (await settlementRow(database(), settlementId)).version,
      idempotencyKey: newKey(),
    });

    return (await orderRow(database(), order.id))!;
  }

  async function worker(positionId: string, hours: number, options: { breakHours?: number; offsetHours?: number } = {}) {
    const { id } = await createEmployeeFixture(database(), scenario.owner, { positionId });
    const clockInAt = new Date(Date.now() - (options.offsetHours ?? 12) * HOUR);
    const clockOutAt = new Date(clockInAt.getTime() + (hours + (options.breakHours ?? 0)) * HOUR);

    await insertClosedEntry(database(), scenario.owner, {
      employeeId: id,
      positionId,
      businessDate,
      clockInAt,
      clockOutAt,
      ...(options.breakHours
        ? {
            unpaidBreak: {
              startedAt: new Date(clockInAt.getTime() + HOUR),
              endedAt: new Date(clockInAt.getTime() + (1 + options.breakHours) * HOUR),
            },
          }
        : {}),
    });

    return id;
  }

  async function poolRule() {
    await saveTipRule(database(), scenario.owner, {
      name: "House pool",
      active: true,
      positions: [
        { positionId: scenario.server, points: "10" },
        { positionId: scenario.waitStaff, points: "5" },
      ],
      expectedVersion: null,
    });
  }

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());

    const card = await closedCheckWithTip("20.00", "6.00", "EXTERNAL_CARD");

    await closedCheckWithTip("10.00", "3.00", "CASH");
    businessDate = card.businessDate;
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  it("splits the day's tips by hours × points, exactly, and snapshots it once", async () => {
    await poolRule();

    const a = await worker(scenario.server, 6);
    const b = await worker(scenario.server, 3, { breakHours: 1 });
    const c = await worker(scenario.waitStaff, 6);

    await worker(scenario.cook, 5);

    const preview = await previewTipDistribution(database(), scenario.owner, businessDate);

    expect(preview.totals).toEqual({ cashTips: "3.00", cardTips: "6.00", poolTotal: "9.00" });
    expect(preview.blockers).toEqual({ openOrders: 0, openSettlements: 0, openTimeEntries: false });
    expect(Object.fromEntries(preview.lines.map((line) => [line.employeeId, line.share]))).toEqual({
      [a]: "4.50",
      [b]: "2.25",
      [c]: "2.25",
    });

    const idempotencyKey = key();
    const first = await finalizeTipDistribution(database(), scenario.owner, { businessDate, idempotencyKey });
    const retry = await finalizeTipDistribution(database(), scenario.owner, { businessDate, idempotencyKey });

    expect(retry.id).toBe(first.id);
    expect(first).toMatchObject({ poolTotal: "9.00", lineCount: 3 });
    await expect(
      finalizeTipDistribution(database(), scenario.owner, { businessDate, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "TIP_DISTRIBUTION_FINALIZED" });

    const lines = await database()
      .select()
      .from(tipDistributionLines)
      .where(eq(tipDistributionLines.distributionId, first.id));

    expect(lines.reduce((sum, line) => sum + Math.round(Number(line.share) * 100), 0)).toBe(900);
    expect(lines.find((line) => line.employeeId === b)).toMatchObject({
      workedHours: "3.0000",
      points: "10.00",
      weightedHours: "30.0000",
      positionCodeSnapshot: "SERVER",
    });

    const [audit] = await database().select().from(auditEvents).where(eq(auditEvents.entityId, first.id));

    expect(audit!.details).toEqual({ businessDate, poolTotal: "9.00", lineCount: 3 });

    // A later rule change never changes the finalized snapshot.
    const { rule } = await getTipRule(database(), scenario.owner);

    await saveTipRule(database(), scenario.owner, {
      name: null,
      active: true,
      positions: [{ positionId: scenario.server, points: "1" }],
      expectedVersion: rule.version,
    });

    const [listed] = await listDistributions(database(), scenario.owner, { from: businessDate, to: businessDate });

    expect(listed!.lines.map((line) => line.share).sort()).toEqual(["2.25", "2.25", "4.50"]);

    const tips = await runReport(database(), scenario.owner, "tips", {
      locationId: scenario.owner.locationId,
      from: businessDate,
      to: businessDate,
    });

    expect(tips.sections.find((candidate) => candidate.key === "byDate")!.rows).toEqual([
      { businessDate, cashTips: "3.00", cardTips: "6.00", tips: "9.00", distributed: "9.00", status: "Finalized" },
    ]);
    expect(tips.sections.find((candidate) => candidate.key === "shares")!.rows.map((row) => row.share).sort()).toEqual([
      "2.25",
      "2.25",
      "4.50",
    ]);
  });

  it("refuses to finalize with an open check or an open time entry", async () => {
    await poolRule();
    await worker(scenario.server, 4);

    // Clocked in now, so on the same business date as the checks.
    const { id: onClock } = await createEmployeeFixture(database(), scenario.owner, { positionId: scenario.server });
    const entry = await clockIn(database(), scenario.owner, { employeeId: onClock, positionId: null, idempotencyKey: key() });

    expect(entry.businessDate).toBe(businessDate);
    await expect(
      finalizeTipDistribution(database(), scenario.owner, { businessDate, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "OPEN_TIME_ENTRIES" });

    await createOrder(database(), scenario.cashier, { orderType: "TAKEOUT" });
    await expect(
      finalizeTipDistribution(database(), scenario.owner, { businessDate, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "OPEN_CHECKS_REMAIN" });
    expect((await previewTipDistribution(database(), scenario.owner, businessDate)).blockers).toEqual({
      openOrders: 1,
      openSettlements: 0,
      openTimeEntries: true,
    });
  });

  it("freezes the date's hours until the distribution is voided, then re-finalizes", async () => {
    await poolRule();
    await worker(scenario.server, 4);

    const { id: other } = await createEmployeeFixture(database(), scenario.owner, { positionId: scenario.server });
    const entryId = await insertClosedEntry(database(), scenario.owner, {
      employeeId: other,
      positionId: scenario.server,
      businessDate,
      clockInAt: new Date(Date.now() - 20 * HOUR),
      clockOutAt: new Date(Date.now() - 16 * HOUR),
    });
    const first = await finalizeTipDistribution(database(), scenario.owner, { businessDate, idempotencyKey: key() });

    await expect(
      adjustEntry(database(), scenario.owner, entryId, {
        expectedVersion: 1,
        reason: "Longer",
        clockOutAt: new Date(Date.now() - 15 * HOUR),
      }),
    ).rejects.toMatchObject({ code: "TIP_DISTRIBUTION_FINALIZED" });
    await expect(
      voidEntry(database(), scenario.owner, entryId, { expectedVersion: 1, reason: "Mistake" }),
    ).rejects.toMatchObject({ code: "TIP_DISTRIBUTION_FINALIZED" });

    await voidDistribution(database(), scenario.owner, first.id, { expectedVersion: 1, reason: "Hours were wrong" });
    await adjustEntry(database(), scenario.owner, entryId, {
      expectedVersion: 1,
      reason: "Longer",
      clockOutAt: new Date(Date.now() - 15 * HOUR),
    });

    const second = await finalizeTipDistribution(database(), scenario.owner, { businessDate, idempotencyKey: key() });
    const rows = await database()
      .select({ id: tipDistributions.id, status: tipDistributions.status })
      .from(tipDistributions)
      .where(eq(tipDistributions.businessDate, businessDate));

    expect(second.id).not.toBe(first.id);
    expect(rows.find((row) => row.id === first.id)!.status).toBe("VOIDED");
    expect(rows.find((row) => row.id === second.id)!.status).toBe("FINALIZED");
    await expect(
      database().delete(tipDistributions).where(eq(tipDistributions.id, first.id)),
    ).rejects.toThrow();
  });

  it("needs an active pool and tips.manage, and shows employees only their own shares", async () => {
    await expect(
      finalizeTipDistribution(database(), scenario.owner, { businessDate, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "TIP_POOL_NOT_CONFIGURED" });

    await poolRule();

    const punchOnly = await actorWith(database(), scenario, ["timeclock.punch"]);
    const employeeId = await worker(scenario.server, 5);

    await database().update(employees).set({ userId: punchOnly.userId }).where(eq(employees.id, employeeId));
    await worker(scenario.server, 5);
    await expect(previewTipDistribution(database(), punchOnly, businessDate)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      finalizeTipDistribution(database(), punchOnly, { businessDate, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(listDistributions(database(), punchOnly, { from: businessDate, to: businessDate })).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    await finalizeTipDistribution(database(), scenario.owner, { businessDate, idempotencyKey: key() });

    expect(await getMyTipShares(database(), punchOnly, { from: businessDate, to: businessDate })).toEqual([
      { businessDate, positionCode: "SERVER", workedHours: "5.0000", share: "4.50" },
    ]);
  });
});
