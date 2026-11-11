import { randomUUID } from "node:crypto";

import { EntityForm } from "@/components/forms/entity-form";
import { formatMoney } from "@/components/format/money";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/settlements/services/access";
import { getDrawerSetting, listDrawers, listDrawerSessions } from "@/modules/settlements/services/drawer-service";

/**
 * Cash drawers (Phase 17 policy E). Record only: open a drawer with a float, record
 * paid-ins and paid-outs, then count it at close to see the variance. Cash tenders and cash
 * refunds are recorded into an open drawer from the settlement screen.
 *
 * Each retryable command carries an idempotency key generated for this render: resubmitting
 * after a lost response reuses it, and the refresh after success brings a new one.
 */
export default async function CashDrawersPage() {
  const { actor, location } = await requirePageActor("drawers.view");
  const database = getDatabase();
  const [setting, drawers, sessions] = await Promise.all([
    getDrawerSetting(database, actor),
    listDrawers(database, actor),
    listDrawerSessions(database, actor, { limit: 30 }),
  ]);
  const canOperate = actorHolds(actor, "drawers.operate");
  const canManage = actorHolds(actor, "drawers.manage");
  const openSessions = sessions.filter((session) => session.status === "OPEN");
  const closedSessions = sessions.filter((session) => session.status === "CLOSED");

  return (
    <>
      <PageHeader
        title="Cash drawers"
        description={`Drawers at ${location.locationName}. ${
          setting.required ? "Cash here must go into an open drawer." : "Cash here may be recorded without a drawer."
        }`}
      />

      <div className="grid gap-6">
        {openSessions.length === 0 ? (
          <EmptyState title="No drawer is open">
            {canOperate ? "Open a drawer below with its starting float." : "Ask a manager to open a drawer."}
          </EmptyState>
        ) : (
          openSessions.map((session) => (
            <Card key={session.id} aria-label={`Open drawer ${session.drawerCode}`}>
              <CardTitle>
                {session.drawerName} ({session.drawerCode}) · session {session.sessionNumber} <Badge tone="success">Open</Badge>
              </CardTitle>
              <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                <dt>Float</dt>
                <dd className="tabular">{formatMoney(session.totals.openingFloat)}</dd>
                <dt>Cash taken</dt>
                <dd className="tabular">{formatMoney(session.totals.cashSales)}</dd>
                <dt>Cash tips</dt>
                <dd className="tabular">{formatMoney(session.totals.cashTips)}</dd>
                <dt>Paid in</dt>
                <dd className="tabular">{formatMoney(session.totals.paidIn)}</dd>
                <dt>Paid out</dt>
                <dd className="tabular">{formatMoney(session.totals.paidOut)}</dd>
                <dt>Cash refunds</dt>
                <dd className="tabular">{formatMoney(session.totals.cashRefunds)}</dd>
                <dt className="font-semibold">Expected now</dt>
                <dd aria-label="Expected cash" className="tabular font-semibold">
                  {formatMoney(session.totals.expected)}
                </dd>
              </dl>
              {canOperate && (
                <div className="grid gap-6 md:grid-cols-2">
                  <section aria-label="Paid in or out" className="grid gap-2">
                    <h3 className="font-semibold">Paid in or out</h3>
                    <EntityForm
                      key={`movement-${session.id}-${session.version}-${session.totals.expected}`}
                      method="POST"
                      url={`/api/drawer-sessions/${session.id}/movements`}
                      submitLabel="Record"
                      successMessage="Recorded."
                      hidden={{ idempotencyKey: `movement-${randomUUID()}` }}
                      fields={[
                        {
                          name: "movementType",
                          label: "Type",
                          type: "select",
                          required: true,
                          options: [
                            { value: "PAID_OUT", label: "Paid out" },
                            { value: "PAID_IN", label: "Paid in" },
                          ],
                        },
                        { name: "amount", label: "Amount", required: true },
                        { name: "reason", label: "Reason", required: true },
                      ]}
                    />
                  </section>
                  <section aria-label="Close drawer" className="grid gap-2">
                    <h3 className="font-semibold">Count and close</h3>
                    <EntityForm
                      key={`close-${session.id}-${session.version}`}
                      method="POST"
                      url={`/api/drawer-sessions/${session.id}/close`}
                      submitLabel="Close drawer"
                      successMessage="Drawer closed."
                      hidden={{ expectedVersion: session.version, idempotencyKey: `close-${randomUUID()}` }}
                      fields={[
                        { name: "countedAmount", label: "Cash counted", required: true },
                        { name: "closeNote", label: "Note (optional)" },
                      ]}
                    />
                  </section>
                </div>
              )}
            </Card>
          ))
        )}

        <Card aria-label="Drawers">
          <CardTitle>Drawers</CardTitle>
          {drawers.length === 0 ? (
            <p className="text-sm text-neutral-700">No drawers are set up here yet.</p>
          ) : (
            <ul className="grid gap-4">
              {drawers.map((drawer) => (
                <li key={drawer.id} className="grid gap-2 border-t border-neutral-200 pt-3">
                  <p className="font-medium">
                    {drawer.name} ({drawer.code}){drawer.active ? "" : " · inactive"}
                    {drawer.openSession ? ` · open (session ${drawer.openSession.sessionNumber})` : ""}
                  </p>
                  {canOperate && drawer.active && !drawer.openSession && (
                    <EntityForm
                      key={`open-${drawer.id}`}
                      method="POST"
                      url={`/api/drawers/${drawer.id}/sessions`}
                      submitLabel={`Open ${drawer.name}`}
                      successMessage="Drawer opened."
                      hidden={{ idempotencyKey: `open-${randomUUID()}` }}
                      fields={[{ name: "openingFloat", label: "Starting float", required: true, defaultValue: "100.00" }]}
                    />
                  )}
                  {canManage && (
                    <details>
                      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Edit drawer</summary>
                      <EntityForm
                        key={`drawer-${drawer.id}-${drawer.version}`}
                        method="PATCH"
                        url={`/api/drawers/${drawer.id}`}
                        submitLabel="Save drawer"
                        hidden={{ expectedVersion: drawer.version }}
                        fields={[
                          { name: "name", label: "Name", required: true, defaultValue: drawer.name },
                          { name: "active", label: "Active", type: "checkbox", defaultValue: drawer.active },
                        ]}
                      />
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {canManage && (
          <div className="grid gap-6 md:grid-cols-2">
            <Card aria-label="Add a drawer">
              <CardTitle>Add a drawer</CardTitle>
              <EntityForm
                method="POST"
                url="/api/drawers"
                submitLabel="Add drawer"
                resetOnSuccess
                successMessage="Drawer added."
                fields={[
                  { name: "code", label: "Code (capitals, digits, _)", required: true },
                  { name: "name", label: "Name", required: true },
                ]}
              />
            </Card>
            <Card aria-label="Drawer requirement">
              <CardTitle>Drawer requirement</CardTitle>
              <EntityForm
                key={`setting-${setting.version}`}
                method="PATCH"
                url="/api/drawers/setting"
                submitLabel="Save"
                successMessage="Saved."
                hidden={{ expectedVersion: setting.version }}
                fields={[
                  { name: "required", label: "Cash must go into an open drawer", type: "checkbox", defaultValue: setting.required },
                ]}
              />
            </Card>
          </div>
        )}

        {closedSessions.length > 0 && (
          <Card aria-label="Closed drawers">
            <CardTitle>Recently closed</CardTitle>
            <TableFrame>
              <Table>
                <THead>
                  <Tr>
                    <Th>Drawer</Th>
                    <Th>Business date</Th>
                    <Th numeric>Expected</Th>
                    <Th numeric>Counted</Th>
                    <Th numeric>Variance</Th>
                  </Tr>
                </THead>
                <TBody>
                  {closedSessions.map((session) => (
                    <Tr key={session.id}>
                      <Td>
                        {session.drawerCode} · {session.sessionNumber}
                      </Td>
                      <Td>{session.businessDate}</Td>
                      <Td numeric>{formatMoney(session.expectedAmount ?? "0.00")}</Td>
                      <Td numeric>{formatMoney(session.countedAmount ?? "0.00")}</Td>
                      <Td numeric data-testid="drawer-variance">
                        {formatMoney(session.variance ?? "0.00")}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          </Card>
        )}
      </div>
    </>
  );
}
