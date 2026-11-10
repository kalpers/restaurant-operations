"use client";

import { Search, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { StatusBadge } from "@/components/format/status-badge";
import { useRealtimeRefresh } from "@/components/realtime/realtime-provider";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { OrderItemFulfillment } from "@/modules/kitchen/queries/kitchen-queries";
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
  remake: boolean;
  /** `settlements.view`: the link to the settlement screen. */
  settle: boolean;
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
  /** Kitchen/Bar fulfillment per sent Order Item, keyed by its ID. */
  fulfillment: Record<string, OrderItemFulfillment>;
};

type ActionError = { code: string; message: string; requestId?: string };

function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);

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

      setError({
        code: result.code,
        requestId: result.requestId,
        message: shortages?.length
          ? `${result.message} Short: ${shortages.map((entry) => `${entry.inventoryItemName} (${entry.shortage})`).join(", ")}.`
          : result.message,
      });
    }

    return result;
  }

  return { run, pending, error, clearError: () => setError(null) };
}

function ErrorText({ error }: { error: ActionError | null }) {
  return error ? <ApiErrorMessage error={error} className="flex" /> : null;
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
      className="grid gap-4 rounded-lg border-2 border-brand-600 bg-surface p-4 shadow-sm"
    >
      <p className="flex justify-between text-lg font-semibold">
        <span>{item.name}</span>
        <span className="tabular">{formatMoney(item.price)}</span>
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
            <div className="grid gap-2 sm:grid-cols-2">
              {group.modifiers.map((modifier) => {
                const checked = (chosen[group.id] ?? []).includes(modifier.id);

                return (
                  <label
                    key={modifier.id}
                    className={cn(
                      "flex min-h-12 items-center gap-3 rounded-md border px-3",
                      checked ? "border-brand-600 bg-brand-50" : "border-neutral-300 bg-white",
                    )}
                  >
                    <input
                      type={single ? "radio" : "checkbox"}
                      name={group.id}
                      checked={checked}
                      onChange={() => toggle(group.id, modifier.id, single)}
                      className="size-5 accent-brand-700"
                    />
                    <span className="flex-1">{modifier.name}</span>
                    {modifier.priceAdjustment !== "0.00" && (
                      <span className="tabular text-sm">+{formatMoney(modifier.priceAdjustment)}</span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Quantity">
          <Input
            type="number"
            min={1}
            max={99}
            value={quantity}
            onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))}
            className="w-24"
          />
        </Field>
        <Field label="Special instructions" className="flex-1">
          <Input value={instructions} maxLength={500} onChange={(event) => setInstructions(event.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" pending={pending}>
          Add to order
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

/** True when a key press is typing into a field, so shortcuts stay out of the way. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function MenuBrowser({ order, categories }: { order: OrderDetail; categories: MenuCategory[] }) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [picking, setPicking] = useState<OperationalMenuItem | null>(null);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const category = categories.find((entry) => entry.id === categoryId);
  const needle = query.trim().toLowerCase();
  // Filters only the items already on screen; it asks the server for nothing.
  const shown = needle
    ? categories.flatMap((entry) => entry.items.filter((item) => item.name.toLowerCase().includes(needle)))
    : (category?.items ?? []);

  // "/" jumps to the search box, unless the user is typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isTyping(event.target)) {
        event.preventDefault();
        search.current?.focus();
      }
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (categories.length === 0) {
    return <EmptyState title="Nothing is on the menu right now">Ask a manager to offer a menu at this location.</EmptyState>;
  }

  return (
    <section aria-label="Menu" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Menu</h2>
        <label className="relative w-full sm:w-72">
          <span className="sr-only">Search the menu</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-500" />
          <Input
            ref={search}
            type="search"
            value={query}
            placeholder="Search the menu"
            aria-keyshortcuts="/"
            onChange={(event) => {
              setQuery(event.target.value);
              setPicking(null);
            }}
            className="pl-9"
          />
          <kbd aria-hidden className="absolute top-1/2 right-3 hidden -translate-y-1/2 rounded-md border border-neutral-300 px-1.5 text-xs text-neutral-600 sm:block">
            /
          </kbd>
        </label>
      </div>
      {!needle && (
        <div role="tablist" aria-label="Menu categories" className="flex gap-2 overflow-x-auto pb-1">
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
              className={cn(
                "min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium",
                entry.id === categoryId
                  ? "border-brand-700 bg-brand-700 text-white"
                  : "border-neutral-300 bg-white hover:bg-neutral-50",
              )}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
      {picking ? (
        <ItemPicker orderId={order.id} version={order.version} item={picking} onDone={() => setPicking(null)} />
      ) : shown.length === 0 ? (
        <EmptyState icon={Search} title={`Nothing matches “${query.trim()}”`}>
          Try another name, or clear the search to browse by category.
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {shown.map((item) => (
            <li key={item.placementId}>
              <button
                type="button"
                onClick={() => setPicking(item)}
                className="min-h-20 w-full rounded-lg border border-neutral-200 bg-surface p-3 text-left shadow-sm hover:border-brand-600 hover:bg-brand-50"
              >
                <span className="block font-medium">{item.name}</span>
                <span className="tabular text-sm text-neutral-700">{formatMoney(item.price)}</span>
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
    <li aria-label={`Unsent ${item.name}`} className="rounded-md border border-dashed border-warning-500 bg-warning-50 p-3">
      <p className="flex justify-between font-medium">
        <span>
          {item.quantity} × {item.name}
        </span>
        <span className="tabular">{formatMoney(item.lineTotal)}</span>
      </p>
      <ModifierLines item={item} />
      <p className="text-xs font-medium tracking-wide text-warning-900 uppercase">Not sent · price shown is today&apos;s</p>
      {canEdit && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button disabled={pending || item.quantity <= 1} onClick={() => setQuantity(item.quantity - 1)} aria-label={`One fewer ${item.name}`}>
            −
          </Button>
          <Button disabled={pending || item.quantity >= 99} onClick={() => setQuantity(item.quantity + 1)} aria-label={`One more ${item.name}`}>
            +
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => run("DELETE", base, { expectedVersion: order.version })}>
            Remove
          </Button>
        </div>
      )}
      <ErrorText error={error} />
    </li>
  );
}

/** A button that opens a dialog holding a form; the dialog closes when the form succeeds. */
function DialogAction({
  label,
  title,
  description,
  danger = false,
  children,
}: {
  label: string;
  title: string;
  description?: ReactNode;
  danger?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} className={cn("mt-1 px-2", danger && "text-danger-700")}>
        {label}
      </Button>
      <Dialog open={open} onClose={close} title={title} description={description}>
        {open && children(close)}
      </Dialog>
    </>
  );
}

function VoidItemForm({ order, item, onDone }: { order: OrderDetail; item: OrderDetail["items"][number]; onDone: () => void }) {
  const { run, pending, error } = useAction();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [disposition, setDisposition] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const result = await run("POST", `/api/orders/${order.id}/items/${item.id}/void`, {
      expectedVersion: order.version,
      reason,
      disposition,
    });

    if (result.ok) {
      toast.success(`${item.name} voided.`);
      onDone();
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label={`Void ${item.name}`} className="grid gap-3">
      <Field label="Reason">
        <Input value={reason} required maxLength={300} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <fieldset className="grid gap-1 text-sm">
        <legend className="font-medium">Was it prepared?</legend>
        <label className="flex min-h-11 items-center gap-2">
          <input type="radio" className="size-5 accent-brand-700" name={`disposition-${item.id}`} checked={disposition === "UNPREPARED"} onChange={() => setDisposition("UNPREPARED")} />
          Not prepared (return stock)
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="radio"
            className="size-5 accent-brand-700"
            name={`disposition-${item.id}`}
            checked={disposition === "PREPARED_OR_DISCARDED"}
            onChange={() => setDisposition("PREPARED_OR_DISCARDED")}
          />
          Prepared or discarded (stock stays used)
        </label>
      </fieldset>
      <Checkbox label="I confirm this void" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone}>Keep it</Button>
        <Button type="submit" variant="danger" pending={pending} disabled={!confirmed || !disposition || !reason.trim()}>
          Void {item.name}
        </Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

function RemakeForm({ order, item }: { order: OrderDetail; item: OrderDetail["items"][number] }) {
  const { run, pending, error } = useAction();
  const [reason, setReason] = useState("");
  // One key per remake attempt, kept across retries of that attempt.
  const key = useRef<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    key.current ??= `remake-${crypto.randomUUID()}`;

    const result = await run("POST", `/api/orders/${order.id}/items/${item.id}/remake`, { reason }, {
      "Idempotency-Key": key.current,
    });

    if (result.ok || (result.status >= 400 && result.status < 500)) {
      key.current = null;
    }

    if (result.ok) {
      setReason("");
    }
  }

  return (
    <details className="mt-2">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Remake</summary>
      <form onSubmit={handleSubmit} aria-label={`Remake ${item.name}`} className="grid gap-2">
        <p className="text-xs text-neutral-600">
          Sends it to the same stations again and uses the ingredients again. The guest isn&apos;t charged.
        </p>
        <Field label="Reason">
          <Input value={reason} required maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <Button type="submit" pending={pending} disabled={!reason.trim()}>
          Remake {item.name}
        </Button>
        <ErrorText error={error} />
      </form>
    </details>
  );
}

function FulfillmentLine({ fulfillment }: { fulfillment: OrderItemFulfillment | undefined }) {
  if (!fulfillment) {
    return null;
  }

  return (
    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs" data-testid="fulfillment-status">
      Kitchen/Bar: <StatusBadge domain="fulfillment" status={fulfillment.status} />
      {fulfillment.attempts > 1 && <span>remade {fulfillment.attempts - 1}×</span>}
      <span className="text-neutral-600">{[...new Set(fulfillment.stations.map((station) => station.code))].join(", ")}</span>
    </p>
  );
}

function SentLine({
  order,
  item,
  abilities,
  discounts,
  fulfillment,
}: {
  order: OrderDetail;
  item: OrderDetail["items"][number];
  abilities: WorkspaceAbilities;
  discounts: DiscountChoice[];
  fulfillment: OrderItemFulfillment | undefined;
}) {
  const voided = item.status === "VOIDED";
  const itemDiscounts = discounts.filter((entry) => entry.scope === "ITEM");

  return (
    <li
      aria-label={`${voided ? "Voided" : "Sent"} ${item.name}`}
      className={cn(
        "rounded-md border p-3",
        voided ? "border-neutral-300 bg-neutral-100 text-neutral-600" : "border-neutral-200 bg-surface",
      )}
    >
      <p className="flex justify-between font-medium">
        <span className={voided ? "line-through" : ""}>
          {item.quantity} × {item.name}
        </span>
        <span className={cn("tabular", voided && "line-through")}>{formatMoney(item.lineTotal)}</span>
      </p>
      <ModifierLines item={item} />
      <p className="text-xs tracking-wide uppercase">
        {voided
          ? `Voided${item.voidDisposition === "UNPREPARED" ? " · not prepared" : " · prepared or discarded"} · ${item.voidReason}`
          : `Sent in round ${item.batchNumber}`}
      </p>
      <FulfillmentLine fulfillment={fulfillment} />
      {item.discounts
        .filter((entry) => entry.status === "APPLIED")
        .map((entry) => (
          <AppliedDiscountLine key={entry.id} order={order} discount={entry} canRemove={abilities.discount} />
        ))}
      {!voided && order.status === "OPEN" && abilities.discount && itemDiscounts.length > 0 && (
        <ApplyDiscountForm order={order} choices={itemDiscounts} url={`/api/orders/${order.id}/items/${item.id}/discounts`} label={`Discount ${item.name}`} />
      )}
      {!voided && order.status === "OPEN" && abilities.remake && fulfillment && <RemakeForm order={order} item={item} />}
      {!voided && order.status === "OPEN" && abilities.void && (
        <DialogAction
          label="Void item"
          title={`Void ${item.name}?`}
          description="The item stays on the check, struck through. Stock is returned only if it was never prepared."
          danger
        >
          {(close) => <VoidItemForm order={order} item={item} onDone={close} />}
        </DialogAction>
      )}
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
        <Field label="Discount">
          <Select value={definitionId} onChange={(event) => setDefinitionId(event.target.value)}>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name} ({choice.discountType === "PERCENTAGE" ? `${choice.value}%` : formatMoney(choice.value)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason">
          <Input value={reason} required maxLength={300} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <Button type="submit" pending={pending} disabled={!reason.trim()}>
          Apply discount
        </Button>
        <ErrorText error={error} />
      </form>
    </details>
  );
}

function RemoveDiscountForm({ order, discount, onDone }: { order: OrderDetail; discount: OrderDetail["discounts"][number]; onDone: () => void }) {
  const { run, pending, error } = useAction();
  const [reason, setReason] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const result = await run("POST", `/api/orders/${order.id}/discounts/${discount.id}/remove`, {
      expectedVersion: order.version,
      reason,
    });

    if (result.ok) {
      onDone();
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label={`Remove ${discount.name}`} className="grid gap-3">
      <Field label="Reason for removing">
        <Input value={reason} required maxLength={300} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone}>Keep it</Button>
        <Button type="submit" variant="danger" pending={pending} disabled={!reason.trim()}>
          Remove
        </Button>
      </div>
      <ErrorText error={error} />
    </form>
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
  return (
    <div className="mt-1 text-sm">
      <p className="flex justify-between gap-2">
        <span>
          {discount.isComp ? "Comp" : "Discount"}: {discount.name} · {discount.reason}
        </span>
        <span className="tabular">−{formatMoney(discount.appliedAmount)}</span>
      </p>
      {canRemove && order.status === "OPEN" && (
        <DialogAction
          label="Remove discount"
          title={`Remove ${discount.name}?`}
          description="The check total goes back up by this amount."
          danger
        >
          {(close) => <RemoveDiscountForm order={order} discount={discount} onDone={close} />}
        </DialogAction>
      )}
    </div>
  );
}

function SendButton({ order, draftCount }: { order: OrderDetail; draftCount: number }) {
  const { run, pending, error } = useAction();
  const toast = useToast();
  // One key per attempt at this order version, reused if a retry is needed, so a lost
  // response or a double tap can never send twice.
  const attempt = useRef<{ version: number; key: string } | null>(null);

  async function send() {
    if (attempt.current?.version !== order.version) {
      attempt.current = { version: order.version, key: newIdempotencyKey() };
    }

    const result = await run(
      "POST",
      `/api/orders/${order.id}/send`,
      { expectedVersion: order.version },
      { "Idempotency-Key": attempt.current.key },
    );

    if (result.ok) {
      toast.success(`Sent ${draftCount} ${draftCount === 1 ? "item" : "items"}.`);
    }
  }

  return (
    <div className="grid gap-2">
      <Button variant="primary" size="lg" onClick={send} disabled={pending || draftCount === 0} className="w-full">
        <Send aria-hidden className="size-5" />
        {pending ? "Sending…" : `Send ${draftCount} ${draftCount === 1 ? "item" : "items"}`}
      </Button>
      <ErrorText error={error} />
    </div>
  );
}

function VoidOrderForm({ order, onDone }: { order: OrderDetail; onDone: () => void }) {
  const { run, pending, error } = useAction();
  const sent = order.items.filter((item) => item.status === "SUBMITTED");
  const [reason, setReason] = useState("");
  const [dispositions, setDispositions] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const complete = sent.every((item) => dispositions[item.id]);

  return (
    <form
      aria-label="Void whole order"
      className="grid gap-3"
      onSubmit={async (event) => {
        event.preventDefault();

        const result = await run("POST", `/api/orders/${order.id}/void`, { expectedVersion: order.version, reason, dispositions });

        if (result.ok) {
          onDone();
        }
      }}
    >
      <Field label="Reason">
        <Input value={reason} required maxLength={300} onChange={(event) => setReason(event.target.value)} />
      </Field>
      {sent.map((item) => (
        <Field key={item.id} label={`${item.quantity} × ${item.name}`}>
          <Select
            value={dispositions[item.id] ?? ""}
            onChange={(event) => setDispositions((current) => ({ ...current, [item.id]: event.target.value }))}
          >
            <option value="">Was it prepared?</option>
            <option value="UNPREPARED">Not prepared (return stock)</option>
            <option value="PREPARED_OR_DISCARDED">Prepared or discarded</option>
          </Select>
        </Field>
      ))}
      <Checkbox label="I confirm voiding this order" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone}>Keep order</Button>
        <Button type="submit" variant="danger" pending={pending} disabled={!confirmed || !complete || !reason.trim()}>
          Void order
        </Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

const FULFILLMENT_EVENTS = [
  "kitchen.ticket-created",
  "kitchen.item-status-changed",
  "kitchen.item-ready",
  "settlement.opened",
  "settlement.cancelled",
  "order.closed",
];

export function OrderWorkspace({ order, categories, abilities, discounts, fulfillment }: Props) {
  useRealtimeRefresh(FULFILLMENT_EVENTS, 60_000);
  const open = order.status === "OPEN";
  const drafts = order.items.filter((item) => item.status === "DRAFT");
  const sent = order.items.filter((item) => item.status !== "DRAFT");
  const orderDiscounts = discounts.filter((entry) => entry.scope === "ORDER");
  const appliedOrderDiscounts = order.discounts.filter((entry) => entry.status === "APPLIED");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_26rem]">
      <div className="order-2 lg:order-1">
        {open && abilities.edit ? (
          <MenuBrowser order={order} categories={categories} />
        ) : (
          !open && (
            <p role="status" className="rounded-md border border-neutral-200 bg-neutral-100 p-3">
              This order is {order.status.toLowerCase()}
              {order.voidReason ? `: ${order.voidReason}` : ""}.
            </p>
          )
        )}
      </div>
      {/* The check stays in view while the menu scrolls. */}
      <aside
        aria-label="Check"
        className="order-1 grid content-start gap-4 rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm lg:sticky lg:top-20 lg:order-2 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"
      >
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-2xl font-semibold">Order #{order.orderNumber}</h1>
            <StatusBadge domain="order" status={order.status} />
          </div>
          <p className="text-neutral-700">
            {ORDER_TYPE_LABELS[order.orderType]}
            {order.tableNumbers.length > 0 ? ` · Table ${order.tableNumbers.join(" + ")}` : ""}
            {order.customerName ? ` · ${order.customerName}` : ""}
          </p>
        </div>

        <section aria-label="Unsent items" className="grid gap-2">
          <h2 className="flex items-center gap-2 font-semibold">
            Unsent ({drafts.length})
            {drafts.length > 0 && <Badge tone="warning">{drafts.length} not sent</Badge>}
          </h2>
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
              <SentLine
                key={item.id}
                order={order}
                item={item}
                abilities={abilities}
                discounts={discounts}
                fulfillment={fulfillment[item.id]}
              />
            ))}
          </ul>
        </section>

        <section aria-label="Totals" className="grid gap-1 border-t border-neutral-200 pt-3">
          <p className="flex justify-between">
            <span>Items sent</span>
            <span className="tabular">{formatMoney(order.itemSubtotal)}</span>
          </p>
          {appliedOrderDiscounts.map((entry) => (
            <AppliedDiscountLine key={entry.id} order={order} discount={entry} canRemove={abilities.discount} />
          ))}
          {order.discountTotal !== "0.00" && (
            <p className="flex justify-between text-sm">
              <span>All discounts</span>
              <span className="tabular">−{formatMoney(order.discountTotal)}</span>
            </p>
          )}
          <p className="flex justify-between text-xl font-semibold">
            <span>Total before tax</span>
            <span aria-label="Order total" className="tabular">
              {formatMoney(order.subtotal)}
            </span>
          </p>
          {open && abilities.discount && orderDiscounts.length > 0 && order.itemSubtotal !== "0.00" && (
            <ApplyDiscountForm order={order} choices={orderDiscounts} url={`/api/orders/${order.id}/discounts`} label="Discount the order" />
          )}
        </section>

        {abilities.settle && order.status !== "VOIDED" && (
          <ButtonLink href={`/orders/${order.id}/settlement`} variant={open && drafts.length === 0 ? "primary" : "secondary"}>
            {open ? "Settle check" : "View settlement"}
          </ButtonLink>
        )}

        {open && abilities.void && (
          <div className="border-t border-neutral-200 pt-2">
            <DialogAction
              label="Void whole order"
              title="Void the whole order?"
              description="Every sent item is voided. Say for each whether it was prepared."
              danger
            >
              {(close) => <VoidOrderForm order={order} onDone={close} />}
            </DialogAction>
          </div>
        )}
      </aside>
    </div>
  );
}
