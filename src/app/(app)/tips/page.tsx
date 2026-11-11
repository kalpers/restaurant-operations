import { randomUUID } from "node:crypto";

import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { formatMoney } from "@/components/format/money";
import { TipRuleForm } from "@/components/timeclock/tip-rule-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { loadClockSettings } from "@/modules/scheduling/services/timeclock-service";
import { getTipRule, listDistributions } from "@/modules/settlements/services/tip-service";
import { businessDateOf } from "@/shared/time/business-date-service";
import { addDays } from "@/shared/time/zoned-time";
import { previewTipDistribution } from "@/workflows/finalize-tip-distribution/finalize-tip-distribution";

/**
 * Tip pools (Phase 18 policies D23-D25). Record only: a finalized distribution says how a
 * business date's tips are shared by hours × position points; nothing is paid out here.
 */
export default async function TipsPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { actor, location } = await requirePageActor("tips.manage");
  const database = getDatabase();
  const { date: requested } = await searchParams;
  const today = businessDateOf(new Date(), await loadClockSettings(database, actor));
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : today;
  const [{ rule, positions }, preview, history] = await Promise.all([
    getTipRule(database, actor),
    previewTipDistribution(database, actor, date),
    listDistributions(database, actor, { from: addDays(today, -30), to: today }),
  ]);
  const blocked =
    preview.blockers.openOrders > 0 || preview.blockers.openSettlements > 0 || preview.blockers.openTimeEntries;

  return (
    <>
      <PageHeader
        title="Tips"
        description={`Tip pool at ${location.locationName}. Shares are hours worked × position points. Record only: payouts happen outside this system.`}
      />

      <div className="grid gap-6">
        <Card aria-label="Distribute tips">
          <CardTitle>
            Tips for {date}{" "}
            {preview.finalized ? <Badge tone="success">Finalized</Badge> : <Badge tone="warning">Not distributed</Badge>}
          </CardTitle>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              Business date
              <input type="date" name="date" defaultValue={date} className="min-h-11 rounded border border-neutral-300 px-3" />
            </label>
            <button type="submit" className="min-h-11 rounded border border-neutral-300 px-4 text-sm font-medium">
              Show
            </button>
          </form>
          <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <dt>Cash tips</dt>
            <dd className="tabular">{formatMoney(preview.totals.cashTips)}</dd>
            <dt>Card tips</dt>
            <dd className="tabular">{formatMoney(preview.totals.cardTips)}</dd>
            <dt className="font-semibold">Pool</dt>
            <dd aria-label="Tip pool" className="tabular font-semibold">
              {formatMoney(preview.totals.poolTotal)}
            </dd>
            <dt>Weighted hours</dt>
            <dd className="tabular">{preview.totalWeightedHours}</dd>
          </dl>
          {!preview.rule.active && <p className="mb-3 text-sm">Set up the tip pool below before distributing tips.</p>}
          {blocked && (
            <p className="mb-3 text-sm" role="status">
              Can&apos;t finalize yet:
              {preview.blockers.openOrders > 0 ? ` ${preview.blockers.openOrders} open check(s);` : ""}
              {preview.blockers.openSettlements > 0 ? ` ${preview.blockers.openSettlements} open settlement(s);` : ""}
              {preview.blockers.openTimeEntries ? " someone is still on the clock;" : ""} close them first.
            </p>
          )}
          {preview.lines.length === 0 ? (
            <p className="text-sm text-neutral-700">Nobody in a pooled position has closed time on this date.</p>
          ) : (
            <TableFrame>
              <Table>
                <THead>
                  <Tr>
                    <Th>Employee</Th>
                    <Th>Position</Th>
                    <Th numeric>Hours</Th>
                    <Th numeric>Points</Th>
                    <Th numeric>Share</Th>
                  </Tr>
                </THead>
                <TBody>
                  {preview.lines.map((line) => (
                    <Tr key={`${line.employeeId}-${line.positionId}`}>
                      <Td>
                        {line.employeeName} ({line.employeeNumber})
                      </Td>
                      <Td>{line.positionCode}</Td>
                      <Td numeric>{line.workedHours}</Td>
                      <Td numeric>{line.points}</Td>
                      <Td numeric data-testid="tip-share">
                        {formatMoney(line.share)}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
          <div className="mt-4">
            {preview.finalized ? (
              <EntityForm
                key={`void-${preview.finalized.id}-${preview.finalized.version}`}
                method="POST"
                url={`/api/tips/distributions/${preview.finalized.id}/void`}
                submitLabel="Void distribution"
                successMessage="Distribution voided."
                hidden={{ expectedVersion: preview.finalized.version }}
                fields={[{ name: "reason", label: "Why void it?", required: true }]}
              />
            ) : (
              preview.rule.active &&
              !blocked && (
                <ActionButton
                  method="POST"
                  url="/api/tips/distributions"
                  body={{ businessDate: date, idempotencyKey: `tips-${randomUUID()}` }}
                  label="Finalize tips"
                  variant="primary"
                  successMessage="Tips finalized."
                  confirm={{
                    title: `Finalize tips for ${date}?`,
                    body: "The shares are saved as they are now. Hours on this date can't change until it's voided.",
                    confirmLabel: "Finalize",
                  }}
                />
              )
            )}
          </div>
        </Card>

        <Card aria-label="Tip pool setup">
          <CardTitle>Tip pool</CardTitle>
          <TipRuleForm
            key={`rule-${rule.version ?? 0}`}
            rule={{
              active: rule.active,
              name: rule.name,
              version: rule.version,
              positions: rule.positions.map((position) => ({ positionId: position.positionId, points: position.points })),
            }}
            positions={positions}
          />
        </Card>

        <Card aria-label="Distribution history">
          <CardTitle>Last 30 days</CardTitle>
          {history.length === 0 ? (
            <p className="text-sm text-neutral-700">No distributions yet.</p>
          ) : (
            <TableFrame>
              <Table>
                <THead>
                  <Tr>
                    <Th>Business date</Th>
                    <Th>Status</Th>
                    <Th numeric>Pool</Th>
                    <Th numeric>People</Th>
                  </Tr>
                </THead>
                <TBody>
                  {history.map((row) => (
                    <Tr key={row.id}>
                      <Td>{row.businessDate}</Td>
                      <Td>
                        {row.status === "FINALIZED" ? "Finalized" : `Voided: ${row.voidReason ?? ""}`}
                      </Td>
                      <Td numeric>{formatMoney(row.poolTotal)}</Td>
                      <Td numeric>{new Set(row.lines.map((line) => line.employeeId)).size}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Card>
      </div>
    </>
  );
}
