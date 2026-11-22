import { GiftCardWorkspace } from "@/components/settlements/gift-card-workspace";
import { formatMoney } from "@/components/format/money";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/settlements/services/access";
import { getDrawerSetting, listOpenSessionsForCash } from "@/modules/settlements/services/drawer-service";
import { getGiftCardProgram, listGiftCards } from "@/modules/settlements/services/gift-card-service";
import { listStockBatches } from "@/modules/settlements/services/gift-card-stock-service";
import { TENDER_PERMISSIONS } from "@/modules/settlements/types";

/**
 * Phase 31 gift cards (policies 4, 5, 12, 17; amendment 5). The restaurant's own cards:
 * sell and reload, look up a balance, and for managers the settings, sale voids, cash-outs,
 * adjustments, status and code replacement. Record only. Hidden controls are convenience:
 * every API checks its own permissions.
 */
export default async function GiftCardsPage() {
  const { actor } = await requirePageActor("gift-cards.view");
  const database = getDatabase();
  const program = await getGiftCardProgram(database, actor);
  const manage = actorHolds(actor, "gift-cards.manage");
  const canSeeDrawers = actorHolds(actor, "drawers.view");
  const [drawers, drawerSetting, recent, stockBatches] = await Promise.all([
    canSeeDrawers ? listOpenSessionsForCash(database, actor) : Promise.resolve([]),
    canSeeDrawers ? getDrawerSetting(database, actor) : Promise.resolve({ required: false }),
    manage ? listGiftCards(database, actor, 20) : Promise.resolve([]),
    manage ? listStockBatches(database, actor) : Promise.resolve([]),
  ]);
  const abilities = {
    sell: actorHolds(actor, "gift-cards.sell"),
    manage,
    purchaserView: actorHolds(actor, "gift-cards.purchaser.view"),
    saleTenders: (["CASH", "EXTERNAL_CARD", "OTHER"] as const).filter((type) => actorHolds(actor, TENDER_PERMISSIONS[type])),
  };

  return (
    <>
      <PageHeader
        title="Gift cards"
        description="The restaurant's own gift cards, usable at every location. Selling a card records how the guest paid; it isn't a sale and carries no tax or tip."
        actions={<Badge tone={program.enabled ? "success" : "neutral"}>{program.enabled ? "On" : "Off"}</Badge>}
      />
      {manage && (
        <p className="mb-4 text-sm text-neutral-700">
          Outstanding on all cards: <span className="tabular font-semibold">{formatMoney(program.outstandingBalance)}</span> on{" "}
          {program.cardsWithBalance} card{program.cardsWithBalance === 1 ? "" : "s"}.
        </p>
      )}
      {!program.enabled && (
        <p className="mb-4 rounded-md border border-neutral-200 bg-surface p-3 text-sm">
          Gift cards are off. Gift card tenders are recorded as before, with no balance.{" "}
          {manage ? "Turn them on under Settings." : "A manager can turn them on."}
        </p>
      )}
      <GiftCardWorkspace
        program={program}
        abilities={abilities}
        drawers={drawers.map((entry) => ({ id: entry.id, label: `${entry.name} (${entry.code} · session ${entry.sessionNumber})` }))}
        drawerRequired={drawerSetting.required}
        recent={recent}
        stockBatches={stockBatches}
      />
    </>
  );
}
