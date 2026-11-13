"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

import { formatQuantity } from "./format";

// Phase 23 (policies 10–15): transfers between locations. A draft is built here and sent;
// the other location receives it and enters anything that arrived short. "Send and receive
// now" is offered only where the user also holds the permission at the destination.

export type TransferView = {
  id: string;
  transferNumber: string;
  status: "DRAFT" | "SENT" | "RECEIVED" | "CANCELLED" | string;
  direction: "OUTGOING" | "INCOMING";
  fromLocationId: string;
  toLocationId: string;
  notes: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  version: number;
  lines: {
    id: string;
    itemName: string;
    quantity: string;
    unitCode: string;
    baseQuantity: string;
    baseQuantityReceived: string | null;
    valueSent: string | null;
  }[];
};

type Option = { value: string; label: string };

type Props = {
  transfers: TransferView[];
  items: Option[];
  units: Option[];
  destinations: (Option & { canReceiveThere: boolean })[];
  locationNames: Record<string, string>;
  canTransfer: boolean;
};

type Line = { inventoryItemId: string; quantity: string; unitOfMeasureId: string };

const key = () => crypto.randomUUID();

function useAction() {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  async function run(method: string, url: string, body: unknown, success: string) {
    setPending(true);
    setError(null);
    const result = await sendApiRequest(method, url, body);
    setPending(false);

    if (result.ok) {
      toast.success(success);
      router.refresh();
      return true;
    }

    setError(result);
    return false;
  }

  return { pending, error, run };
}

function NewTransfer({ items, units, destinations }: Pick<Props, "items" | "units" | "destinations">) {
  const [to, setTo] = useState(destinations[0]?.value ?? "");
  const [notes, setNotes] = useState("");
  const blank = (): Line => ({ inventoryItemId: "", quantity: "", unitOfMeasureId: units[0]?.value ?? "" });
  const [lines, setLines] = useState<Line[]>([blank()]);
  const action = useAction();
  const canNow = destinations.find((destination) => destination.value === to)?.canReceiveThere ?? false;

  const update = (index: number, change: Partial<Line>) =>
    setLines((current) => current.map((line, at) => (at === index ? { ...line, ...change } : line)));

  async function submit(now: boolean) {
    const body = {
      toLocationId: to,
      notes: notes.trim() === "" ? null : notes.trim(),
      lines: lines.filter((line) => line.inventoryItemId && line.quantity.trim() !== "").map((line) => ({ ...line, quantity: line.quantity.trim() })),
    };
    const done = await action.run(
      "POST",
      now ? "/api/inventory/transfers/now" : "/api/inventory/transfers/drafts",
      body,
      now ? "Transferred." : "Draft saved. Send it when the stock leaves.",
    );

    if (done) {
      setLines([blank()]);
      setNotes("");
    }
  }

  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void submit(false);
      }}
      className="grid gap-3"
      aria-label="New transfer"
    >
      <Field label="To">
        <Select value={to} onChange={(event) => setTo(event.target.value)} required>
          {destinations.map((destination) => (
            <option key={destination.value} value={destination.value}>
              {destination.label}
            </option>
          ))}
        </Select>
      </Field>
      {lines.map((line, index) => (
        <fieldset key={index} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
          <legend className="sr-only">Line {index + 1}</legend>
          <Field label="Item">
            <Select value={line.inventoryItemId} onChange={(event) => update(index, { inventoryItemId: event.target.value })}>
              <option value="">Choose…</option>
              {items.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Quantity">
            <Input inputMode="decimal" value={line.quantity} onChange={(event) => update(index, { quantity: event.target.value })} />
          </Field>
          <Field label="Unit">
            <Select value={line.unitOfMeasureId} onChange={(event) => update(index, { unitOfMeasureId: event.target.value })}>
              {units.map((unit) => (
                <option key={unit.value} value={unit.value}>
                  {unit.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="ghost"
            disabled={lines.length === 1}
            onClick={() => setLines((current) => current.filter((_, at) => at !== index))}
          >
            Remove
          </Button>
        </fieldset>
      ))}
      <div>
        <Button variant="secondary" onClick={() => setLines((current) => [...current, blank()])}>
          Add another item
        </Button>
      </div>
      <Field label="Notes">
        <Input value={notes} maxLength={500} onChange={(event) => setNotes(event.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" pending={action.pending}>
          Save draft
        </Button>
        {canNow && (
          <Button
            variant="secondary"
            pending={action.pending}
            onClick={() => void submit(true)}
          >
            Send and receive now
          </Button>
        )}
        <ApiErrorMessage error={action.error} />
      </div>
    </form>
  );
}

function Lines({ transfer, received }: { transfer: TransferView; received?: boolean }) {
  return (
    <ul className="grid gap-1 text-sm">
      {transfer.lines.map((line) => (
        <li key={line.id}>
          {line.itemName}: {formatQuantity(line.quantity)} {line.unitCode}
          {received && line.baseQuantityReceived !== null && line.baseQuantityReceived !== line.baseQuantity && (
            <span className="ml-2 text-warning-800">
              (arrived {formatQuantity(line.baseQuantityReceived)} of {formatQuantity(line.baseQuantity)} base units)
            </span>
          )}
          {line.valueSent !== null && <span className="ml-2 text-neutral-600">value ${line.valueSent}</span>}
        </li>
      ))}
    </ul>
  );
}

function DraftActions({ transfer }: { transfer: TransferView }) {
  const action = useAction();
  const [sendKey] = useState(key);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="primary"
        pending={action.pending}
        onClick={() =>
          void action.run(
            "POST",
            `/api/inventory/transfers/${transfer.id}/send`,
            { expectedVersion: transfer.version, idempotencyKey: sendKey },
            "Sent. It's in transit until the other location receives it.",
          )
        }
      >
        Send
      </Button>
      <Button
        variant="ghost"
        pending={action.pending}
        onClick={() =>
          void action.run("POST", `/api/inventory/transfers/${transfer.id}/cancel`, { expectedVersion: transfer.version }, "Draft cancelled.")
        }
      >
        Cancel draft
      </Button>
      <ApiErrorMessage error={action.error} />
    </div>
  );
}

function ReceiveForm({ transfer }: { transfer: TransferView }) {
  const action = useAction();
  const [receiveKey] = useState(key);
  const [arrived, setArrived] = useState<Record<string, string>>(
    Object.fromEntries(transfer.lines.map((line) => [line.id, formatQuantity(line.quantity)])),
  );

  return (
    <form
      aria-label={`Receive ${transfer.transferNumber}`}
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(
          "POST",
          `/api/inventory/transfers/${transfer.id}/receive`,
          {
            expectedVersion: transfer.version,
            idempotencyKey: receiveKey,
            lines: transfer.lines.map((line) => ({ lineId: line.id, quantityReceived: (arrived[line.id] ?? "").trim() || "0" })),
          },
          "Received.",
        );
      }}
    >
      {transfer.lines.map((line) => (
        <Field key={line.id} label={`${line.itemName}: arrived (${line.unitCode}, ${formatQuantity(line.quantity)} sent)`}>
          <Input
            inputMode="decimal"
            value={arrived[line.id] ?? ""}
            onChange={(event) => setArrived((current) => ({ ...current, [line.id]: event.target.value }))}
          />
        </Field>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" pending={action.pending}>
          Receive
        </Button>
        <ApiErrorMessage error={action.error} />
      </div>
    </form>
  );
}

const TONE: Record<string, "neutral" | "info" | "success" | "warning"> = {
  DRAFT: "neutral",
  SENT: "info",
  RECEIVED: "success",
  CANCELLED: "neutral",
};

export function TransferBoard({ transfers, items, units, destinations, locationNames, canTransfer }: Props) {
  const drafts = transfers.filter((transfer) => transfer.direction === "OUTGOING" && transfer.status === "DRAFT");
  const inTransitOut = transfers.filter((transfer) => transfer.direction === "OUTGOING" && transfer.status === "SENT");
  const incoming = transfers.filter((transfer) => transfer.direction === "INCOMING" && transfer.status === "SENT");
  const history = transfers.filter((transfer) => transfer.status === "RECEIVED" || transfer.status === "CANCELLED").slice(0, 20);
  const name = (id: string) => locationNames[id] ?? "Another location";
  const card = "rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm";

  return (
    <div className="grid gap-8">
      {incoming.length > 0 && (
        <section aria-label="Arriving here" className="grid gap-3">
          <h2 className="text-xl font-semibold">Arriving here</h2>
          {incoming.map((transfer) => (
            <article key={transfer.id} className={card} data-testid="incoming-transfer">
              <p className="mb-2 font-medium">
                {transfer.transferNumber} from {name(transfer.fromLocationId)} <Badge tone="info">In transit</Badge>
              </p>
              {canTransfer ? <ReceiveForm transfer={transfer} /> : <Lines transfer={transfer} />}
            </article>
          ))}
        </section>
      )}

      {canTransfer && destinations.length > 0 && items.length > 0 && (
        <section aria-label="New transfer" className={card}>
          <h2 className="mb-3 text-xl font-semibold">New transfer</h2>
          <NewTransfer items={items} units={units} destinations={destinations} />
        </section>
      )}

      {drafts.length > 0 && (
        <section aria-label="Drafts" className="grid gap-3">
          <h2 className="text-xl font-semibold">Drafts</h2>
          {drafts.map((transfer) => (
            <article key={transfer.id} className={card} data-testid="draft-transfer">
              <p className="mb-2 font-medium">
                {transfer.transferNumber} to {name(transfer.toLocationId)}
              </p>
              <Lines transfer={transfer} />
              {canTransfer && (
                <div className="mt-3">
                  <DraftActions transfer={transfer} />
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {inTransitOut.length > 0 && (
        <section aria-label="Sent, not yet received" className="grid gap-3">
          <h2 className="text-xl font-semibold">Sent, not yet received</h2>
          {inTransitOut.map((transfer) => (
            <article key={transfer.id} className={card}>
              <p className="mb-2 font-medium">
                {transfer.transferNumber} to {name(transfer.toLocationId)} <Badge tone="info">In transit</Badge>
              </p>
              <Lines transfer={transfer} />
            </article>
          ))}
        </section>
      )}

      <section aria-label="Recent transfers" className="grid gap-3">
        <h2 className="text-xl font-semibold">Recent transfers</h2>
        {history.length === 0 && <p className="text-neutral-600">None yet.</p>}
        {history.map((transfer) => (
          <article key={transfer.id} className={card}>
            <p className="mb-2 font-medium">
              {transfer.transferNumber}{" "}
              {transfer.direction === "OUTGOING" ? `to ${name(transfer.toLocationId)}` : `from ${name(transfer.fromLocationId)}`}{" "}
              <Badge tone={TONE[transfer.status] ?? "neutral"}>{transfer.status === "RECEIVED" ? "Received" : "Cancelled"}</Badge>
            </p>
            <Lines transfer={transfer} received />
          </article>
        ))}
      </section>
    </div>
  );
}
