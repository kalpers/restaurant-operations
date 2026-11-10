"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { Banknote, CreditCard } from "lucide-react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { StatusBadge } from "@/components/format/status-badge";
import { callOrderApi, formatMoney, ORDER_TYPE_LABELS } from "@/components/orders/order-api";
import { useRealtimeRefresh } from "@/components/realtime/realtime-provider";
import { buttonClass } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { INPUT_STYLE } from "@/components/ui/field";
import type {
  OrderSettlementView,
  SettlementDetail,
  TenderDetail,
} from "@/modules/settlements/queries/settlement-queries";
import { previewChange } from "@/modules/settlements/rules/settlement-math";
import type { TenderType } from "@/modules/settlements/types";

// The settlement screen. Record only: nothing here charges a card or talks to a payment
// provider. It shows what the server returns; the server decides every amount, the
// remaining balance, change and permissions. The order amount is pre-tax (tax isn't
// calculated in this version).

export type SettlementAbilities = {
  open: boolean;
  cancel: boolean;
  complete: boolean;
  voidTender: boolean;
  tenderTypes: TenderType[];
  viewOrder: boolean;
};

const BUTTON = buttonClass("secondary");
const PRIMARY = buttonClass("primary", "lg");
const INPUT = INPUT_STYLE;
const LABEL = "grid gap-1 text-sm font-medium text-neutral-800";

const TENDER_LABELS: Record<TenderType, string> = {
  CASH: "Cash",
  EXTERNAL_CARD: "Card (external terminal)",
  GIFT_CARD: "Gift card",
  HOUSE_ACCOUNT: "House account",
  OTHER: "Other",
};

const EVENTS = [
  "settlement.opened",
  "settlement.tender-recorded",
  "settlement.tender-voided",
  "settlement.completed",
  "settlement.cancelled",
  "order.closed",
];

function newKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string } | null>(null);

  async function run(url: string, body?: unknown, headers?: Record<string, string>) {
    setPending(true);
    setError(null);

    const result = await callOrderApi("POST", url, body, headers);

    setPending(false);

    if (result.ok) {
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result);
    }

    return result;
  }

  return { run, pending, error };
}

function ErrorText({ error }: { error: { code: string; message: string; requestId?: string } | null }) {
  return <ApiErrorMessage error={error} className="flex" />;
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className={`flex justify-between gap-2 ${strong ? "text-lg font-semibold" : ""}`}>
      <span>{label}</span>
      <span aria-label={label} className="tabular">
        {value}
      </span>
    </p>
  );
}

function TenderLine({
  settlement,
  tender,
  canVoid,
}: {
  settlement: SettlementDetail;
  tender: TenderDetail;
  canVoid: boolean;
}) {
  const { run, pending, error } = useAction();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const reference = tender.reference;

  async function submit(event: FormEvent) {
    event.preventDefault();

    const result = await run(`/api/settlements/${settlement.id}/tenders/${tender.id}/void`, {
      expectedVersion: settlement.version,
      reason,
    });

    if (result.ok) {
      setVoiding(false);
    }
  }

  return (
    <li className="grid gap-1 rounded-md border border-neutral-200 bg-surface p-3" data-testid="tender">
      <p className="flex justify-between gap-2">
        <span className={tender.status === "RECORDED" ? "font-medium" : "font-medium line-through"}>
          {TENDER_LABELS[tender.tenderType]}
        </span>
        <span className="tabular">{formatMoney(tender.amount)}</span>
      </p>
      <p className="flex flex-wrap items-center gap-2 text-xs text-neutral-700">
        <StatusBadge domain="tender" status={tender.status} />
        {tender.status === "FAILED" ? " · counts $0.00" : ""}
        {tender.status === "VOIDED" ? " · record corrected, nothing reversed externally" : ""}
      </p>
      {tender.tipAmount !== "0.00" && <p className="text-sm">Tip {formatMoney(tender.tipAmount)}</p>}
      {tender.receivedAmount && (
        <p className="text-sm">
          Received {formatMoney(tender.receivedAmount)} · Change {formatMoney(tender.changeAmount)}
        </p>
      )}
      {tender.otherDescription && <p className="text-sm">{tender.otherDescription}</p>}
      {tender.failureReason && <p className="text-sm">Failed: {tender.failureReason}</p>}
      {reference && (
        <p className="text-sm text-neutral-700">
          {[
            reference.providerName,
            reference.cardBrand,
            reference.cardLastFour ? `•••• ${reference.cardLastFour}` : null,
            reference.authorizationReference ? `Auth ${reference.authorizationReference}` : null,
            reference.externalReference ? `Ref ${reference.externalReference}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {tender.voidReason && <p className="text-sm">Voided: {tender.voidReason}</p>}
      {canVoid && tender.status === "RECORDED" && !voiding && (
        <button type="button" className={BUTTON} onClick={() => setVoiding(true)}>
          Void tender
        </button>
      )}
      {voiding && (
        <form onSubmit={submit} className="grid gap-2">
          <label className={LABEL}>
            Reason for voiding
            <input className={INPUT} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={300} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={BUTTON} disabled={pending || !reason.trim()}>
              Confirm void
            </button>
            <button type="button" className={BUTTON} onClick={() => setVoiding(false)}>
              Keep
            </button>
          </div>
          <ErrorText error={error} />
        </form>
      )}
    </li>
  );
}

function TenderForm({ settlement, tenderTypes }: { settlement: SettlementDetail; tenderTypes: TenderType[] }) {
  const { run, pending, error } = useAction();
  const [tenderType, setTenderType] = useState<TenderType>(tenderTypes[0]!);
  const [amount, setAmount] = useState(settlement.remainingAmount);
  const [tip, setTip] = useState("");
  const [received, setReceived] = useState("");
  const [failed, setFailed] = useState(false);
  const [failureReason, setFailureReason] = useState("");
  const [providerName, setProviderName] = useState("");
  const [cardBrand, setCardBrand] = useState("");
  const [cardLastFour, setCardLastFour] = useState("");
  const [authorizationReference, setAuthorizationReference] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [otherDescription, setOtherDescription] = useState("");
  // One key per attempt: a retry after a lost response reuses it, so nothing is recorded twice.
  const key = useRef<string | null>(null);
  const isCash = tenderType === "CASH";
  const isCard = tenderType === "EXTERNAL_CARD";
  const tippable = isCash || isCard;
  const change = isCash && received ? previewChange(amount, tip || "0", received) : null;

  const quick = (["CASH", "EXTERNAL_CARD"] as const).filter((type) => tenderTypes.includes(type));

  function exact(type: TenderType) {
    key.current = null;
    setTenderType(type);
    setAmount(settlement.remainingAmount);
    setFailed(false);
    setReceived(type === "CASH" ? settlement.remainingAmount : "");
  }

  function edited<T>(setter: (value: T) => void) {
    return (value: T) => {
      key.current = null;
      setter(value);
    };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    key.current ??= newKey("tender");

    const result = await run(
      `/api/settlements/${settlement.id}/tenders`,
      {
        expectedVersion: settlement.version,
        tenderType,
        outcome: isCard && failed ? "FAILED" : "RECORDED",
        amount,
        tipAmount: tippable && tip ? tip : null,
        receivedAmount: isCash ? received : null,
        providerName: isCard ? providerName : null,
        cardBrand: isCard ? cardBrand : null,
        cardLastFour: isCard ? cardLastFour : null,
        authorizationReference: isCard ? authorizationReference : null,
        externalReference: isCash ? null : externalReference,
        otherDescription: tenderType === "OTHER" ? otherDescription : null,
        failureReason: isCard && failed ? failureReason : null,
      },
      { "Idempotency-Key": key.current },
    );

    if (result.ok) {
      key.current = null;
      setTip("");
      setReceived("");
      setFailed(false);
      setFailureReason("");
      setProviderName("");
      setCardBrand("");
      setCardLastFour("");
      setAuthorizationReference("");
      setExternalReference("");
      setOtherDescription("");
      setAmount((result.data as { remainingAmount: string }).remainingAmount);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Record tender" className="grid gap-3 rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm">
      <h3 className="font-semibold">Record a tender</h3>
      {quick.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick fill">
          {quick.map((type) => {
            const Icon = type === "CASH" ? Banknote : CreditCard;

            return (
              <button key={type} type="button" className={BUTTON} onClick={() => exact(type)}>
                <Icon aria-hidden className="size-4" />
                {type === "CASH" ? "Cash" : "Card"} – exact {formatMoney(settlement.remainingAmount)}
              </button>
            );
          })}
        </div>
      )}
      <label className={LABEL}>
        Tender type
        <select className={INPUT} value={tenderType} onChange={(event) => edited(setTenderType)(event.target.value as TenderType)}>
          {tenderTypes.map((type) => (
            <option key={type} value={type}>
              {TENDER_LABELS[type]}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        Amount applied to the order
        <input className={INPUT} inputMode="decimal" value={amount} onChange={(event) => edited(setAmount)(event.target.value)} required />
      </label>
      {tippable && !failed && (
        <label className={LABEL}>
          Tip (separate from the order)
          <input className={INPUT} inputMode="decimal" value={tip} placeholder="0.00" onChange={(event) => edited(setTip)(event.target.value)} />
        </label>
      )}
      {isCash && (
        <>
          <label className={LABEL}>
            Cash received
            <input className={INPUT} inputMode="decimal" value={received} onChange={(event) => edited(setReceived)(event.target.value)} required />
          </label>
          <p className="text-base font-medium" aria-live="polite">
            Change due: {change === null ? "—" : formatMoney(change)}
          </p>
        </>
      )}
      {isCard && (
        <>
          <p className="rounded-md border border-warning-300 bg-warning-50 p-2 text-sm text-warning-900">
            Processed on an external card terminal. This only records the result. Never enter the
            card number, security code or PIN.
          </p>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" className="size-5 accent-brand-700" checked={failed} onChange={(event) => edited(setFailed)(event.target.checked)} />
            The terminal reported this attempt as failed
          </label>
          {failed && (
            <label className={LABEL}>
              Failure reported
              <input className={INPUT} value={failureReason} onChange={(event) => edited(setFailureReason)(event.target.value)} required maxLength={200} />
            </label>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={LABEL}>
              Provider (optional)
              <input className={INPUT} value={providerName} onChange={(event) => edited(setProviderName)(event.target.value)} maxLength={60} />
            </label>
            <label className={LABEL}>
              Card brand (optional)
              <input className={INPUT} value={cardBrand} onChange={(event) => edited(setCardBrand)(event.target.value)} maxLength={30} />
            </label>
            <label className={LABEL}>
              Last four digits (optional)
              <input
                className={INPUT}
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                autoComplete="off"
                value={cardLastFour}
                onChange={(event) => edited(setCardLastFour)(event.target.value)}
              />
            </label>
            <label className={LABEL}>
              Authorization code (optional)
              <input className={INPUT} value={authorizationReference} onChange={(event) => edited(setAuthorizationReference)(event.target.value)} maxLength={40} />
            </label>
          </div>
        </>
      )}
      {!isCash && (
        <label className={LABEL}>
          {tenderType === "HOUSE_ACCOUNT" ? "Account reference" : "Reference (optional)"}
          <input className={INPUT} value={externalReference} onChange={(event) => edited(setExternalReference)(event.target.value)} maxLength={80} />
        </label>
      )}
      {tenderType === "OTHER" && (
        <label className={LABEL}>
          What was this tender?
          <input className={INPUT} value={otherDescription} onChange={(event) => edited(setOtherDescription)(event.target.value)} required maxLength={200} />
        </label>
      )}
      <button type="submit" className={PRIMARY} disabled={pending}>
        {isCard && failed ? "Record failed attempt" : `Record ${TENDER_LABELS[tenderType].toLowerCase()}`}
      </button>
      <ErrorText error={error} />
    </form>
  );
}

function OpenSettlement({
  view,
  settlement,
  abilities,
}: {
  view: OrderSettlementView;
  settlement: SettlementDetail;
  abilities: SettlementAbilities;
}) {
  const complete = useAction();
  const cancel = useAction();
  const completeKey = useRef<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const zero = settlement.orderAmountSnapshot === "0.00";
  const hasRecorded = settlement.tenders.some((tender) => tender.status === "RECORDED");

  async function completeSettlement() {
    completeKey.current ??= newKey("complete");

    const result = await complete.run(
      `/api/settlements/${settlement.id}/complete`,
      { expectedVersion: settlement.version },
      { "Idempotency-Key": completeKey.current },
    );

    if (result.ok || result.status !== 0) {
      completeKey.current = null;
    }
  }

  async function cancelSettlement(event: FormEvent) {
    event.preventDefault();
    await cancel.run(`/api/settlements/${settlement.id}/cancel`, {
      expectedVersion: settlement.version,
      reason: cancelReason,
    });
  }

  return (
    <section aria-label="Open settlement" className="grid gap-3">
      {/* The remaining balance comes from the server and is the number staff look for first. */}
      <div
        className={cn(
          "grid gap-1 rounded-lg border-2 p-4",
          settlement.remainingAmount === "0.00" ? "border-success-500 bg-success-50" : "border-brand-600 bg-brand-50",
        )}
      >
        <p className="text-sm font-semibold tracking-wide text-neutral-700 uppercase">Remaining</p>
        <p aria-label="Remaining" className="tabular text-4xl font-bold">
          {formatMoney(settlement.remainingAmount)}
        </p>
      </div>
      <div className="grid gap-1 rounded-md border border-neutral-200 bg-surface p-3">
        <Row label="Order amount" value={formatMoney(settlement.orderAmountSnapshot)} />
        <Row label="Applied" value={formatMoney(settlement.tenderedAmount)} />
        {settlement.tipAmount !== "0.00" && <Row label="Tips (separate)" value={formatMoney(settlement.tipAmount)} />}
        {settlement.changeDue !== "0.00" && <Row label="Cash change given" value={formatMoney(settlement.changeDue)} />}
      </div>

      {settlement.tenders.length > 0 && (
        <ul className="grid gap-2" aria-label="Tenders">
          {settlement.tenders.map((tender) => (
            <TenderLine key={tender.id} settlement={settlement} tender={tender} canVoid={abilities.voidTender} />
          ))}
        </ul>
      )}

      {settlement.remainingAmount !== "0.00" && abilities.tenderTypes.length > 0 && (
        <TenderForm key={settlement.version} settlement={settlement} tenderTypes={abilities.tenderTypes} />
      )}

      {abilities.complete && (
        <div className="grid gap-2">
          {view.order.draftCount > 0 && (
            <p className="text-sm text-danger-700">Send or remove the {view.order.draftCount} unsent item(s) before completing.</p>
          )}
          <button
            type="button"
            className={PRIMARY}
            disabled={complete.pending || !view.eligibility.canComplete}
            onClick={completeSettlement}
          >
            {zero ? "Complete $0.00 settlement and close order" : "Complete settlement and close order"}
          </button>
          <ErrorText error={complete.error} />
        </div>
      )}

      {abilities.cancel && !hasRecorded && (
        <div className="grid gap-2">
          {!cancelling ? (
            <button type="button" className={BUTTON} onClick={() => setCancelling(true)}>
              Cancel settlement
            </button>
          ) : (
            <form onSubmit={cancelSettlement} className="grid gap-2">
              <label className={LABEL}>
                Reason for cancelling
                <input className={INPUT} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} required maxLength={300} />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={BUTTON} disabled={cancel.pending || !cancelReason.trim()}>
                  Confirm cancel
                </button>
                <button type="button" className={BUTTON} onClick={() => setCancelling(false)}>
                  Keep settlement
                </button>
              </div>
            </form>
          )}
          <ErrorText error={cancel.error} />
        </div>
      )}
      {hasRecorded && (
        <p className="text-xs text-neutral-600">
          While this settlement is open the check is locked. To change it, void the tenders and cancel the settlement.
        </p>
      )}
    </section>
  );
}

function CompletedSettlement({ view, settlement }: { view: OrderSettlementView; settlement: SettlementDetail }) {
  return (
    <section aria-label="Completed settlement" className="grid gap-3">
      <p role="status" className="rounded-md border border-success-300 bg-success-50 p-3 text-success-800">
        Settled and closed{settlement.completedAt ? ` at ${new Date(settlement.completedAt).toLocaleString()}` : ""}.
        {view.order.tableNumbers.length > 0 &&
          " The table session stays active until the guests leave: complete it on the floor, then the table is marked dirty."}
      </p>
      <div className="grid gap-1 rounded-md border border-neutral-200 bg-surface p-3">
        <Row label="Order amount" value={formatMoney(settlement.orderAmountSnapshot)} />
        <Row label="Applied" value={formatMoney(settlement.tenderedAmount)} />
        <Row label="Tips (separate)" value={formatMoney(settlement.tipAmount)} />
        <Row label="Cash change given" value={formatMoney(settlement.changeDue)} />
      </div>
      <ul className="grid gap-2" aria-label="Tenders">
        {settlement.tenders.map((tender) => (
          <TenderLine key={tender.id} settlement={settlement} tender={tender} canVoid={false} />
        ))}
        {settlement.tenders.length === 0 && (
          <li className="text-sm text-neutral-600">No tender: the amount due was $0.00.</li>
        )}
      </ul>
      {view.order.tableNumbers.length > 0 && (
        <Link href="/restaurant" className="text-sm underline">
          Go to the floor
        </Link>
      )}
    </section>
  );
}

export function SettlementWorkspace({ view, abilities }: { view: OrderSettlementView; abilities: SettlementAbilities }) {
  useRealtimeRefresh(EVENTS, 60_000);
  const open = useAction();
  const { order, current } = view;
  const cancelled = view.history.filter((entry) => entry.status === "CANCELLED");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_26rem]">
      <section aria-label="Check summary" className="order-2 grid content-start gap-3 lg:order-1">
        <h2 className="text-xl font-semibold">Check</h2>
        <ul className="grid gap-2">
          {order.items.map((item) => (
            <li key={item.id} className="grid gap-1 border-b border-neutral-200 pb-2">
              <p className="flex justify-between gap-2">
                <span className={item.status === "VOIDED" ? "line-through" : ""}>
                  {item.quantity} × {item.name}
                </span>
                <span>{item.status === "VOIDED" ? "voided" : formatMoney(item.lineTotal)}</span>
              </p>
              {item.discounts
                .filter((entry) => entry.status === "APPLIED")
                .map((entry, index) => (
                  <p key={index} className="flex justify-between text-sm text-neutral-700">
                    <span>{entry.isComp ? `Comp: ${entry.name}` : entry.name}</span>
                    <span>−{formatMoney(entry.appliedAmount)}</span>
                  </p>
                ))}
            </li>
          ))}
          {order.items.length === 0 && <li className="text-sm text-neutral-600">Nothing has been sent.</li>}
        </ul>
        {order.discounts
          .filter((entry) => entry.status === "APPLIED")
          .map((entry, index) => (
            <p key={index} className="flex justify-between text-sm">
              <span>{entry.isComp ? `Comp: ${entry.name}` : entry.name}</span>
              <span>−{formatMoney(entry.appliedAmount)}</span>
            </p>
          ))}
        <div className="grid gap-1 border-t border-neutral-200 pt-2">
          <Row label="Items" value={formatMoney(order.itemSubtotal)} />
          {order.discountTotal !== "0.00" && <Row label="Discounts" value={`−${formatMoney(order.discountTotal)}`} />}
          <Row label="Amount due before tax" value={formatMoney(order.subtotal)} strong />
          <p className="text-xs text-neutral-600">Tax isn&apos;t calculated in this version.</p>
          {order.fullyComped && (
            <p className="text-sm">Discounts and comps reduced the amount due to $0.00.</p>
          )}
        </div>
        {cancelled.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm">Cancelled settlements ({cancelled.length})</summary>
            <ul className="mt-2 grid gap-1 text-sm">
              {cancelled.map((entry) => (
                <li key={entry.id}>
                  {formatMoney(entry.orderAmountSnapshot)} · {entry.cancelReason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <aside aria-label="Settlement" className="order-1 grid content-start gap-4 lg:sticky lg:top-20 lg:order-2 lg:self-start">
        <div>
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-2xl font-semibold">Settle order #{order.orderNumber}</h1>
          </div>
          <p className="text-neutral-600">
            {ORDER_TYPE_LABELS[order.orderType] ?? order.orderType}
            {order.tableNumbers.length > 0 ? ` · Table ${order.tableNumbers.join(" + ")}` : ""}
            {order.customerName ? ` · ${order.customerName}` : ""}{" "}
            <StatusBadge domain="order" status={order.status} data-testid="order-status" />
          </p>
          <p className="mt-1 text-xs text-neutral-600">
            Record only: payments are taken outside this app.
          </p>
        </div>

        {current?.status === "OPEN" && <OpenSettlement view={view} settlement={current} abilities={abilities} />}
        {current?.status === "COMPLETED" && <CompletedSettlement view={view} settlement={current} />}

        {!current && order.status === "OPEN" && (
          <div className="grid gap-2">
            {abilities.open ? (
              <button
                type="button"
                className={PRIMARY}
                disabled={open.pending}
                onClick={() => open.run(`/api/orders/${order.id}/settlements`)}
              >
                Open settlement for {formatMoney(order.subtotal)}
              </button>
            ) : (
              <p className="text-sm text-neutral-600">No settlement has been opened.</p>
            )}
            <ErrorText error={open.error} />
          </div>
        )}
        {!current && order.status === "VOIDED" && (
          <p role="status" className="rounded-md border border-neutral-200 bg-neutral-100 p-3">
            This order was voided, so there is nothing to settle.
          </p>
        )}
      </aside>
    </div>
  );
}
