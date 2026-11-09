"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { ActionButton } from "@/components/forms/action-button";
import { sendApiRequest } from "@/components/forms/api-request";
import type { TableHoldIndicator } from "@/modules/reservations/services/hold-service";
import type { FloorSession, FloorTable } from "@/modules/restaurant/services/floor-service";
import type { ServerCandidate } from "@/modules/restaurant/services/server-eligibility-service";

import {
  AVAILABILITY_LABELS,
  AVAILABILITY_STYLES,
  elapsedLabel,
  WARNING_LABELS,
} from "./format";

export type FloorAbilities = {
  seat: boolean;
  move: boolean;
  complete: boolean;
  cancel: boolean;
  clean: boolean;
  condition: boolean;
  assignServer: boolean;
  capacityOverride: boolean;
  scheduleOverride: boolean;
  holdOverride: boolean;
  /** `orders.view`: links a seated party to its orders. */
  orders: boolean;
};

type FloorBoardProps = {
  tables: FloorTable[];
  /** Near-term reservation plans per table. A hold is never occupancy. */
  holds: TableHoldIndicator[];
  timeZone: string;
  abilities: FloorAbilities;
  /** Area ID to who can work there. */
  candidates: Record<string, ServerCandidate[]>;
  now: Date;
};

const INPUT_CLASS =
  "min-h-11 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-base";
const BUTTON_CLASS =
  "min-h-11 rounded border border-neutral-400 px-3 py-1 text-sm font-medium disabled:opacity-50";
const PRIMARY_CLASS =
  "min-h-11 rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50";

/** The floor has no realtime yet, so it re-reads on a short interval while open. */
function useFloorRefresh(): void {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 30_000);

    return () => clearInterval(timer);
  }, [router]);
}

function useSubmit() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(method: string, url: string, body: unknown): Promise<boolean> {
    setPending(true);
    setError(null);

    const result = await sendApiRequest(method, url, body);

    setPending(false);

    if (result.ok) {
      router.refresh();

      return true;
    }

    if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result.message);
    }

    return false;
  }

  return { submit, pending, error };
}

function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-red-700">
      {error}
    </p>
  ) : null;
}

function ServerSelect({
  name,
  label,
  candidates,
  emptyLabel,
  emptyValue,
  value,
  onChange,
}: {
  name: string;
  label: string;
  candidates: readonly ServerCandidate[];
  emptyLabel: string;
  emptyValue: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <select
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={INPUT_CLASS}
      >
        <option value={emptyValue}>{emptyLabel}</option>
        {candidates.map((candidate) => (
          <option key={candidate.employeeId} value={candidate.employeeId}>
            {candidate.displayName}
            {candidate.scheduledNow ? "" : " (not on shift)"}
          </option>
        ))}
      </select>
    </label>
  );
}

const SECTION_DEFAULT = "__section_default__";
const NO_SERVER = "__none__";

function SeatPartyPanel({
  selected,
  holdsByTable,
  abilities,
  candidates,
  onSeated,
}: {
  selected: readonly FloorTable[];
  holdsByTable: ReadonlyMap<string, TableHoldIndicator>;
  abilities: FloorAbilities;
  candidates: Record<string, ServerCandidate[]>;
  onSeated: () => void;
}) {
  const { submit, pending, error } = useSubmit();
  const [partySize, setPartySize] = useState("2");
  const [server, setServer] = useState(SECTION_DEFAULT);
  const [capacityReason, setCapacityReason] = useState("");
  const [scheduleReason, setScheduleReason] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const heldTables = selected.filter((table) => holdsByTable.get(table.id)?.active);
  const capacity = selected.reduce((sum, table) => sum + table.capacity, 0);
  const party = Number(partySize);
  const overCapacity = party > capacity;
  const areaIds = new Set(selected.map((table) => table.area.id));
  const areaId = areaIds.size === 1 ? [...areaIds][0] : undefined;
  const areaCandidates = areaId ? (candidates[areaId] ?? []) : [];
  const chosen = areaCandidates.find((row) => row.employeeId === server);
  const needsScheduleOverride = chosen !== undefined && !chosen.scheduledNow;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const seated = await submit("POST", "/api/restaurant/sessions", {
      tableIds: selected.map((table) => table.id),
      partySize: party,
      ...(server === SECTION_DEFAULT
        ? {}
        : { serverEmployeeId: server === NO_SERVER ? null : server }),
      capacityOverrideReason: capacityReason.trim() || null,
      scheduleOverrideReason: scheduleReason.trim() || null,
      holdOverrideReason: holdReason.trim() || null,
      notes: null,
    });

    if (seated) {
      setCapacityReason("");
      setScheduleReason("");
      setHoldReason("");
      onSeated();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Seat a party"
      className="mb-6 grid gap-3 rounded border border-neutral-300 p-4"
    >
      <h2 className="font-semibold">
        Seat at {selected.map((table) => table.tableNumber).join(" + ")}
      </h2>
      <p className="text-sm text-neutral-700">Seats {capacity}</p>
      {areaIds.size > 1 && (
        <p role="alert" className="text-sm text-amber-800">
          Tables in one session must be in the same area.
        </p>
      )}
      <label className="grid gap-1 text-sm font-medium">
        Party size
        <input
          type="number"
          min={1}
          max={500}
          required
          value={partySize}
          onChange={(event) => setPartySize(event.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      {abilities.assignServer && (
        <ServerSelect
          name="server"
          label="Server"
          candidates={areaCandidates}
          emptyLabel="Section's server, if any"
          emptyValue={SECTION_DEFAULT}
          value={server}
          onChange={setServer}
        />
      )}
      {overCapacity && (
        <div className="grid gap-2 rounded border border-amber-500 bg-amber-50 p-3">
          <p className="text-sm font-medium">
            This party of {party} is over the capacity of {capacity}.
          </p>
          {abilities.capacityOverride ? (
            <label className="grid gap-1 text-sm font-medium">
              Capacity override reason
              <input
                value={capacityReason}
                onChange={(event) => setCapacityReason(event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
          ) : (
            <p className="text-sm">A manager can override this.</p>
          )}
        </div>
      )}
      {heldTables.length > 0 && (
        <div className="grid gap-2 rounded border border-amber-500 bg-amber-50 p-3">
          <p className="text-sm font-medium">
            {heldTables.map((table) => table.tableNumber).join(", ")}{" "}
            {heldTables.length === 1 ? "is" : "are"} on a reservation hold.
          </p>
          {abilities.holdOverride ? (
            <label className="grid gap-1 text-sm font-medium">
              Hold override reason
              <input
                value={holdReason}
                onChange={(event) => setHoldReason(event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
          ) : (
            <p className="text-sm">A manager can override this.</p>
          )}
        </div>
      )}
      {needsScheduleOverride && (
        <div className="grid gap-2 rounded border border-amber-500 bg-amber-50 p-3">
          <p className="text-sm font-medium">
            {chosen.displayName} isn&apos;t on a published shift right now.
          </p>
          {abilities.scheduleOverride ? (
            <label className="grid gap-1 text-sm font-medium">
              Schedule override reason
              <input
                value={scheduleReason}
                onChange={(event) => setScheduleReason(event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
          ) : (
            <p className="text-sm">A manager can override this.</p>
          )}
        </div>
      )}
      <ErrorText error={error} />
      <div>
        <button type="submit" disabled={pending} className={PRIMARY_CLASS}>
          Seat party
        </button>
      </div>
    </form>
  );
}

function TargetChecklist({
  legend,
  tables,
  chosen,
  onToggle,
}: {
  legend: string;
  tables: readonly FloorTable[];
  chosen: readonly string[];
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="grid gap-1">
      <legend className="text-sm font-medium">{legend}</legend>
      {tables.length === 0 && (
        <p className="text-sm text-neutral-600">No clean tables are free.</p>
      )}
      <div className="flex flex-wrap gap-3">
        {tables.map((table) => (
          <label key={table.id} className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={chosen.includes(table.id)}
              onChange={() => onToggle(table.id)}
              className="size-5"
            />
            {table.tableNumber}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SessionActions({
  session,
  area,
  tables,
  abilities,
  candidates,
}: {
  session: FloorSession;
  area: FloorTable["area"];
  tables: readonly FloorTable[];
  abilities: FloorAbilities;
  candidates: Record<string, ServerCandidate[]>;
}) {
  const { submit, pending, error } = useSubmit();
  const [moveTargets, setMoveTargets] = useState<string[]>([]);
  const [addTarget, setAddTarget] = useState("");
  const [capacityReason, setCapacityReason] = useState("");
  const [server, setServer] = useState("");
  const [scheduleReason, setScheduleReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const available = tables.filter((table) => table.availability === "AVAILABLE");
  const sameArea = available.filter((table) => table.area.id === area.id);
  const areaCandidates = candidates[area.id] ?? [];
  const chosen = areaCandidates.find((row) => row.employeeId === server);
  const base = `/api/restaurant/sessions/${session.id}`;
  const version = { expectedVersion: session.version };
  const capacityOverride = capacityReason.trim() || null;

  return (
    <div className="mt-3 grid gap-3">
      {abilities.complete && (
        <ActionButton
          method="POST"
          url={`${base}/complete`}
          body={version}
          label="Complete session"
        />
      )}
      {abilities.move && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
            Move or combine
          </summary>
          <div className="grid gap-3 pt-2">
            {abilities.capacityOverride && (
              <label className="grid gap-1 text-sm font-medium">
                Capacity override reason, if needed
                <input
                  value={capacityReason}
                  onChange={(event) => setCapacityReason(event.target.value)}
                  className={INPUT_CLASS}
                />
              </label>
            )}
            <TargetChecklist
              legend="Move to"
              tables={available}
              chosen={moveTargets}
              onToggle={(id) =>
                setMoveTargets((current) =>
                  current.includes(id)
                    ? current.filter((value) => value !== id)
                    : [...current, id],
                )
              }
            />
            <p className="text-sm text-neutral-700">
              Vacated tables will become DIRTY. Target tables must be clean and
              available.
            </p>
            <div>
              <button
                type="button"
                disabled={pending || moveTargets.length === 0}
                className={BUTTON_CLASS}
                onClick={() =>
                  submit("POST", `${base}/move`, {
                    ...version,
                    tableIds: moveTargets,
                    capacityOverrideReason: capacityOverride,
                  })
                }
              >
                Move party
              </button>
            </div>
            {sameArea.length > 0 && (
              <div className="grid gap-2">
                <label className="grid gap-1 text-sm font-medium">
                  Combine with
                  <select
                    value={addTarget}
                    onChange={(event) => setAddTarget(event.target.value)}
                    className={INPUT_CLASS}
                  >
                    <option value="">Choose a table</option>
                    {sameArea.map((table) => (
                      <option key={table.id} value={table.id}>
                        {table.tableNumber}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <button
                    type="button"
                    disabled={pending || !addTarget}
                    className={BUTTON_CLASS}
                    onClick={() =>
                      submit("POST", `${base}/tables`, {
                        ...version,
                        tableId: addTarget,
                        capacityOverrideReason: capacityOverride,
                      })
                    }
                  >
                    Combine table
                  </button>
                </div>
              </div>
            )}
            {session.tables.length > 1 && (
              <div className="grid gap-2">
                <p className="text-sm text-neutral-700">
                  A removed table will become DIRTY.
                </p>
                <div className="flex flex-wrap gap-2">
                  {session.tables.map((table) => (
                    <button
                      key={table.id}
                      type="button"
                      disabled={pending}
                      className={BUTTON_CLASS}
                      onClick={() =>
                        submit("POST", `${base}/tables/${table.id}/remove`, {
                          ...version,
                          capacityOverrideReason: capacityOverride,
                        })
                      }
                    >
                      Remove {table.tableNumber}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>
      )}
      {abilities.assignServer && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
            Reassign server
          </summary>
          <div className="grid gap-2 pt-2">
            <ServerSelect
              name="reassign"
              label="New server"
              candidates={areaCandidates}
              emptyLabel="Choose a server"
              emptyValue=""
              value={server}
              onChange={setServer}
            />
            {chosen && !chosen.scheduledNow && abilities.scheduleOverride && (
              <label className="grid gap-1 text-sm font-medium">
                Schedule override reason
                <input
                  value={scheduleReason}
                  onChange={(event) => setScheduleReason(event.target.value)}
                  className={INPUT_CLASS}
                />
              </label>
            )}
            <div>
              <button
                type="button"
                disabled={pending || !server}
                className={BUTTON_CLASS}
                onClick={() =>
                  submit("POST", `${base}/server`, {
                    ...version,
                    serverEmployeeId: server,
                    scheduleOverrideReason: scheduleReason.trim() || null,
                  })
                }
              >
                Assign server
              </button>
            </div>
          </div>
        </details>
      )}
      {abilities.cancel && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
            Cancel seating
          </summary>
          <div className="grid gap-2 pt-2">
            <p className="text-sm text-neutral-700">
              Only for a mistake, before the table was used. A used table should be
              completed, so it gets cleaned.
            </p>
            <label className="grid gap-1 text-sm font-medium">
              Reason
              <input
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
            <div>
              <button
                type="button"
                disabled={pending || !cancelReason.trim()}
                className={BUTTON_CLASS}
                onClick={() =>
                  submit("POST", `${base}/cancel`, {
                    ...version,
                    reason: cancelReason.trim(),
                  })
                }
              >
                Cancel this seating
              </button>
            </div>
          </div>
        </details>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function TableCard({
  table,
  tables,
  abilities,
  candidates,
  selected,
  onToggle,
  now,
  hold,
  timeZone,
}: {
  hold: TableHoldIndicator | undefined;
  timeZone: string;
  table: FloorTable;
  tables: readonly FloorTable[];
  abilities: FloorAbilities;
  candidates: Record<string, ServerCandidate[]>;
  selected: boolean;
  onToggle: () => void;
  now: Date;
}) {
  const url = `/api/restaurant/tables/${table.id}`;
  const version = { expectedVersion: table.version };
  const { session } = table;

  return (
    <li
      aria-label={`Table ${table.tableNumber}`}
      className={`rounded border-2 p-3 ${AVAILABILITY_STYLES[table.availability]}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold">{table.tableNumber}</h3>
        <span className="text-sm font-semibold">
          {AVAILABILITY_LABELS[table.availability]}
        </span>
      </div>
      {table.name && <p className="text-sm">{table.name}</p>}
      <p className="text-sm">
        Seats {table.capacity}
        {table.section ? ` · ${table.section}` : ""}
      </p>
      {session && (
        <div className="mt-2 text-sm">
          <p>Party of {session.partySize}</p>
          <p>Seated {elapsedLabel(session.seatedAt, now)}</p>
          <p>Server: {session.serverName ?? "None"}</p>
          {session.tables.length > 1 && (
            <p>
              Combined: {session.tables.map((row) => row.tableNumber).join(" + ")}
            </p>
          )}
          {abilities.orders && (
            <Link
              href={`/orders?session=${session.id}&type=${table.area.type === "BAR" ? "BAR" : "DINE_IN"}`}
              className="mt-2 inline-flex min-h-11 items-center rounded border border-neutral-400 px-3 text-sm font-medium"
            >
              Orders
            </Link>
          )}
        </div>
      )}
      {hold && table.availability !== "OCCUPIED" && (
        <p role="status" className="mt-1 text-sm font-medium text-purple-900">
          {hold.active ? "Reservation hold" : "Reserved soon"} · reserved at{" "}
          {formatClock(hold.reservationAt, timeZone)}
          {hold.active ? "" : ` · hold begins ${formatClock(hold.holdStartsAt, timeZone)}`}
          {hold.guestName ? ` · ${hold.guestName}` : ""}
        </p>
      )}
      {table.warnings.map((warning) => (
        <p key={warning} role="status" className="mt-1 text-sm font-medium text-amber-900">
          {WARNING_LABELS[warning] ?? warning}
        </p>
      ))}
      {table.availability === "AVAILABLE" && abilities.seat && (
        <label className="mt-2 flex min-h-11 items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="size-5"
          />
          Select {table.tableNumber}
        </label>
      )}
      {table.availability === "DIRTY" && abilities.clean && (
        <div className="mt-2">
          <ActionButton
            method="POST"
            url={`${url}/clean`}
            body={version}
            label="Mark clean"
          />
        </div>
      )}
      {abilities.condition &&
        (table.availability === "AVAILABLE" || table.availability === "DIRTY") && (
          <div className="mt-2">
            <ActionButton
              method="POST"
              url={`${url}/condition`}
              body={{ ...version, condition: "OUT_OF_SERVICE", reason: null }}
              label="Take out of service"
            />
          </div>
        )}
      {abilities.condition && table.availability === "OUT_OF_SERVICE" && (
        <div className="mt-2">
          <ActionButton
            method="POST"
            url={`${url}/condition`}
            body={{ ...version, condition: "CLEAN", reason: "Returned to service" }}
            label="Return to service as clean"
          />
        </div>
      )}
      {session && (
        <SessionActions
          session={session}
          area={table.area}
          tables={tables}
          abilities={abilities}
          candidates={candidates}
        />
      )}
    </li>
  );
}

export function FloorBoard({
  tables,
  holds,
  timeZone,
  abilities,
  candidates,
  now,
}: FloorBoardProps) {
  useFloorRefresh();

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // The soonest plan per table is the one worth showing.
  const holdsByTable = useMemo(() => {
    const map = new Map<string, TableHoldIndicator>();

    for (const hold of [...holds].sort((a, b) => a.reservationAt.localeCompare(b.reservationAt))) {
      if (!map.has(hold.tableId)) {
        map.set(hold.tableId, hold);
      }
    }

    return map;
  }, [holds]);
  const visible = useMemo(
    // A party seated before its area was deactivated still has to be completed.
    () =>
      tables.filter(
        (table) => table.availability !== "INACTIVE" || table.session !== null,
      ),
    [tables],
  );
  const areas = useMemo(
    () => [...new Map(visible.map((table) => [table.area.id, table.area])).values()],
    [visible],
  );
  // A table that was just seated by someone else drops out of the selection.
  const selected = visible.filter(
    (table) => selectedIds.includes(table.id) && table.availability === "AVAILABLE",
  );

  if (visible.length === 0) {
    return <p className="text-neutral-600">No tables have been set up yet.</p>;
  }

  return (
    <>
      {selected.length > 0 && (
        <SeatPartyPanel
          selected={selected}
          holdsByTable={holdsByTable}
          abilities={abilities}
          candidates={candidates}
          onSeated={() => setSelectedIds([])}
        />
      )}
      {areas.map((area) => (
        <section key={area.id} className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">{area.name}</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible
              .filter((table) => table.area.id === area.id)
              .map((table) => (
                <TableCard
                  key={table.id}
                  table={table}
                  tables={visible}
                  abilities={abilities}
                  candidates={candidates}
                  hold={holdsByTable.get(table.id)}
                  timeZone={timeZone}
                  selected={selectedIds.includes(table.id)}
                  onToggle={() =>
                    setSelectedIds((current) =>
                      current.includes(table.id)
                        ? current.filter((id) => id !== table.id)
                        : [...current, table.id],
                    )
                  }
                  now={now}
                />
              ))}
          </ul>
        </section>
      ))}
    </>
  );
}
