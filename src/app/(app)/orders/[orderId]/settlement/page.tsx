import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { SettlementWorkspace } from "@/components/settlements/settlement-workspace";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getOrderSettlementView } from "@/modules/settlements/queries/settlement-queries";
import { actorHolds } from "@/modules/settlements/services/access";
import { getDrawerSetting, listOpenSessionsForCash } from "@/modules/settlements/services/drawer-service";
import { listRefundsForOrder } from "@/modules/settlements/services/refund-service";
import { TENDER_PERMISSIONS, TENDER_TYPES } from "@/modules/settlements/types";
import { NotFoundError } from "@/shared/errors/app-error";

export default async function SettlementPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { actor } = await requirePageActor("settlements.view");
  const parsed = z.uuid().safeParse((await params).orderId);

  if (!parsed.success) {
    notFound();
  }

  const view = await getOrderSettlementView(getDatabase(), actor, parsed.data).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });

  // Hidden controls are convenience only: every API checks these permissions itself.
  const abilities = {
    open: actorHolds(actor, "settlements.create"),
    cancel: actorHolds(actor, "settlements.create"),
    complete: actorHolds(actor, "settlements.complete"),
    voidTender: actorHolds(actor, "settlements.void-tender"),
    tenderTypes: TENDER_TYPES.filter((type) => actorHolds(actor, TENDER_PERMISSIONS[type])),
    viewOrder: actorHolds(actor, "orders.view"),
    refund: actorHolds(actor, "settlements.refund"),
    voidRefund: actorHolds(actor, "settlements.refund-void"),
  };
  // Phase 17: open drawers for cash, whether one is required, and refunds on a closed check.
  const database = getDatabase();
  const canSeeDrawers = actorHolds(actor, "drawers.view");
  const drawers = canSeeDrawers
    ? (await listOpenSessionsForCash(database, actor)).map((entry) => ({
        id: entry.id,
        label: `${entry.name} (${entry.code} · session ${entry.sessionNumber})`,
      }))
    : [];
  const drawerRequired = canSeeDrawers ? (await getDrawerSetting(database, actor)).required : false;
  const refunds = view.order.status === "CLOSED" ? await listRefundsForOrder(database, actor, view.order.id) : [];

  return (
    <>
      {abilities.viewOrder && (
        <p className="mb-3">
          <Link href={`/orders/${view.order.id}`} className="text-sm underline">
            Back to order
          </Link>
        </p>
      )}
      <SettlementWorkspace
        view={view}
        abilities={abilities}
        drawers={drawers}
        drawerRequired={drawerRequired}
        refunds={refunds}
      />
    </>
  );
}
