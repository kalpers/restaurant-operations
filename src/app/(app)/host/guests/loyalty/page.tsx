import Link from "next/link";

import { EntityForm } from "@/components/forms/entity-form";
import { formatMoney } from "@/components/orders/order-api";
import { Badge } from "@/components/ui/badge";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getLoyaltyProgram, listLoyaltyRewards } from "@/modules/reservations/services/loyalty-service";

/** Phase 30 (policies 5, 7; amendment 2): the loyalty program and its rewards. */
export default async function LoyaltyPage() {
  const { actor } = await requirePageActor("loyalty.manage");
  const database = getDatabase();
  const [program, rewards] = await Promise.all([
    getLoyaltyProgram(database, actor),
    listLoyaltyRewards(database, actor, { includeInactive: true }),
  ]);

  return (
    <>
      <p className="mb-2">
        <Link href="/host/guests" className="text-sm underline">
          Back to guests
        </Link>
      </p>
      <h1 className="mb-2 flex flex-wrap items-center gap-2 text-2xl font-semibold">
        Loyalty
        <Badge tone={program.enabled ? "success" : "neutral"}>{program.enabled ? "On" : "Off"}</Badge>
      </h1>
      <p className="mb-6 max-w-3xl text-neutral-600">
        A guest linked to a visit earns points when the table session ends, from the closed checks&apos; subtotals
        after discounts and before tax. Rate changes apply to visits that finish afterwards; nothing earned is
        recalculated. Takeout and tabs with no guest party don&apos;t earn. There are no messages to guests about points.
      </p>

      <section aria-label="Program" className="mb-8 max-w-xl rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm">
        <h2 className="mb-3 text-xl font-semibold">Program</h2>
        <EntityForm
          method="PUT"
          url="/api/loyalty/program"
          submitLabel="Save program"
          hidden={{ expectedVersion: program.version }}
          fields={[
            { name: "enabled", label: "Guests earn and redeem points", type: "checkbox", defaultValue: program.enabled },
            {
              name: "pointsPerDollar",
              label: "Points per $1 of subtotal (0 to 100)",
              type: "number",
              required: true,
              defaultValue: program.pointsPerDollar,
            },
            {
              name: "pointsPerVisit",
              label: "Points per visit (0 to 100)",
              type: "number",
              required: true,
              defaultValue: program.pointsPerVisit,
            },
          ]}
        />
      </section>

      <section aria-label="New reward" className="mb-8 max-w-xl">
        <h2 className="mb-1 text-xl font-semibold">New reward</h2>
        <p className="mb-3 text-sm text-neutral-600">
          A reward is applied to a check as its own discount, so tax and settlement work as usual.
        </p>
        <EntityForm
          method="POST"
          url="/api/loyalty/rewards"
          submitLabel="Create reward"
          successMessage="Reward created."
          resetOnSuccess
          fields={[
            { name: "name", label: "Name", required: true },
            { name: "pointsCost", label: "Points it costs", type: "number", required: true },
            {
              name: "scope",
              label: "Applies to",
              type: "select",
              options: [
                { value: "ITEM", label: "One item" },
                { value: "ORDER", label: "Whole check" },
              ],
            },
            {
              name: "discountType",
              label: "Type",
              type: "select",
              options: [
                { value: "PERCENTAGE", label: "Percentage" },
                { value: "FIXED_AMOUNT", label: "Fixed amount" },
              ],
            },
            { name: "value", label: "Value (percent or dollars; 100% is free)", required: true },
          ]}
        />
      </section>

      <section aria-label="Rewards">
        <h2 className="mb-3 text-xl font-semibold">Rewards</h2>
        {rewards.length === 0 && <p className="text-neutral-600">No rewards yet.</p>}
        <ul className="grid gap-4">
          {rewards.map((reward) => (
            <li key={reward.id} aria-label={`Reward ${reward.name}`} className="rounded-md border border-neutral-300 p-4">
              <p className="font-medium">
                {reward.name} · {reward.pointsCost} points · {reward.scope === "ITEM" ? "one item" : "whole check"} ·{" "}
                {reward.discountType === "PERCENTAGE" ? `${reward.value}%` : formatMoney(reward.value)} off
                {reward.active ? "" : " · inactive"}
              </p>
              <p className="mb-2 text-sm text-neutral-600">Reward #{reward.rewardNumber}</p>
              <details>
                <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Edit</summary>
                <EntityForm
                  method="PATCH"
                  url={`/api/loyalty/rewards/${reward.id}`}
                  submitLabel="Save reward"
                  hidden={{ expectedVersion: reward.version }}
                  fields={[
                    { name: "name", label: "Name", required: true, defaultValue: reward.name },
                    { name: "pointsCost", label: "Points it costs", type: "number", required: true, defaultValue: reward.pointsCost },
                    { name: "value", label: "Value", required: true, defaultValue: reward.value },
                    { name: "active", label: "Active", type: "checkbox", defaultValue: reward.active },
                  ]}
                />
              </details>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
