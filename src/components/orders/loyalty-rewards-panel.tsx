"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { Button } from "@/components/ui/button";
import { INPUT_STYLE } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

import { callOrderApi, formatMoney } from "./order-api";
import type { OrderDetail } from "@/modules/orders/queries/order-queries";
import { randomUuid } from "@/shared/random-uuid";

/** Phase 30 (policy 15): the linked guest's points and the rewards they can afford. */
export type LoyaltyPanelData = {
  profileName: string;
  balance: number;
  available: number;
  canRedeem: boolean;
  rewards: { id: string; name: string; pointsCost: number; scope: string; discountType: string; value: string }[];
};

export function LoyaltyRewardsPanel({ order, loyalty }: { order: OrderDetail; loyalty: LoyaltyPanelData }) {
  const router = useRouter();
  const toast = useToast();
  const affordable = loyalty.rewards.filter((reward) => reward.pointsCost <= loyalty.available);
  const [rewardId, setRewardId] = useState(affordable[0]?.id ?? "");
  const [itemId, setItemId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string } | null>(null);
  const key = useRef<string | null>(null);
  const chosen = affordable.find((reward) => reward.id === rewardId) ?? null;
  const sentItems = order.items.filter((item) => item.status === "SUBMITTED");
  const open = order.status === "OPEN";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (!chosen) {
      return;
    }

    key.current ??= `loyalty-${randomUuid()}`;
    setPending(true);
    setError(null);

    const result = await callOrderApi(
      "POST",
      `/api/orders/${order.id}/loyalty-rewards`,
      {
        rewardId: chosen.id,
        expectedVersion: order.version,
        ...(chosen.scope === "ITEM" ? { orderItemId: itemId } : {}),
      },
      { "Idempotency-Key": key.current },
    );

    setPending(false);

    if (result.ok || (result.status >= 400 && result.status < 500)) {
      key.current = null;
    }

    if (result.ok) {
      toast.success(`${chosen.name} applied. The points leave when the check closes.`);
      router.refresh();
    } else {
      setError({ code: result.code, message: result.message, requestId: result.requestId });
    }
  }

  return (
    <section aria-label="Loyalty" className="grid gap-2 rounded-md border border-neutral-200 p-3">
      <h2 className="font-semibold">Loyalty</h2>
      <p className="text-sm">
        {loyalty.profileName}: <span data-testid="order-loyalty-available">{loyalty.available}</span> points available
        {loyalty.available !== loyalty.balance ? ` (${loyalty.balance} with rewards on open checks)` : ""}.
      </p>
      {open && loyalty.canRedeem && (
        affordable.length === 0 ? (
          <p className="text-sm text-neutral-600">No reward is within this guest&apos;s points yet.</p>
        ) : (
          <form onSubmit={handleSubmit} aria-label="Redeem a reward" className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="grid gap-1 text-sm font-medium">
              Reward
              <select value={rewardId} onChange={(event) => setRewardId(event.target.value)} className={INPUT_STYLE}>
                {affordable.map((reward) => (
                  <option key={reward.id} value={reward.id}>
                    {reward.name} · {reward.pointsCost} pts ·{" "}
                    {reward.discountType === "PERCENTAGE" ? `${reward.value}%` : formatMoney(reward.value)} off
                  </option>
                ))}
              </select>
            </label>
            {chosen?.scope === "ITEM" ? (
              <label className="grid gap-1 text-sm font-medium">
                Item
                <select value={itemId} onChange={(event) => setItemId(event.target.value)} className={INPUT_STYLE} required>
                  <option value="">Choose a sent item</option>
                  {sentItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={pending || !chosen || (chosen.scope === "ITEM" && itemId === "")}>
              Redeem
            </Button>
          </form>
        )
      )}
      {error && <ApiErrorMessage error={error} />}
    </section>
  );
}
