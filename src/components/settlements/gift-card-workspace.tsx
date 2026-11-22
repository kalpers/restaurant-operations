"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { callOrderApi, formatMoney } from "@/components/orders/order-api";
import { useLocationTimeZone } from "@/components/time/location-time-zone";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { INPUT_STYLE } from "@/components/ui/field";
import type { GiftCardHistory, GiftCardProgramView, GiftCardView } from "@/modules/settlements/services/gift-card-service";
import type { StockBatchView, StockCardView } from "@/modules/settlements/services/gift-card-stock-service";
import { formatInstant } from "@/shared/time/format-instant";

// Phase 31 gift cards (policies 4, 5, 11, 12, 17). Record only: selling a card records how the
// guest paid, nothing is charged. A new card's code is shown once, here, and is never stored;
// the server decides every amount and permission.

type ApiError = { code: string; message: string; requestId?: string } | null;
type SaleTender = "CASH" | "EXTERNAL_CARD" | "OTHER";

export type GiftCardAbilities = {
  sell: boolean;
  manage: boolean;
  saleTenders: SaleTender[];
  /** Phase 34 (policy 4): may read and change purchaser details. */
  purchaserView: boolean;
};

/** Phase 34 (policy 3): the purchaser fields, in form order. */
const PURCHASER_INPUTS = [
  { key: "name", label: "Name", max: 120 },
  { key: "email", label: "Email", max: 254 },
  { key: "phone", label: "Phone", max: 40 },
  { key: "addressLine1", label: "Address line 1", max: 120 },
  { key: "addressLine2", label: "Address line 2", max: 120 },
  { key: "city", label: "City", max: 80 },
  { key: "region", label: "State or region", max: 80 },
  { key: "postalCode", label: "Postal code", max: 20 },
  { key: "country", label: "Country", max: 60 },
] as const;

type PurchaserKey = (typeof PURCHASER_INPUTS)[number]["key"];
type PurchaserValues = Record<PurchaserKey, string>;

const EMPTY_PURCHASER: PurchaserValues = Object.fromEntries(PURCHASER_INPUTS.map((field) => [field.key, ""])) as PurchaserValues;

function PurchaserFields({ values, onChange }: { values: PurchaserValues; onChange: (values: PurchaserValues) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {PURCHASER_INPUTS.map((field) => (
        <label key={field.key} className={LABEL}>
          {field.label}
          <input
            className={INPUT}
            value={values[field.key]}
            maxLength={field.max}
            autoComplete="off"
            onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
          />
        </label>
      ))}
    </div>
  );
}

const purchaserBody = (values: PurchaserValues) =>
  PURCHASER_INPUTS.some((field) => values[field.key].trim())
    ? Object.fromEntries(PURCHASER_INPUTS.map((field) => [field.key, values[field.key].trim() || null]))
    : null;

const BUTTON = buttonClass("secondary");
const PRIMARY = buttonClass("primary");
const INPUT = INPUT_STYLE;
const LABEL = "grid gap-1 text-sm font-medium text-neutral-800";

const SALE_TENDER_LABELS: Record<SaleTender, string> = {
  CASH: "Cash",
  EXTERNAL_CARD: "Card (external terminal)",
  OTHER: "Other",
};

const ENTRY_LABELS: Record<string, string> = {
  ISSUED: "Sold",
  RELOADED: "Reloaded",
  SALE_VOIDED: "Sale voided",
  REDEEMED: "Spent on a check",
  REDEMPTION_VOIDED: "Tender voided",
  REFUNDED: "Refunded to card",
  REFUND_VOIDED: "Refund voided",
  ADJUSTED: "Adjusted",
  CASHED_OUT: "Cashed out",
  ESCHEATED: "Reported as unclaimed",
};

const STATUS_LABELS: Record<string, string> = { ACTIVE: "Active", INACTIVE: "Inactive", STOCK: "Unsold stock" };

function newKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>(null);

  async function run<Data>(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
    setPending(true);
    setError(null);

    const result = await callOrderApi<Data>(method, url, body, headers);

    setPending(false);

    if (!result.ok) {
      if (result.status === 401) {
        router.push("/login");
      } else {
        setError(result);
      }
    }

    return result;
  }

  return { run, pending, error, refresh: () => router.refresh() };
}

/** The code, once: staff write it on or attach it to the card before closing this. */
function CodeOnce({ code, cardNumber, onDone }: { code: string; cardNumber: string; onDone: () => void }) {
  return (
    <div role="alert" className="grid gap-2 rounded-lg border-2 border-brand-600 bg-brand-50 p-4">
      <p className="text-sm font-semibold">Card {cardNumber}: write this code on the card now. It won&apos;t be shown again.</p>
      <p aria-label="Gift card code" className="tabular text-2xl font-bold tracking-wider select-all">
        {code}
      </p>
      <button type="button" className={BUTTON} onClick={onDone}>
        I&apos;ve written it down
      </button>
    </div>
  );
}

function SellForm({
  abilities,
  drawers,
  drawerRequired,
  maxBalance,
}: {
  abilities: GiftCardAbilities;
  drawers: { id: string; label: string }[];
  drawerRequired: boolean;
  maxBalance: string;
}) {
  const action = useAction();
  const [reload, setReload] = useState(false);
  const [code, setCode] = useState("");
  // Phase 33 (policy 14): a new card may carry the code its supplier printed on it.
  const [printed, setPrinted] = useState(false);
  const [supplierCode, setSupplierCode] = useState("");
  const [amount, setAmount] = useState("");
  const [tenderType, setTenderType] = useState<SaleTender>(abilities.saleTenders[0] ?? "CASH");
  const [received, setReceived] = useState("");
  const [drawerId, setDrawerId] = useState(drawers[0]?.id ?? "");
  const [otherDescription, setOtherDescription] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [shown, setShown] = useState<{ code: string; cardNumber: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Phase 34 (policy 3): who bought it, optional, for an unclaimed-property filing.
  const [purchaser, setPurchaser] = useState<PurchaserValues>(EMPTY_PURCHASER);
  const key = useRef<string | null>(null);
  const isCash = tenderType === "CASH";

  function edited<T>(setter: (value: T) => void) {
    return (value: T) => {
      key.current = null;
      setter(value);
    };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    key.current ??= newKey("gift-card-sale");

    const result = await action.run<{
      code: string | null;
      replayed: boolean;
      kind: string;
      changeAmount: string;
      card: { cardNumber: string; balance: string };
    }>(
      "POST",
      "/api/gift-cards",
      {
        giftCardCode: reload ? code : null,
        supplierCode: !reload && printed ? supplierCode : null,
        amount,
        tenderType,
        receivedAmount: isCash ? received || amount : null,
        cashDrawerSessionId: isCash && drawerId ? drawerId : null,
        otherDescription: tenderType === "OTHER" ? otherDescription : null,
        externalReference: isCash ? null : externalReference || null,
        purchaser: reload ? null : purchaserBody(purchaser),
      },
      { "Idempotency-Key": key.current },
    );

    if (result.ok || (result.status >= 400 && result.status < 500)) {
      key.current = null;
    }

    if (result.ok) {
      const data = result.data;

      if (data.code) {
        setShown({ code: data.code, cardNumber: data.card.cardNumber });
      }

      setDone(
        `${data.kind === "ISSUED" ? "Sold" : "Reloaded"} ${data.card.cardNumber}: balance ${formatMoney(data.card.balance)}` +
          (data.changeAmount !== "0.00" ? `, change ${formatMoney(data.changeAmount)}` : "") +
          (data.replayed && !data.code && data.kind === "ISSUED" && !printed
            ? ". This sale was already recorded, so its code can't be shown again; a manager can replace the code."
            : "."),
      );
      setCode("");
      setSupplierCode("");
      setAmount("");
      setReceived("");
      setOtherDescription("");
      setExternalReference("");
      setPurchaser(EMPTY_PURCHASER);
      action.refresh();
    }
  }

  return (
    <Card aria-label="Sell or reload a gift card">
      <CardTitle>Sell or reload</CardTitle>
      {shown && <CodeOnce code={shown.code} cardNumber={shown.cardNumber} onDone={() => setShown(null)} />}
      <form onSubmit={submit} className="mt-3 grid gap-3">
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="sr-only">New or existing card</legend>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="sale-kind" checked={!reload} onChange={() => edited(setReload)(false)} className="size-5" />
            New card
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="sale-kind" checked={reload} onChange={() => edited(setReload)(true)} className="size-5" />
            Reload a card
          </label>
        </fieldset>
        {!reload && (
          <fieldset className="grid gap-2 text-sm">
            <legend className="sr-only">Card code</legend>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="code-kind" checked={!printed} onChange={() => edited(setPrinted)(false)} className="size-5" />
              Generate a code
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="code-kind" checked={printed} onChange={() => edited(setPrinted)(true)} className="size-5" />
              Use the code printed on the card
            </label>
            {printed && (
              <label className={LABEL}>
                Printed code (8 to 24 letters and digits)
                <input
                  className={INPUT}
                  value={supplierCode}
                  onChange={(event) => edited(setSupplierCode)(event.target.value)}
                  required
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}
          </fieldset>
        )}
        {reload && (
          <label className={LABEL}>
            Card code
            <input
              className={INPUT}
              value={code}
              onChange={(event) => edited(setCode)(event.target.value)}
              required
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX-XXXX"
            />
          </label>
        )}
        <label className={LABEL}>
          Amount (1.00 to {formatMoney(maxBalance)} on the card)
          <input className={INPUT} inputMode="decimal" value={amount} onChange={(event) => edited(setAmount)(event.target.value)} required />
        </label>
        <label className={LABEL}>
          Guest paid by
          <select className={INPUT} value={tenderType} onChange={(event) => edited(setTenderType)(event.target.value as SaleTender)}>
            {abilities.saleTenders.map((type) => (
              <option key={type} value={type}>
                {SALE_TENDER_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        {isCash && (
          <>
            <label className={LABEL}>
              Cash received
              <input className={INPUT} inputMode="decimal" value={received} placeholder={amount} onChange={(event) => edited(setReceived)(event.target.value)} />
            </label>
            {drawers.length > 0 ? (
              <label className={LABEL}>
                Cash drawer
                <select className={INPUT} value={drawerId} onChange={(event) => edited(setDrawerId)(event.target.value)}>
                  {!drawerRequired && <option value="">No drawer</option>}
                  {drawers.map((drawer) => (
                    <option key={drawer.id} value={drawer.id}>
                      {drawer.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              drawerRequired && (
                <p className="rounded-md border border-warning-300 bg-warning-50 p-2 text-sm text-warning-900">
                  Cash needs an open cash drawer here, and none is open.
                </p>
              )
            )}
          </>
        )}
        {tenderType === "EXTERNAL_CARD" && (
          <p className="rounded-md border border-warning-300 bg-warning-50 p-2 text-sm text-warning-900">
            Take the payment on the external terminal first. Never enter the card number, security code or PIN.
          </p>
        )}
        {!isCash && (
          <label className={LABEL}>
            Reference (optional)
            <input className={INPUT} value={externalReference} onChange={(event) => edited(setExternalReference)(event.target.value)} maxLength={80} />
          </label>
        )}
        {tenderType === "OTHER" && (
          <label className={LABEL}>
            How did the guest pay?
            <input className={INPUT} value={otherDescription} onChange={(event) => edited(setOtherDescription)(event.target.value)} required maxLength={200} />
          </label>
        )}
        {!reload && (
          <details className="rounded-md border border-neutral-200 p-2 text-sm">
            <summary className="min-h-11 cursor-pointer content-center font-medium">Purchaser details (optional)</summary>
            <p className="my-2 text-xs text-neutral-600">
              Only if the guest is happy to give them: used only if the card is ever reported to the state as unclaimed. Never
              for messages.
            </p>
            <PurchaserFields values={purchaser} onChange={edited(setPurchaser)} />
          </details>
        )}
        <button type="submit" className={PRIMARY} disabled={action.pending || abilities.saleTenders.length === 0}>
          {reload ? "Reload card" : "Sell card"}
        </button>
        {done && (
          <p aria-live="polite" className="text-sm font-medium">
            {done}
          </p>
        )}
        <ApiErrorMessage error={action.error} className="flex" />
      </form>
    </Card>
  );
}

function ManagerActions({
  card,
  drawers,
  drawerRequired,
  onChanged,
}: {
  card: GiftCardView;
  drawers: { id: string; label: string }[];
  drawerRequired: boolean;
  onChanged: (view: GiftCardView) => void;
}) {
  const action = useAction();
  const [mode, setMode] = useState<"adjust" | "cash-out" | "status" | "replace" | "unclaimed" | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [drawerId, setDrawerId] = useState(drawers[0]?.id ?? "");
  const [newCode, setNewCode] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  // Phase 34 (policy 6): the filing the balance was reported in.
  const [state, setState] = useState("");
  const [filingReference, setFilingReference] = useState("");
  const [reportDate, setReportDate] = useState("");
  const key = useRef<string | null>(null);

  function choose(next: typeof mode) {
    setMode(next);
    setReason("");
    setAmount("");
    setReplacement("");
    setState("");
    setFilingReference("");
    setReportDate("");
    key.current = null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();

    const base = `/api/gift-cards/${card.id}`;
    let result;

    if (mode === "adjust") {
      result = await action.run<GiftCardView>("POST", `${base}/adjust`, { amount, reason, expectedVersion: card.version });
    } else if (mode === "cash-out") {
      key.current ??= newKey("gift-card-cash-out");
      result = await action.run<{ card: Omit<GiftCardView, "lastFour"> }>(
        "POST",
        `${base}/cash-out`,
        { reason, expectedVersion: card.version, cashDrawerSessionId: drawerId || null },
        { "Idempotency-Key": key.current },
      );
    } else if (mode === "unclaimed") {
      result = await action.run("POST", `${base}/unclaimed`, { state, filingReference, reportDate, expectedVersion: card.version });

      if (result.ok) {
        choose(null);
        onChanged(card);
        action.refresh();
      }

      return;
    } else if (mode === "status") {
      result = await action.run<GiftCardView>("POST", `${base}/status`, {
        status: card.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
        reason,
        expectedVersion: card.version,
      });
    } else {
      result = await action.run<{ card: GiftCardView; code: string | null }>("POST", `${base}/replace-code`, {
        reason,
        expectedVersion: card.version,
        supplierCode: replacement.trim() || null,
      });
    }

    if (result.ok) {
      const data = result.data as GiftCardView | { card: GiftCardView; code?: string };

      if ("code" in data && data.code) {
        setNewCode(data.code);
      }

      choose(null);
      onChanged("card" in data ? { ...card, ...data.card } : data);
      action.refresh();
    }
  }

  return (
    <section aria-label="Manager actions" className="grid gap-2">
      {newCode && <CodeOnce code={newCode} cardNumber={card.cardNumber} onDone={() => setNewCode(null)} />}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} onClick={() => choose("adjust")}>
          Adjust
        </button>
        <button type="button" className={BUTTON} onClick={() => choose("cash-out")} disabled={card.balance === "0.00"}>
          Cash out
        </button>
        <button type="button" className={BUTTON} onClick={() => choose("status")}>
          {card.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
        </button>
        <button type="button" className={BUTTON} onClick={() => choose("replace")}>
          Replace code
        </button>
        <button type="button" className={BUTTON} onClick={() => choose("unclaimed")} disabled={card.balance === "0.00"}>
          Report as unclaimed
        </button>
      </div>
      {mode && (
        <form onSubmit={submit} className="grid gap-2" aria-label={`Card ${mode}`}>
          {mode === "adjust" && (
            <label className={LABEL}>
              Amount to add (use a minus sign to remove)
              <input className={INPUT} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
            </label>
          )}
          {mode === "cash-out" && (
            <>
              <p className="text-sm">Pays out the whole balance, {formatMoney(card.balance)}, in cash.</p>
              {drawers.length > 0 && (
                <label className={LABEL}>
                  From cash drawer
                  <select className={INPUT} value={drawerId} onChange={(event) => setDrawerId(event.target.value)}>
                    {!drawerRequired && <option value="">No drawer</option>}
                    {drawers.map((drawer) => (
                      <option key={drawer.id} value={drawer.id}>
                        {drawer.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          {mode === "replace" && (
            <label className={LABEL}>
              Code printed on a replacement card (optional; leave empty to generate one)
              <input
                className={INPUT}
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          {mode === "unclaimed" ? (
            <>
              <p className="rounded-md border border-warning-300 bg-warning-50 p-2 text-sm text-warning-900">
                Only after the balance, {formatMoney(card.balance)}, was reported and paid to the state. The card is
                deactivated and its balance goes to zero for good; the guest then claims it from the state.
              </p>
              <label className={LABEL}>
                State (two letters)
                <input className={INPUT} value={state} onChange={(event) => setState(event.target.value.toUpperCase())} required maxLength={2} />
              </label>
              <label className={LABEL}>
                Filing reference
                <input className={INPUT} value={filingReference} onChange={(event) => setFilingReference(event.target.value)} required maxLength={60} />
              </label>
              <label className={LABEL}>
                Date reported
                <input className={INPUT} type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} required />
              </label>
            </>
          ) : (
            <label className={LABEL}>
              Reason
              <input className={INPUT} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={200} />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={PRIMARY} disabled={action.pending || (mode === "unclaimed" ? !filingReference.trim() : !reason.trim())}>
              Confirm
            </button>
            <button type="button" className={BUTTON} onClick={() => choose(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ApiErrorMessage error={action.error} className="flex" />
    </section>
  );
}

type PurchaserView = PurchaserValues & { cleared: boolean; version: number | null };

/** Phase 34 (policies 3–4): who bought the card, for purchaser-permission holders only. */
function PurchaserPanel({ cardId, canManage }: { cardId: string; canManage: boolean }) {
  const action = useAction();
  const [view, setView] = useState<PurchaserView | null>(null);
  const [editing, setEditing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [values, setValues] = useState<PurchaserValues>(EMPTY_PURCHASER);

  async function load() {
    const result = await action.run<Record<PurchaserKey, string | null> & { cleared: boolean; version: number | null }>(
      "GET",
      `/api/gift-cards/${cardId}/purchaser`,
    );

    if (result.ok) {
      const data = result.data;
      const loaded = Object.fromEntries(PURCHASER_INPUTS.map((field) => [field.key, data[field.key] ?? ""])) as PurchaserValues;

      setView({ ...loaded, cleared: data.cleared, version: data.version });
      setValues(loaded);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();

    const result = await action.run("PUT", `/api/gift-cards/${cardId}/purchaser`, {
      details: purchaserBody(values) ?? {},
      expectedVersion: view?.version ?? null,
    });

    if (result.ok) {
      setEditing(false);
      await load();
    }
  }

  async function clear() {
    const result = await action.run("POST", `/api/gift-cards/${cardId}/purchaser/clear`, { expectedVersion: view?.version });

    if (result.ok) {
      setClearing(false);
      await load();
    }
  }

  const given = view ? PURCHASER_INPUTS.filter((field) => view[field.key]) : [];

  return (
    <section aria-label="Purchaser details" className="mt-4 grid gap-2 text-sm">
      <h3 className="font-semibold">Purchaser</h3>
      {!view ? (
        <button type="button" className={BUTTON} onClick={load} disabled={action.pending}>
          Show purchaser details
        </button>
      ) : view.cleared ? (
        <p>Purchaser details were cleared.</p>
      ) : editing ? (
        <form onSubmit={save} className="grid gap-2">
          <PurchaserFields values={values} onChange={setValues} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={PRIMARY} disabled={action.pending}>
              Save purchaser
            </button>
            <button type="button" className={BUTTON} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {given.length === 0 ? (
            <p>None given.</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {given.map((field) => (
                <div key={field.key} className="contents">
                  <dt className="text-neutral-600">{field.label}</dt>
                  <dd>{view[field.key]}</dd>
                </div>
              ))}
            </dl>
          )}
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BUTTON} onClick={() => setEditing(true)}>
                {given.length === 0 ? "Add purchaser" : "Change purchaser"}
              </button>
              {view.version !== null && !clearing && (
                <button type="button" className={BUTTON} onClick={() => setClearing(true)}>
                  Clear purchaser details
                </button>
              )}
              {clearing && (
                <>
                  <span className="self-center">They can&apos;t be entered again.</span>
                  <button type="button" className={buttonClass("danger")} onClick={clear} disabled={action.pending}>
                    Clear for good
                  </button>
                  <button type="button" className={BUTTON} onClick={() => setClearing(false)}>
                    Keep
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
      <ApiErrorMessage error={action.error} className="flex" />
    </section>
  );
}

function CardDetail({
  history,
  canManage,
  canViewPurchaser,
  drawers,
  drawerRequired,
  onReload,
}: {
  history: GiftCardHistory;
  canManage: boolean;
  canViewPurchaser: boolean;
  drawers: { id: string; label: string }[];
  drawerRequired: boolean;
  onReload: () => void;
}) {
  const timeZone = useLocationTimeZone();
  const voidSale = useAction();
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const { card } = history;

  async function submitVoid(event: FormEvent, sale: GiftCardHistory["sales"][number]) {
    event.preventDefault();

    const result = await voidSale.run("POST", `/api/gift-cards/sales/${sale.id}/void`, { reason, expectedVersion: sale.version });

    if (result.ok) {
      setVoiding(null);
      setReason("");
      onReload();
    }
  }

  return (
    <Card aria-label={`Gift card ${card.cardNumber}`}>
      <CardTitle>
        {card.cardNumber}{" "}
        <Badge tone={card.status === "ACTIVE" ? "success" : "neutral"}>{STATUS_LABELS[card.status] ?? card.status}</Badge>
      </CardTitle>
      <p className="mb-1 text-sm text-neutral-700">Code ends {card.lastFour}</p>
      <p className="mb-3 text-lg">
        Balance <span aria-label="Gift card balance" className="tabular text-2xl font-bold">{formatMoney(card.balance)}</span>
      </p>
      {card.statusReason && card.status === "INACTIVE" && <p className="mb-3 text-sm">Deactivated: {card.statusReason}</p>}
      {card.status === "STOCK" && <p className="mb-3 text-sm">Registered stock, not sold yet. Sell it with its printed code.</p>}
      {canManage && card.issuedAt !== null && (
        <ManagerActions card={card} drawers={drawers} drawerRequired={drawerRequired} onChanged={onReload} />
      )}
      {canViewPurchaser && card.issuedAt !== null && <PurchaserPanel cardId={card.id} canManage={canManage} />}

      <h3 className="mt-4 mb-2 font-semibold">History</h3>
      <ul className="grid gap-1 text-sm" aria-label="Card history">
        {history.entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap justify-between gap-2 border-b border-neutral-100 py-1">
            <span>
              {ENTRY_LABELS[entry.kind] ?? entry.kind}
              {entry.reason ? ` · ${entry.reason}` : ""}
              <span className="ml-2 text-neutral-600">{formatInstant(entry.occurredAt, timeZone)}</span>
            </span>
            <span className="tabular">
              {entry.amount.startsWith("-") ? "−" + formatMoney(entry.amount.slice(1)) : "+" + formatMoney(entry.amount)} →{" "}
              {formatMoney(entry.balanceAfter)}
            </span>
          </li>
        ))}
      </ul>

      {canManage && history.sales.some((sale) => sale.status === "RECORDED") && (
        <>
          <h3 className="mt-4 mb-2 font-semibold">Sales</h3>
          <ul className="grid gap-2 text-sm">
            {history.sales.map((sale) => (
              <li key={sale.id} className="grid gap-1">
                <span>
                  {sale.kind === "ISSUED" ? "Sold" : "Reloaded"} {formatMoney(sale.amount)} · {SALE_TENDER_LABELS[sale.tenderType as SaleTender]} ·{" "}
                  {sale.businessDate} {sale.status === "VOIDED" ? "· voided" : ""}
                </span>
                {sale.status === "RECORDED" && voiding !== sale.id && (
                  <button type="button" className={BUTTON} onClick={() => setVoiding(sale.id)}>
                    Void sale
                  </button>
                )}
                {voiding === sale.id && (
                  <form onSubmit={(event) => submitVoid(event, sale)} className="grid gap-2">
                    <label className={LABEL}>
                      Reason for voiding
                      <input className={INPUT} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={200} />
                    </label>
                    <div className="flex gap-2">
                      <button type="submit" className={BUTTON} disabled={voidSale.pending || !reason.trim()}>
                        Confirm void
                      </button>
                      <button type="button" className={BUTTON} onClick={() => setVoiding(null)}>
                        Keep
                      </button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
          <ApiErrorMessage error={voidSale.error} className="flex" />
        </>
      )}
    </Card>
  );
}

function ProgramForm({ program }: { program: GiftCardProgramView }) {
  const action = useAction();
  const [enabled, setEnabled] = useState(program.enabled);
  const [maxBalance, setMaxBalance] = useState(program.maxBalance);
  const [dormancyMonths, setDormancyMonths] = useState(String(program.dormancyMonths));
  const [stockRequired, setStockRequired] = useState(program.supplierStockRequired);

  async function submit(event: FormEvent) {
    event.preventDefault();

    const result = await action.run("PUT", "/api/gift-cards/program", {
      enabled,
      maxBalance,
      dormancyMonths: Number(dormancyMonths),
      supplierStockRequired: stockRequired,
      expectedVersion: program.version,
    });

    if (result.ok) {
      action.refresh();
    }
  }

  return (
    <Card aria-label="Gift card settings">
      <CardTitle>Settings</CardTitle>
      <form onSubmit={submit} className="grid gap-3">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5 accent-brand-700" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Sell and accept the restaurant&apos;s own gift cards
        </label>
        <label className={LABEL}>
          Most a card can hold
          <input className={INPUT} inputMode="decimal" value={maxBalance} onChange={(event) => setMaxBalance(event.target.value)} required />
        </label>
        <label className={LABEL}>
          Months without use before a balance is listed as unused (12 to 120)
          <input
            className={INPUT}
            type="number"
            min={12}
            max={120}
            value={dormancyMonths}
            onChange={(event) => setDormancyMonths(event.target.value)}
            required
          />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5 accent-brand-700"
            checked={stockRequired}
            onChange={(event) => setStockRequired(event.target.checked)}
          />
          Only sell supplier-printed cards registered under Card stock (catches mistyped codes)
        </label>
        <p className="text-xs text-neutral-600">
          While this is on, every gift card tender names one of these cards. Record other companies&apos; gift cards as
          &ldquo;Other&rdquo;. It can&apos;t be turned off while any card holds a balance.
        </p>
        <button type="submit" className={PRIMARY} disabled={action.pending}>
          Save settings
        </button>
        <ApiErrorMessage error={action.error} className="flex" />
      </form>
    </Card>
  );
}

/** Phase 34 (policy 10): one batch's cards, to deactivate a lost or damaged one. */
function StockBatchCards({ batch, onChanged }: { batch: StockBatchView; onChanged: () => void }) {
  const action = useAction();
  const [cards, setCards] = useState<StockCardView[] | null>(null);
  const [target, setTarget] = useState<StockCardView | "REST" | null>(null);
  const [reason, setReason] = useState("");

  async function load() {
    const result = await action.run<{ cards: StockCardView[] }>("GET", `/api/gift-cards/stock/${batch.id}`);

    if (result.ok) {
      setCards(result.data.cards);
    }
  }

  async function deactivate(event: FormEvent) {
    event.preventDefault();

    const body =
      target === "REST" ? { reason } : { reason, cardId: target!.id, expectedVersion: target!.version };
    const result = await action.run("POST", `/api/gift-cards/stock/${batch.id}/deactivate`, body);

    if (result.ok) {
      setTarget(null);
      setReason("");
      onChanged();
      await load();
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} onClick={load} disabled={action.pending}>
          {cards ? "Refresh cards" : "Show cards"}
        </button>
        {batch.inStock > 0 && (
          <button type="button" className={BUTTON} onClick={() => setTarget("REST")}>
            Deactivate the {batch.inStock} unsold
          </button>
        )}
      </div>
      {cards && (
        <ul className="grid gap-1" aria-label={`Cards in ${batch.batchNumber}`}>
          {cards.map((card) => (
            <li key={card.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {card.cardNumber} · ends {card.lastFour}
                {card.printedSerial ? ` · serial ${card.printedSerial}` : ""}
              </span>
              <span className="flex items-center gap-2">
                {card.sold ? "Sold" : STATUS_LABELS[card.status] ?? card.status}
                {card.status === "STOCK" && (
                  <button type="button" className={BUTTON} onClick={() => setTarget(card)}>
                    Deactivate
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {target && (
        <form onSubmit={deactivate} className="grid gap-2" aria-label="Deactivate stock">
          <p>
            {target === "REST"
              ? `Deactivates every unsold card in ${batch.batchNumber}. They can't be sold afterwards.`
              : `Deactivates ${target.cardNumber}. It can't be sold afterwards.`}
          </p>
          <label className={LABEL}>
            Reason
            <input className={INPUT} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={200} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={PRIMARY} disabled={action.pending || !reason.trim()}>
              Confirm
            </button>
            <button type="button" className={BUTTON} onClick={() => setTarget(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ApiErrorMessage error={action.error} className="flex" />
    </div>
  );
}

/**
 * Phase 34 (policies 7–10): register a box of supplier-printed cards before they are sold, by
 * pasting the codes or choosing a CSV file. The file is read here, in the browser, and only
 * its lines are sent; nothing shows the codes again.
 */
function CardStockPanel({ batches }: { batches: StockBatchView[] }) {
  const action = useAction();
  const [description, setDescription] = useState("");
  const [codes, setCodes] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  function edited(setter: (value: string) => void) {
    return (value: string) => {
      key.current = null;
      setter(value);
    };
  }

  async function readFile(file: File | undefined) {
    if (!file) {
      return;
    }

    key.current = null;
    setCodes(await file.text());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    key.current ??= newKey("gift-card-stock");

    const result = await action.run<{ batchNumber: string; cardCount: number; firstCard: string; lastCard: string }>(
      "POST",
      "/api/gift-cards/stock",
      { description, lines: codes.split(/\r?\n/) },
      { "Idempotency-Key": key.current },
    );

    if (result.ok || (result.status >= 400 && result.status < 500)) {
      key.current = null;
    }

    if (result.ok) {
      setDone(`Registered ${result.data.batchNumber}: ${result.data.cardCount} cards, ${result.data.firstCard} to ${result.data.lastCard}.`);
      setCodes("");
      setDescription("");
      action.refresh();
    }
  }

  const lineCount = codes.split(/\r?\n/).filter((line) => line.trim()).length;

  return (
    <Card aria-label="Card stock">
      <CardTitle>Card stock</CardTitle>
      <form onSubmit={submit} className="grid gap-3">
        <p className="text-sm text-neutral-700">
          Register a box of supplier-printed cards before selling them: one code per line, or <code>serial,code</code>. Nothing
          is registered if any line is wrong. The codes aren&apos;t shown again.
        </p>
        <label className={LABEL}>
          Batch (supplier or box)
          <input className={INPUT} value={description} onChange={(event) => edited(setDescription)(event.target.value)} required maxLength={80} />
        </label>
        <label className={LABEL}>
          Codes ({lineCount} {lineCount === 1 ? "line" : "lines"}, up to 1,000)
          <textarea
            className={`${INPUT} min-h-32 font-mono`}
            value={codes}
            onChange={(event) => edited(setCodes)(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        <label className={LABEL}>
          Or choose a CSV file
          <input className={INPUT} type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => readFile(event.target.files?.[0])} />
        </label>
        <button type="submit" className={PRIMARY} disabled={action.pending || lineCount === 0 || !description.trim()}>
          Register cards
        </button>
        {done && (
          <p aria-live="polite" className="text-sm font-medium">
            {done}
          </p>
        )}
        <ApiErrorMessage error={action.error} className="flex" />
      </form>
      {batches.length > 0 && (
        <ul className="mt-4 grid gap-3 text-sm" aria-label="Stock batches">
          {batches.map((batch) => (
            <li key={batch.id} className="grid gap-2 border-t border-neutral-100 pt-2">
              <span>
                <span className="font-medium">{batch.batchNumber}</span> · {batch.description} · {batch.cardCount} registered,{" "}
                {batch.sold} sold, {batch.inStock} unsold, {batch.deactivated} deactivated
              </span>
              <StockBatchCards batch={batch} onChanged={action.refresh} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function GiftCardWorkspace({
  program,
  abilities,
  drawers,
  drawerRequired,
  recent,
  stockBatches = [],
}: {
  program: GiftCardProgramView;
  abilities: GiftCardAbilities;
  drawers: { id: string; label: string }[];
  drawerRequired: boolean;
  recent: GiftCardView[];
  stockBatches?: StockBatchView[];
}) {
  const lookup = useAction();
  const [code, setCode] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [history, setHistory] = useState<GiftCardHistory | null>(null);

  async function load(cardId: string) {
    const result = await lookup.run<GiftCardHistory>("GET", `/api/gift-cards/${cardId}`);

    if (result.ok) {
      setHistory(result.data);
    }
  }

  async function find(event: FormEvent, by: "code" | "number") {
    event.preventDefault();
    setHistory(null);

    const result = await lookup.run<GiftCardView>(
      "POST",
      "/api/gift-cards/lookup",
      by === "code" ? { code } : { cardNumber },
    );

    if (result.ok) {
      setCode("");
      await load(result.data.id);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="grid content-start gap-6">
        {program.enabled && abilities.sell && (
          <SellForm abilities={abilities} drawers={drawers} drawerRequired={drawerRequired} maxBalance={program.maxBalance} />
        )}
        <Card aria-label="Look up a gift card">
          <CardTitle>Look up a card</CardTitle>
          <form onSubmit={(event) => find(event, "code")} className="grid gap-2">
            <label className={LABEL}>
              Card code
              <input
                className={INPUT}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX-XXXX"
              />
            </label>
            <button type="submit" className={BUTTON} disabled={lookup.pending || !code.trim()}>
              Check balance
            </button>
          </form>
          {abilities.manage && (
            <form onSubmit={(event) => find(event, "number")} className="mt-3 grid gap-2">
              <label className={LABEL}>
                Card number (from the receipt)
                <input className={INPUT} value={cardNumber} onChange={(event) => setCardNumber(event.target.value)} required maxLength={20} placeholder="GC-000123" />
              </label>
              <button type="submit" className={BUTTON} disabled={lookup.pending || !cardNumber.trim()}>
                Find by number
              </button>
            </form>
          )}
          <ApiErrorMessage error={lookup.error} className="mt-2 flex" />
        </Card>
        {abilities.manage && <ProgramForm program={program} />}
        {abilities.manage && program.enabled && <CardStockPanel batches={stockBatches} />}
      </div>
      <div className="grid content-start gap-6">
        {history && (
          <CardDetail
            key={`${history.card.id}-${history.card.version}`}
            history={history}
            canManage={abilities.manage}
            canViewPurchaser={abilities.purchaserView}
            drawers={drawers}
            drawerRequired={drawerRequired}
            onReload={() => load(history.card.id)}
          />
        )}
        {abilities.manage && recent.length > 0 && (
          <Card aria-label="Recent cards">
            <CardTitle>Recent cards</CardTitle>
            <ul className="grid gap-1 text-sm">
              {recent.map((card) => (
                <li key={card.id} className="flex flex-wrap items-center justify-between gap-2">
                  <button type="button" className="underline" onClick={() => load(card.id)}>
                    {card.cardNumber}
                  </button>
                  <span className="tabular">
                    {formatMoney(card.balance)} {card.status === "INACTIVE" ? "· inactive" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
