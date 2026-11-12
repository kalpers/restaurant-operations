"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import type { ReservationView } from "@/modules/reservations/services/reservation-service";
import type { ConflictPreview } from "@/modules/reservations/services/reservation-service";
import type { RecommendationResult } from "@/modules/reservations/rules/table-recommendation";

import {
  BUTTON_CLASS,
  ErrorText,
  formatDay,
  formatTime,
  INPUT_CLASS,
  PRIMARY_CLASS,
  TablePicker,
  toggled,
  useSubmit,
  type HostTableOption,
} from "./shared";
import { GuestPicker, type PickedGuest } from "./guest-picker";
import { GuestMarks, PartyGuestPanel, type AllergenOption, type HostGuestAbilities } from "./party-guest-panel";
import { GuestMessagesPanel, MessageConsentFields, type HostMessageAbilities, type MessageConsent } from "./guest-messages";
import { StatusBadge } from "@/components/format/status-badge";
import { EmptyState } from "@/components/ui/empty-state";

export type ReservationAbilities = {
  manage: boolean;
  seat: boolean;
  overrideHold: boolean;
  capacityOverride: boolean;
  /** Phase 21: guest profiles and visit allergies at the host stand. */
  guests: HostGuestAbilities;
  allergens: AllergenOption[];
  /** Phase 22: message history and resend. */
  messages: HostMessageAbilities;
  /** Phase 22 (policy 17): `guests.erase`, for a visit with no guest profile. */
  eraseVisit: boolean;
};

type ReservationsBoardProps = {
  reservations: ReservationView[];
  tables: HostTableOption[];
  timeZone: string;
  /** The server's clock, so the first render matches on both sides. */
  nowIso: string;
  businessDate: string;
  defaultDate: string;
  defaultDurationMinutes: number;
  abilities: ReservationAbilities;
};

const STATUS_STYLES: Record<ReservationView["status"], string> = {
  PENDING: "border-warning-500 bg-warning-50",
  CONFIRMED: "border-neutral-400 bg-white",
  CHECKED_IN: "border-emerald-500 bg-emerald-50",
  SEATED: "border-blue-500 bg-blue-50",
  COMPLETED: "border-neutral-300 bg-neutral-100",
  CANCELLED: "border-neutral-300 bg-neutral-100",
  NO_SHOW: "border-red-400 bg-danger-50",
};

const ACTIVE: readonly ReservationView["status"][] = [
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
];

function useRefresh(): void {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 30_000);

    return () => clearInterval(timer);
  }, [router]);
}

function localParts(iso: string, timeZone: string): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

  return { date, time };
}

function GuestFields({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  const field = (name: string, label: string, type = "text", extra = {}) => (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input
        name={name}
        type={type}
        value={values[name] ?? ""}
        onChange={(event) => onChange(name, event.target.value)}
        className={INPUT_CLASS}
        {...extra}
      />
    </label>
  );

  return (
    <>
      {field("guestName", "Guest name", "text", { required: true, maxLength: 120 })}
      {field("partySize", "Party size", "number", { required: true, min: 1, max: 500 })}
      {field("phone", "Phone")}
      {field("email", "Email", "email")}
      {field("localDate", "Date", "date", { required: true })}
      {field("localTime", "Time", "time", { required: true })}
      {field("expectedDurationMinutes", "Expected length (minutes)", "number", {
        required: true,
        min: 1,
      })}
      {field("specialRequests", "Special requests")}
      {field("notes", "Notes")}
    </>
  );
}

function ReservationForm({
  tables,
  initial,
  mode,
  onDone,
  guests,
}: {
  tables: readonly HostTableOption[];
  initial: Record<string, string>;
  mode: { type: "create" } | { type: "edit"; reservation: ReservationView };
  onDone: () => void;
  guests?: HostGuestAbilities;
}) {
  const { submit, pending, error } = useSubmit();
  const [values, setValues] = useState(initial);
  // Phase 21 (policy 2): the guest profile the new visit links to, picked by the host.
  const [profile, setProfile] = useState<PickedGuest | null>(null);
  const [source, setSource] = useState("PHONE");
  const [status, setStatus] = useState("CONFIRMED");
  const [planned, setPlanned] = useState<string[]>(
    mode.type === "edit" ? mode.reservation.plannedTables.map((table) => table.id) : [],
  );
  // Phase 22 (policy 6): unticked unless the guest agreed.
  const [consent, setConsent] = useState<MessageConsent>(
    mode.type === "edit" ? mode.reservation.messageConsent : { sms: false, email: false },
  );
  const change = (name: string, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const common = {
      guestName: values.guestName,
      partySize: Number(values.partySize),
      phone: values.phone || null,
      email: values.email || null,
      specialRequests: values.specialRequests || null,
      localDate: values.localDate,
      localTime: values.localTime,
      expectedDurationMinutes: Number(values.expectedDurationMinutes),
      notes: values.notes || null,
      messageConsent: consent,
    };
    const saved =
      mode.type === "create"
        ? await submit("POST", "/api/reservations", {
            ...common,
            source,
            status,
            tableIds: planned,
            guestProfileId: profile?.id ?? null,
          })
        : await submit("PUT", `/api/reservations/${mode.reservation.id}`, {
            ...common,
            tableIds: planned,
            expectedVersion: mode.reservation.version,
          });

    if (saved) {
      onDone();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={mode.type === "create" ? "New reservation" : "Edit reservation"}
      className="mb-4 grid gap-3 rounded-md border border-neutral-300 p-4"
    >
      <h2 className="font-semibold">
        {mode.type === "create" ? "New reservation" : "Edit reservation"}
      </h2>
      {mode.type === "create" && guests?.manage && (
        <div className="rounded border border-neutral-200 p-3">
          {profile ? (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              Guest profile: <span className="font-medium">{profile.displayName}</span>
              <span className="text-neutral-500">#{profile.profileNumber}</span>
              <button type="button" className={BUTTON_CLASS} onClick={() => setProfile(null)}>
                Clear
              </button>
            </p>
          ) : (
            <GuestPicker
              canCreate
              onPick={(picked) => {
                setProfile(picked);
                setValues((current) => (current.guestName ? current : { ...current, guestName: picked.displayName }));
              }}
            />
          )}
        </div>
      )}
      <GuestFields values={values} onChange={change} />
      <MessageConsentFields value={consent} onChange={setConsent} />
      {mode.type === "create" && (
        <>
          <label className="grid gap-1 text-sm font-medium">
            Source
            <select
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="PHONE">Phone</option>
              <option value="IN_PERSON">In person</option>
              <option value="INTERNAL">Internal</option>
              <option value="WALK_IN_FUTURE">Walk-in for later</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="CONFIRMED">Confirmed</option>
              <option value="PENDING">Pending</option>
            </select>
          </label>
        </>
      )}
      <TablePicker
        legend="Planned tables (optional, up to 3, one area)"
        tables={tables}
        chosen={planned}
        onToggle={(id) => setPlanned((current) => toggled(current, id))}
      />
      <ErrorText error={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={PRIMARY_CLASS}>
          {mode.type === "create" ? "Create reservation" : "Save changes"}
        </button>
        <button type="button" onClick={onDone} className={BUTTON_CLASS}>
          Close
        </button>
      </div>
    </form>
  );
}

function PlanPanel({
  reservation,
  tables,
  timeZone,
  onDone,
}: {
  reservation: ReservationView;
  tables: readonly HostTableOption[];
  timeZone: string;
  onDone: () => void;
}) {
  const { submit, pending, error } = useSubmit();
  const [chosen, setChosen] = useState(reservation.plannedTables.map((table) => table.id));
  const [preview, setPreview] = useState<{
    conflicts: ConflictPreview[];
    capacity: number;
    sufficient: boolean;
  } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const { date, time } = localParts(reservation.reservationAt, timeZone);

  async function check(ids: string[]) {
    setCheckError(null);

    const response = await fetch("/api/reservations/conflicts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tableIds: ids,
        localDate: date,
        localTime: time,
        expectedDurationMinutes: reservation.expectedDurationMinutes,
        partySize: reservation.partySize,
        excludeReservationId: reservation.id,
      }),
    });

    if (response.ok) {
      setPreview(await response.json());
    } else {
      setCheckError("Couldn't check these tables.");
    }
  }

  function toggle(id: string) {
    const next = toggled(chosen, id);

    setChosen(next);
    void check(next);
  }

  return (
    <div className="mt-3 grid gap-3 rounded-md border border-neutral-300 p-3" aria-label="Plan tables">
      <TablePicker legend="Planned tables" tables={tables} chosen={chosen} onToggle={toggle} />
      {preview && !preview.sufficient && (
        <p role="alert" className="text-sm text-warning-900">
          These tables seat {preview.capacity}, fewer than the party of {reservation.partySize}.
        </p>
      )}
      {preview?.conflicts.map((conflict) => (
        <p key={`${conflict.reservationId}-${conflict.tableId}`} role="alert" className="text-sm text-warning-900">
          Table {conflict.tableNumber} conflicts with {conflict.guestName}&apos;s party of{" "}
          {conflict.partySize} at {formatTime(conflict.reservationAt, timeZone)}.
        </p>
      ))}
      {preview && preview.sufficient && preview.conflicts.length === 0 && chosen.length > 0 && (
        <p role="status" className="text-sm text-success-800">
          No planning conflicts.
        </p>
      )}
      <ErrorText error={error ?? checkError} />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          className={PRIMARY_CLASS}
          onClick={async () => {
            if (
              await submit("POST", `/api/reservations/${reservation.id}/tables`, {
                tableIds: chosen,
                expectedVersion: reservation.version,
              })
            ) {
              onDone();
            }
          }}
        >
          Save planned tables
        </button>
        <button type="button" onClick={onDone} className={BUTTON_CLASS}>
          Close
        </button>
      </div>
    </div>
  );
}

function SeatPanel({
  reservation,
  tables,
  abilities,
  onDone,
}: {
  reservation: ReservationView;
  tables: readonly HostTableOption[];
  abilities: ReservationAbilities;
  onDone: () => void;
}) {
  const { submit, pending, error } = useSubmit();
  const [chosen, setChosen] = useState<string[]>([]);
  const [holdReason, setHoldReason] = useState("");
  const [capacityReason, setCapacityReason] = useState("");
  const [suggestions, setSuggestions] = useState<RecommendationResult | null>(null);
  const capacity = tables
    .filter((table) => chosen.includes(table.id))
    .reduce((sum, table) => sum + table.capacity, 0);
  const planned = new Set(reservation.plannedTables.map((table) => table.id));
  const heldForOthers = tables.filter(
    (table) => chosen.includes(table.id) && table.held && !planned.has(table.id),
  );

  async function suggest() {
    const response = await fetch(
      `/api/reservations/recommendations?partySize=${reservation.partySize}&guestPartyId=${reservation.guestPartyId}`,
    );

    if (response.ok) {
      setSuggestions(await response.json());
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (
      await submit("POST", `/api/reservations/${reservation.id}/seat`, {
        tableIds: chosen,
        holdOverrideReason: holdReason.trim() || null,
        capacityOverrideReason: capacityReason.trim() || null,
        expectedVersion: reservation.version,
      })
    ) {
      onDone();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Seat reservation"
      className="mt-3 grid gap-3 rounded-md border border-neutral-300 p-3"
    >
      <p className="text-sm">
        Seat {reservation.guestName}, party of {reservation.partySize}. Tables can differ from
        the planned ones
        {reservation.plannedTables.length > 0
          ? ` (${reservation.plannedTables.map((table) => table.tableNumber).join(" + ")})`
          : ""}
        .
      </p>
      <div>
        <button type="button" onClick={suggest} className={BUTTON_CLASS}>
          Suggest tables
        </button>
      </div>
      {suggestions && (
        <ul className="flex flex-wrap gap-2" aria-label="Suggested tables">
          {suggestions.recommendations.length === 0 && (
            <li className="text-sm text-neutral-600">No table or combination fits right now.</li>
          )}
          {suggestions.recommendations.map((entry) => (
            <li key={entry.tableIds.join("+")}>
              <button
                type="button"
                className={BUTTON_CLASS}
                onClick={() => setChosen(entry.tableIds)}
              >
                Use {entry.tableNumbers.join(" + ")} (seats {entry.capacity})
              </button>
            </li>
          ))}
        </ul>
      )}
      <TablePicker
        legend="Seat at"
        tables={tables}
        chosen={chosen}
        onToggle={(id) => setChosen((current) => toggled(current, id))}
        onlyAvailable
      />
      {heldForOthers.length > 0 && (
        <div className="grid gap-2 rounded border border-warning-500 bg-warning-50 p-3">
          <p className="text-sm font-medium">
            {heldForOthers.map((table) => table.tableNumber).join(", ")}{" "}
            {heldForOthers.length === 1 ? "is" : "are"} held for another reservation.
          </p>
          {abilities.overrideHold ? (
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
      {chosen.length > 0 && reservation.partySize > capacity && (
        <div className="grid gap-2 rounded border border-warning-500 bg-warning-50 p-3">
          <p className="text-sm font-medium">
            This party of {reservation.partySize} is over the capacity of {capacity}.
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
      <ErrorText error={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending || chosen.length === 0} className={PRIMARY_CLASS}>
          Seat party
        </button>
        <button type="button" onClick={onDone} className={BUTTON_CLASS}>
          Close
        </button>
      </div>
    </form>
  );
}

function CancelPanel({
  reservation,
  onDone,
}: {
  reservation: ReservationView;
  onDone: () => void;
}) {
  const { submit, pending, error } = useSubmit();
  const [reason, setReason] = useState("");

  return (
    <form
      aria-label="Cancel reservation"
      className="mt-3 grid gap-3 rounded-md border border-neutral-300 p-3"
      onSubmit={async (event) => {
        event.preventDefault();

        if (
          await submit("POST", `/api/reservations/${reservation.id}/cancel`, {
            reason: reason.trim() || null,
            expectedVersion: reservation.version,
          })
        ) {
          onDone();
        }
      }}
    >
      <label className="grid gap-1 text-sm font-medium">
        Reason (optional)
        <input value={reason} onChange={(event) => setReason(event.target.value)} className={INPUT_CLASS} />
      </label>
      <ErrorText error={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={PRIMARY_CLASS}>
          Confirm cancellation
        </button>
        <button type="button" onClick={onDone} className={BUTTON_CLASS}>
          Keep reservation
        </button>
      </div>
    </form>
  );
}

function EraseVisitPanel({ reservation, onDone }: { reservation: ReservationView; onDone: () => void }) {
  const { submit, pending, error } = useSubmit();
  const [reason, setReason] = useState("");

  return (
    <form
      aria-label="Erase guest details"
      className="mt-3 grid gap-3 rounded-md border border-danger-300 p-3"
      onSubmit={async (event) => {
        event.preventDefault();

        if (
          await submit("POST", `/api/guest-parties/${reservation.guestPartyId}/erase`, {
            reason,
            expectedVersion: reservation.guest.partyVersion,
          })
        ) {
          onDone();
        }
      }}
    >
      <p className="text-sm">
        Removes this guest&apos;s name, phone, email, requests, allergies and message history text. The booking and its
        history stay. This can&apos;t be undone.
      </p>
      <label className="grid gap-1 text-sm font-medium">
        Reason
        <input required maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} className={INPUT_CLASS} />
      </label>
      <ErrorText error={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={PRIMARY_CLASS}>
          Erase guest details
        </button>
        <button type="button" onClick={onDone} className={BUTTON_CLASS}>
          Keep
        </button>
      </div>
    </form>
  );
}

function ReservationCard({
  reservation,
  tables,
  timeZone,
  now,
  abilities,
  defaultDurationMinutes,
}: {
  reservation: ReservationView;
  tables: readonly HostTableOption[];
  timeZone: string;
  now: Date;
  abilities: ReservationAbilities;
  defaultDurationMinutes: number;
}) {
  const { submit, pending, error } = useSubmit();
  const [panel, setPanel] = useState<"edit" | "plan" | "seat" | "cancel" | "guest" | "messages" | "erase" | null>(null);
  const close = () => setPanel(null);
  const active = ACTIVE.includes(reservation.status);
  const version = { expectedVersion: reservation.version };
  const base = `/api/reservations/${reservation.id}`;
  const noShowOpen = now >= new Date(reservation.noShowAllowedAt);
  const local = localParts(reservation.reservationAt, timeZone);
  const initial = {
    guestName: reservation.guestName,
    partySize: String(reservation.partySize),
    phone: reservation.phone ?? "",
    email: reservation.email ?? "",
    specialRequests: reservation.specialRequests ?? "",
    localDate: local.date,
    localTime: local.time,
    expectedDurationMinutes: String(
      reservation.expectedDurationMinutes || defaultDurationMinutes,
    ),
    notes: reservation.notes ?? "",
  };

  return (
    <li
      aria-label={`Reservation for ${reservation.guestName}`}
      className={`rounded border-2 p-3 ${STATUS_STYLES[reservation.status]}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">
            {formatTime(reservation.reservationAt, timeZone)} · {reservation.guestName}
          </h3>
          <GuestMarks guest={reservation.guest} />
          <p className="text-sm">
            {reservation.source === "ONLINE" && (
              <span className="mr-2 rounded bg-brand-700 px-2 py-0.5 text-xs font-medium text-white">Online</span>
            )}
            Party of {reservation.partySize} · {reservation.expectedDurationMinutes} min
            {reservation.hasSpecialRequests && (
              <span className="ml-2 rounded bg-neutral-900 px-2 py-0.5 text-xs font-medium text-white">
                Special request
              </span>
            )}
          </p>
        </div>
        <StatusBadge domain="reservation" status={reservation.status} className="text-sm" />
      </div>
      {reservation.specialRequests && (
        <p className="mt-1 text-sm">Request: {reservation.specialRequests}</p>
      )}
      {reservation.phone && <p className="text-sm">Phone: {reservation.phone}</p>}
      <p className="mt-1 text-sm">
        Planned:{" "}
        {reservation.plannedTables.length > 0
          ? reservation.plannedTables.map((table) => table.tableNumber).join(" + ")
          : reservation.planningHistory.length > 0
            ? `${[...new Set(reservation.planningHistory.map((row) => row.tableNumber))].join(" + ")} (ended)`
            : "none"}
      </p>
      {reservation.actualSeating && (
        <p className="text-sm">
          Seated at {reservation.actualSeating.tables.map((table) => table.tableNumber).join(" + ")}
          {reservation.actualSeating.sessionStatus === "COMPLETED" ? " (visit ended)" : ""}
        </p>
      )}
      {active && abilities.manage && (
        <div className="mt-2 flex flex-wrap gap-2">
          {reservation.status === "PENDING" && (
            <button
              type="button"
              disabled={pending}
              className={BUTTON_CLASS}
              onClick={() => submit("POST", `${base}/confirm`, version)}
            >
              Confirm
            </button>
          )}
          {reservation.status === "CONFIRMED" && (
            <button
              type="button"
              disabled={pending}
              className={BUTTON_CLASS}
              onClick={() => submit("POST", `${base}/check-in`, version)}
            >
              Check in
            </button>
          )}
          {abilities.seat && reservation.status !== "PENDING" && (
            <button type="button" className={BUTTON_CLASS} onClick={() => setPanel("seat")}>
              Seat
            </button>
          )}
          <button type="button" className={BUTTON_CLASS} onClick={() => setPanel("edit")}>
            Edit
          </button>
          <button type="button" className={BUTTON_CLASS} onClick={() => setPanel("plan")}>
            Plan tables
          </button>
          <button type="button" className={BUTTON_CLASS} onClick={() => setPanel("cancel")}>
            Cancel
          </button>
          {(abilities.guests.manage || abilities.guests.view) && (
            <button type="button" className={BUTTON_CLASS} onClick={() => setPanel(panel === "guest" ? null : "guest")}>
              Guest &amp; allergies
            </button>
          )}
          {reservation.status === "CONFIRMED" && (
            <button
              type="button"
              disabled={pending || !noShowOpen}
              title={
                noShowOpen
                  ? undefined
                  : `Available from ${formatTime(reservation.noShowAllowedAt, timeZone)}`
              }
              className={BUTTON_CLASS}
              onClick={() => submit("POST", `${base}/no-show`, version)}
            >
              No-show
            </button>
          )}
        </div>
      )}
      {(abilities.messages.view || abilities.manage || (abilities.eraseVisit && !reservation.guest.profile)) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {(abilities.messages.view || abilities.manage) && (
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={() => setPanel(panel === "messages" ? null : "messages")}
            >
              Messages
            </button>
          )}
          {abilities.eraseVisit && !reservation.guest.profile && reservation.guestName !== "Erased guest" && (
            <button type="button" className={BUTTON_CLASS} onClick={() => setPanel(panel === "erase" ? null : "erase")}>
              Erase guest details
            </button>
          )}
        </div>
      )}
      {panel === "erase" && <EraseVisitPanel reservation={reservation} onDone={close} />}
      <ErrorText error={error} />
      {panel === "messages" && (
        <GuestMessagesPanel
          subject={{ type: "reservation", id: reservation.id, status: reservation.status }}
          partyId={reservation.guestPartyId}
          consent={reservation.messageConsent}
          canManageConsent={abilities.manage && active}
          abilities={abilities.messages}
          timeZone={timeZone}
        />
      )}
      {panel === "edit" && (
        <div className="mt-3">
          <ReservationForm
            tables={tables}
            initial={initial}
            mode={{ type: "edit", reservation }}
            onDone={close}
          />
        </div>
      )}
      {panel === "plan" && (
        <PlanPanel reservation={reservation} tables={tables} timeZone={timeZone} onDone={close} />
      )}
      {panel === "seat" && (
        <SeatPanel reservation={reservation} tables={tables} abilities={abilities} onDone={close} />
      )}
      {panel === "cancel" && <CancelPanel reservation={reservation} onDone={close} />}
      {panel === "guest" && (
        <PartyGuestPanel
          partyId={reservation.guestPartyId}
          guestName={reservation.guestName}
          guest={reservation.guest}
          allergens={abilities.allergens}
          abilities={abilities.guests}
        />
      )}
    </li>
  );
}

export function ReservationsBoard({
  reservations,
  tables,
  timeZone,
  nowIso,
  businessDate,
  defaultDate,
  defaultDurationMinutes,
  abilities,
}: ReservationsBoardProps) {
  useRefresh();

  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [creating, setCreating] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const visible = reservations.filter(
    (reservation) =>
      showEnded || ACTIVE.includes(reservation.status) || reservation.status === "SEATED",
  );
  const days = [...new Set(visible.map((reservation) => reservation.businessDate))];
  const checkedIn = reservations.filter((reservation) => reservation.status === "CHECKED_IN");

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {abilities.manage && (
          <button type="button" className={PRIMARY_CLASS} onClick={() => setCreating(true)}>
            New reservation
          </button>
        )}
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showEnded}
            onChange={(event) => setShowEnded(event.target.checked)}
            className="size-5"
          />
          Show completed, cancelled and no-shows
        </label>
      </div>
      {creating && (
        <ReservationForm
          tables={tables}
          initial={{
            guestName: "",
            partySize: "2",
            phone: "",
            email: "",
            specialRequests: "",
            localDate: defaultDate,
            localTime: "19:00",
            expectedDurationMinutes: String(defaultDurationMinutes),
            notes: "",
          }}
          mode={{ type: "create" }}
          onDone={() => setCreating(false)}
          guests={abilities.guests}
        />
      )}
      {checkedIn.length > 0 && (
        <p role="status" className="mb-4 text-sm font-medium">
          Waiting to be seated:{" "}
          {checkedIn.map((reservation) => `${reservation.guestName} (${reservation.partySize})`).join(", ")}
        </p>
      )}
      {days.length === 0 && (
        <EmptyState title="No reservations for these days." />
      )}
      {days.map((day) => {
        const first = visible.find((reservation) => reservation.businessDate === day)!;

        return (
          <section key={day} className="mb-8">
            <h2 className="mb-3 text-lg font-semibold">
              {day === businessDate ? "Today" : "Upcoming"} ·{" "}
              {formatDay(first.reservationAt, timeZone)}
            </h2>
            <ul className="grid gap-3 lg:grid-cols-2">
              {visible
                .filter((reservation) => reservation.businessDate === day)
                .map((reservation) => (
                  <ReservationCard
                    key={reservation.id}
                    reservation={reservation}
                    tables={tables}
                    timeZone={timeZone}
                    now={now}
                    abilities={abilities}
                    defaultDurationMinutes={defaultDurationMinutes}
                  />
                ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
