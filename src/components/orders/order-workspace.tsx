"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import type { OperationalMenuItem } from "@/modules/menu/queries/operational-menu";
import type { OrderDetail } from "@/modules/orders/queries/order-queries";

import { callOrderApi, formatMoney, newIdempotencyKey, ORDER_TYPE_LABELS } from "./order-api";

// The order screen. It shows what the server returns and sends what staff choose; every
// rule (sellability, modifier limits, prices, stock, permissions) is decided on the server.

export type WorkspaceAbilities = {
  edit: boolean;
  submit: boolean;
  void: boolean;
  discount: boolean;
};

export type MenuCategory = { id: string; name: string; items: OperationalMenuItem[] };

export type DiscountChoice = {
  id: string;
  name: string;
  scope: string;
  discountType: string;
  value: string;
};

type Props = {
  order: OrderDetail;
  categories: MenuCategory[];
  abilities: WorkspaceAbilities;
  discounts: DiscountChoice[];
};

const BUTTON = "min-h-11 rounded border border-neutral-400 px-3 text-sm font-medium disabled:opacity-50";
const PRIMARY = "min-h-11 rounded bg-neutral-900 px-4 font-medium text-white disabled:opacity-50";
const INPUT = "min-h-11 rounded border border-neutral-400 px-3";

function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
    setPending(true);
    setError(null);

    const result = await callOrderApi(method, url, body, headers);

    setPending(false);

    if (result.ok) {
      router.refresh();

      return result;
    }

    if (result.status === 401) {
      router.push("/login");
    } else {
      const shortages = (result.details as { shortages?: { inventoryItemName: string; shortage: string }[] } | undefined)
        ?.shortages;

      setError(
        shortages?.length
          ? `${result.message} Short: ${shortages.map((entry) => `${entry.inventoryItemName} (${entry.shortage})`).join(", ")}.`
          : result.message,
      );
    }

    return result;
  }

  return { run, pending, error };
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-red-700">
      {error}
    </p>
  ) : null;
}

function ModifierLines({ item }: { item: OrderDetail["items"][number] }) {
  return (
    <>
      {item.modifiers.length > 0 && (
        <p className="text-sm text-neutral-700">
          {item.modifiers
            .map((modifier) =>
              modifier.priceAdjustment === "0.00" ? modifier.name : `${modifier.name} (+${formatMoney(modifier.priceAdjustment)})`,
            )
            .join(", ")}
        </p>
      )}
      {item.specialInstructions && <p className="text-sm italic">“{item.specialInstructions}”</p>}
    </>
  );
}

function ItemPicker({
  orderId,
  version,
  item,
  onDone,
}: {
  orderId: string;
  version: number;
  item: OperationalMenuItem;
  onDone: () => void;
}) {
  const { run, pending, error } = useAction();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [instructions, setInstructions] = useState("");

  function toggle(groupId: string, modifierId: string, single: boolean) {
    setChosen((current) => {
      const now = current[groupId] ?? [];

      if (single) {
        return { ...current, [groupId]: now.includes(modifierId) ? [] : [modifierId] };
      }

      return {
        ...current,
        [groupId]: now.includes(modifierId) ? now.filter((id) => id !== modifierId) : [...now, modifierId],
      };
    });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const result = await run("POST", `/api/orders/${orderId}/items`, {
      expectedVersion: version,
      menuItemId: item.menuItemId,
      quantity,
      selections: Object.entries(chosen).flatMap(([modifierGroupId, ids]) =>
        ids.map((modifierId) => ({ modifierGroupId, modifierId })),
      ),
      specialInstructions: instructions.trim() || null,
    });

    if (result.ok) {
      onDone();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={`Add ${item.name}`}
      className="grid gap-4 rounded border-2 border-neutral-900 p-4"
    >
      <p className="flex justify-between font-semibold">
        <span>{item.name}</span>
        <span>{formatMoney(item.price)}</span>
      </p>
      {item.modifierGroups.map((group) => {
        const single = group.maximumSelections === 1;

        return (
          <fieldset key={group.id} className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold">
              {group.name}
              {group.minimumSelections > 0 ? " (required)" : ""}
              {group.maximumSelections && group.maximumSelections > 1 ? ` · up to ${group.maximumSelections}` : ""}
            </legend>
            {group.modifiers.map((modifier) => (
              <label key={modifier.id} className="flex min-h-11 items-center gap-3 rounded border border-neutral-300 px-3">
                <input
                  type={single ? "radio" : "checkbox"}
                  name={group.id}
                  checked={(chosen[group.id] ?? []).includes(modifier.id)}
                  onChange={() => toggle(group.id, modifier.id, single)}
                  className="h-5 w-5"
                />
                <span className="flex-1">{modifier.name}</span>
                {modifier.priceAdjustment !== "0.00" && (
                  <span className="text-sm">+{formatMoney(modifier.priceAdjustment)}</span>
                )}
              </label>
            ))}
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm font-medium">
          Quantity
          <input
            type="number"
            min={1}
            max={99}
            value={quantity}
            onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))}
            className={`${INPUT} w-24`}
          />
        </label>
        <label className="grid flex-1 gap-1 text-sm font-medium">
          Special instructions
          <input
            value={instructions}
            maxLength={500}
            onChange={(event) => setInstructions(event.target.value)}
            className={INPUT}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={PRIMARY}>
          Add to order
        </button>
        <button type="button" onClick={onDone} className={BUTTON}>
          Cancel
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

function MenuBrowser({ order, categories }: { order: OrderDetail; categories: MenuCategory[] }) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [picking, setPicking] = useState<OperationalMenuItem | null>(null);
  const category = categories.find((entry) => entry.id === categoryId);

  if (categories.length === 0) {
    return <p className="text-neutral-600">Nothing is on the menu right now.</p>;
  }

  return (
    <section aria-label="Menu" className="grid gap-3">
      <h2 className="text-xl font-semibold">Menu</h2>
      <div role="tablist" className="flex flex-wrap gap-2">
        {categories.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === categoryId}
            onClick={() => {
              setCategoryId(entry.id);
              setPicking(null);
            }}
            className={`${BUTTON} ${entry.id === categoryId ? "bg-neutral-900 text-white" : ""}`}
          >
            {entry.name}
          </button>
        ))}
      </div>
      {picking ? (
        <ItemPicker orderId={order.id} version={order.version} item={picking} onDone={() => setPicking(null)} />
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {category?.items.map((item) => (
            <li key={item.placementId}>
              <button
                type="button"
                onClick={() => setPicking(item)}
                className="min-h-16 w-full rounded border border-neutral-300 p-3 text-left hover:border-neutral-900"
              >
                <span className="block font-medium">{item.name}</span>
                <span className="text-sm">{formatMoney(item.price)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DraftLine({ order, item, canEdit }: { order: OrderDetail; item: OrderDetail["items"][number]; canEdit: boolean }) {
  const { run, pending, error } = useAction();
  const base = `/api/orders/${order.id}/items/${item.id}`;
  const selections = item.modifiers.map((modifier) => ({
    modifierGroupId: modifier.modifierGroupId,
    modifierId: modifier.modifierId,
  }));
  const setQuantity = (quantity: number) =>
    run("PATCH", base, {
      expectedVersion: order.version,
      quantity,
      selections,
      specialInstructions: item.specialInstructions,
    });

  return (
    <li aria-label={`Unsent ${item.name}`} className="rounded border border-dashed border-neutral-500 p-3">
      <p className="flex justify-between font-medium">
        <span>
          {item.quantity} × {item.name}
        </span>
        <span>{formatMoney(item.lineTotal)}</span>
      </p>
      <ModifierLines item={item} />
      <p className="text-xs uppercase tracking-wide text-neutral-600">Not sent · price shown is today&apos;s</p>
      {canEdit && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={pending || item.quantity <= 1} onClick={() => setQuantity(item.quantity - 1)} className={BUTTON} aria-label={`One fewer ${item.name}`}>
            −
          </button>
          <button type="button" disabled={pending || item.quantity >= 99} onClick={() => setQuantity(item.quantity + 1)} className={BUTTON} aria-label={`One more ${item.name}`}>
            +
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run("DELETE", base, { expectedVersion: order.version })}
            className={BUTTON}
          >
            Remove
          </button>
        </div>
      )}
      <ErrorText error={error} />
    </li>
  );
}

function VoidItemForm({ order, item }: { order: OrderDetail; item: OrderDetail["items"][number] }) {
  const { run, pending, error } = useAction();
  const [reason, setReason] = useState("");
  const [disposition, setDisposition] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await run("POST", `/api/orders/${order.id}/items/${item.id}/void`, {
      expectedVersion: order.version,
      reason,
      disposition,
    });
  }

  return (
    <details className="mt-2">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Void item</summary>
      <form onSubmit={handleSubmit} aria-label={`Void ${item.name}`} className="grid gap-2">
        <label className="grid gap-1 text-sm font-medium">
          Reason
          <input value={reason} required maxLength={300} onChange={(event) => setReason(event.target.value)} className={INPUT} />
        </label>
        <fieldset className="grid gap-1 text-sm">
          <legend className="font-medium">Was it prepared?</legend>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name={`disposition-${item.id}`} checked={disposition === "UNPREPARED"} onChange={() => setDisposition("UNPREPARED")} />
            Not prepared (return stock)
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name={`disposition-${item.id}`}
              checked={disposition === "PREPARED_OR_DISCARDED"}
              onChange={() => setDisposition("PREPARED_OR_DISCARDED")}
            />
            Prepared or discarded (stock stays used)
          </label>
        </fieldset>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          I confirm this void
        </label>
        <button type="submit" disabled={pending || !confirmed || !disposition || !reason.trim()} className={BUTTON}>
          Void {item.name}
        </button>
        <ErrorText error={error} />
      </form>
    </details>
  );
}

function SentLine({
  order,
  item,
  abilities,
  discounts,
}: {
  order: OrderDetail;
  item: OrderDetail["items"][number];
  abilities: WorkspaceAbilities;
  discounts: DiscountChoice[];
}) {
  const voided = item.status === "VOIDED";
  const itemDiscounts = discounts.filter((entry) => entry.scope === "ITEM");

  return (
    <li
      aria-label={`${voided ? "Voided" : "Sent"} ${item.name}`}
      className={`rounded border p-3 ${voided ? "border-neutral-300 bg-neutral-100 text-neutral-500" : "border-neutral-400"}`}
    >
      <p className="flex justify-between font-medium">
        <span className={voided ? "line-through" : ""}>
          {item.quantity} × {item.name}
        </span>
        <span className={voided ? "line-through" : ""}>{formatMoney(item.lineTotal)}</span>
      </p>
      <ModifierLines item={item} />
      <p className="text-xs uppercase tracking-wide">
        {voided
          ? `Voided${item.voidDisposition === "UNPREPARED" ? " · not prepared" : " · prepared or discarded"} · ${item.voidReason}`
          : `Sent in round ${item.batchNumber}`}
      </p>
      {item.discounts
        .filter((entry) => entry.status === "APPLIED")
        .map((entry) => (
          <AppliedDiscountLine key={entry.id} order={order} discount={entry} canRemove={abilities.discount} />
        ))}
      {!voided && order.status === "OPEN" && abilities.discount && itemDiscounts.length > 0 && (
        <ApplyDiscountForm order={order} choices={itemDiscounts} url={`/api/orders/${order.id}/items/${item.id}/discounts`} label={`Discount ${item.name}`} />
      )}
      {!voided && order.status === "OPEN" && abilities.void && <VoidItemForm order={order} item={item} />}
    </li>
  );
}

function ApplyDiscountForm({ order, choices, url, label }: { order: OrderDetail; choices: DiscountChoice[]; url: string; label: string }) {
  const { run, pending, error } = useAction();
  const [definitionId, setDefinitionId] = useState(choices[0]?.id ?? "");
  const [reason, setReason] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await run("POST", url, { expectedVersion: order.version, discountDefinitionId: definitionId, reason });
  }

  return (
    <details className="mt-2">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{label}</summary>
      <form onSubmit={handleSubmit} aria-label={label} className="grid gap-2">
        <label className="grid gap-1 text-sm font-medium">
          Discount
          <select value={definitionId} onChange={(event) => setDefinitionId(event.target.value)} className={INPUT}>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name} ({choice.discountType === "PERCENTAGE" ? `${choice.value}%` : formatMoney(choice.value)})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Reason
          <input value={reason} required maxLength={300} onChange={(event) => setReason(event.target.value)} className={INPUT} />
        </label>
        <button type="submit" disabled={pending || !reason.trim()} className={BUTTON}>
          Apply discount
        </button>
        <ErrorText error={error} />
      </form>
    </details>
  );
}

function AppliedDiscountLine({
  order,
  discount,
  canRemove,
}: {
  order: OrderDetail;
  discount: OrderDetail["discounts"][number];
  canRemove: boolean;
}) {
  const { run, pending, error } = useAction();
  const [reason, setReason] = useState("");

  return (
    <div className="mt-1 text-sm">
      <p className="flex justify-between">
        <span>
          {discount.isComp ? "Comp" : "Discount"}: {discount.name} · {discount.reason}
        </span>
        <span>−{formatMoney(discount.appliedAmount)}</span>
      </p>
      {canRemove && order.status === "OPEN" && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 font-medium">Remove discount</summary>
          <div className="flex flex-wrap gap-2">
            <input
              aria-label="Reason for removing"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className={INPUT}
            />
            <button
              type="button"
              disabled={pending || !reason.trim()}
              onClick={() =>
                run("POST", `/api/orders/${order.id}/discounts/${discount.id}/remove`, {
                  expectedVersion: order.version,
                  reason,
                })
              }
              className={BUTTON}
            >
              Remove
            </button>
          </div>
          <ErrorText error={error} />
        </details>
      )}
    </div>
  );
}

function SendButton({ order, draftCount }: { order: OrderDetail; draftCount: number }) {
  const { run, pending, error } = useAction();
  // One key per attempt at this order version, reused if a retry is needed, so a lost
  // response or a double tap can never send twice.
  const attempt = useRef<{ version: number; key: string } | null>(null);

  async function send() {
    if (attempt.current?.version !== order.version) {
      attempt.current = { version: order.version, key: newIdempotencyKey() };
    }

    await run(
      "POST",
      `/api/orders/${order.id}/send`,
      { expectedVersion: order.version },
      { "Idempotency-Key": attempt.current.key },
    );
  }

  return (
    <div className="grid gap-2">
      <button type="button" onClick={send} disabled={pending || draftCount === 0} className={PRIMARY}>
        {pending ? "Sending…" : `Send ${draftCount} ${draftCount === 1 ? "item" : "items"}`}
      </button>
      <ErrorText error={error} />
    </div>
  );
}

function VoidOrderForm({ order }: { order: OrderDetail }) {
  const { run, pending, error } = useAction();
  const sent = order.items.filter((item) => item.status === "SUBMITTED");
  const [reason, setReason] = useState("");
  const [dispositions, setDispositions] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const complete = sent.every((item) => dispositions[item.id]);

  return (
    <details className="rounded border border-red-300 p-3">
      <summary className="min-h-11 cursor-pointer py-2 font-medium text-red-800">Void whole order</summary>
      <form
        aria-label="Void whole order"
        className="grid gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          await run("POST", `/api/orders/${order.id}/void`, { expectedVersion: order.version, reason, dispositions });
        }}
      >
        <label className="grid gap-1 text-sm font-medium">
          Reason
          <input value={reason} required maxLength={300} onChange={(event) => setReason(event.target.value)} className={INPUT} />
        </label>
        {sent.map((item) => (
          <label key={item.id} className="grid gap-1 text-sm">
            {item.quantity} × {item.name}
            <select
              value={dispositions[item.id] ?? ""}
              onChange={(event) => setDispositions((current) => ({ ...current, [item.id]: event.target.value }))}
              className={INPUT}
            >
              <option value="">Was it prepared?</option>
              <option value="UNPREPARED">Not prepared (return stock)</option>
              <option value="PREPARED_OR_DISCARDED">Prepared or discarded</option>
            </select>
          </label>
        ))}
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          I confirm voiding this order
        </label>
        <button type="submit" disabled={pending || !confirmed || !complete || !reason.trim()} className={BUTTON}>
          Void order
        </button>
        <ErrorText error={error} />
      </form>
    </details>
  );
}

export function OrderWorkspace({ order, categories, abilities, discounts }: Props) {
  const open = order.status === "OPEN";
  const drafts = order.items.filter((item) => item.status === "DRAFT");
  const sent = order.items.filter((item) => item.status !== "DRAFT");
  const orderDiscounts = discounts.filter((entry) => entry.scope === "ORDER");
  const appliedOrderDiscounts = order.discounts.filter((entry) => entry.status === "APPLIED");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <div className="order-2 lg:order-1">
        {open && abilities.edit ? (
          <MenuBrowser order={order} categories={categories} />
        ) : (
          !open && (
            <p role="status" className="rounded bg-neutral-100 p-3">
              This order is {order.status.toLowerCase()}
              {order.voidReason ? `: ${order.voidReason}` : ""}.
            </p>
          )
        )}
      </div>
      <aside aria-label="Check" className="order-1 grid content-start gap-4 lg:order-2">
        <div>
          <h1 className="text-2xl font-semibold">Order #{order.orderNumber}</h1>
          <p className="text-neutral-600">
            {ORDER_TYPE_LABELS[order.orderType]}
            {order.tableNumbers.length > 0 ? ` · Table ${order.tableNumbers.join(" + ")}` : ""}
            {order.customerName ? ` · ${order.customerName}` : ""} · {order.status}
          </p>
        </div>

        <section aria-label="Unsent items" className="grid gap-2">
          <h2 className="font-semibold">Unsent ({drafts.length})</h2>
          {drafts.length === 0 && <p className="text-sm text-neutral-600">Nothing waiting to send.</p>}
          <ul className="grid gap-2">
            {drafts.map((item) => (
              <DraftLine key={item.id} order={order} item={item} canEdit={open && abilities.edit} />
            ))}
          </ul>
          {open && abilities.submit && <SendButton order={order} draftCount={drafts.length} />}
        </section>

        <section aria-label="Sent items" className="grid gap-2">
          <h2 className="font-semibold">Sent</h2>
          {sent.length === 0 && <p className="text-sm text-neutral-600">Nothing sent yet.</p>}
          <ul className="grid gap-2">
            {sent.map((item) => (
              <SentLine key={item.id} order={order} item={item} abilities={abilities} discounts={discounts} />
            ))}
          </ul>
        </section>

        <section aria-label="Totals" className="grid gap-1 border-t border-neutral-300 pt-3">
          <p className="flex justify-between">
            <span>Items sent</span>
            <span>{formatMoney(order.itemSubtotal)}</span>
          </p>
          {appliedOrderDiscounts.map((entry) => (
            <AppliedDiscountLine key={entry.id} order={order} discount={entry} canRemove={abilities.discount} />
          ))}
          {order.discountTotal !== "0.00" && (
            <p className="flex justify-between text-sm">
              <span>All discounts</span>
              <span>−{formatMoney(order.discountTotal)}</span>
            </p>
          )}
          <p className="flex justify-between text-lg font-semibold">
            <span>Total before tax</span>
            <span aria-label="Order total">{formatMoney(order.subtotal)}</span>
          </p>
          {open && abilities.discount && orderDiscounts.length > 0 && order.itemSubtotal !== "0.00" && (
            <ApplyDiscountForm order={order} choices={orderDiscounts} url={`/api/orders/${order.id}/discounts`} label="Discount the order" />
          )}
        </section>

        {open && abilities.void && <VoidOrderForm order={order} />}
      </aside>
    </div>
  );
}
