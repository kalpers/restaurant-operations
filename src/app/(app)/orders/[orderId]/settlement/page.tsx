import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { SettlementWorkspace } from "@/components/settlements/settlement-workspace";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getOrderSettlementView } from "@/modules/settlements/queries/settlement-queries";
import { actorHolds } from "@/modules/settlements/services/access";
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
  };

  return (
    <>
      {abilities.viewOrder && (
        <p className="mb-3">
          <Link href={`/orders/${view.order.id}`} className="text-sm underline">
            Back to order
          </Link>
        </p>
      )}
      <SettlementWorkspace view={view} abilities={abilities} />
    </>
  );
}
