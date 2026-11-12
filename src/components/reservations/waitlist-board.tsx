"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import type { Recommendation } from "@/modules/reservations/rules/table-recommendation";
import type { WaitlistView } from "@/modules/reservations/services/waitlist-service";

import {
  BUTTON_CLASS,
  ErrorText,
  formatTime,
  INPUT_CLASS,
  minutesBetween,
  PRIMARY_CLASS,
  TablePicker,
  toggled,
  useSubmit,
  type HostTableOption,
} from "./shared";
import { GuestPicker, type PickedGuest } from "./guest-picker";
import { GuestMarks, PartyGuestPanel, type AllergenOption, type HostGuestAbilities } from "./party-guest-panel";
import { StatusBadge } from "@/components/format/status-badge";

export type WaitlistAbilities = {
  manage: boolean;
  notify: boolean;
  seat: boolean;
  overrideHold: boolean;
  capacityOverride: boolean;
  /** Phase 21: guest profiles and visit allergies at the host stand. */
  guests: HostGuestAbilities;
  allergens: AllergenOption[];
};

type WaitlistBoardProps = {
  entries: WaitlistView[];
  tables: HostTableOption[];
  areas: { id: string; name: string }[];
  /** Entry ID to its ranked table suggestions. */
  recommendations: Record<string, Recommendation[]>;
  timeZone: string;
  nowIso: string;
  abilities: WaitlistAbilities;
};

function useRefresh(): void {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 30_000);

    return () => clearInterval(timer);
  }, [router]);
}

function AddForm({
  areas,
  tables,
  abilities,
}: {
  areas: WaitlistBoardProps["areas"];
  tables: readonly HostTableOption[];
  abilities: WaitlistAbilities;
}) {
  const { submit, pending, error } = useSubmit();
  const [name, setName] = useState("");
  const [size, setSize] = useState("2");
  const [phone, setPhone] = useState("");
  const [quote, setQuote] = useState("");
  const [area, setArea] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [seatNow, setSeatNow] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [holdReason, setHoldReason] = useState("");
  const [profile, setProfile] = useState<PickedGuest | null>(null);

  async function suggest() {
    const response = await fetch(`/api/waitlist/quote?partySize=${Number(size) || 1}`);

    if (!response.ok) {
      return;
    }

    const result = (await response.json()) as { minutes: number | null; note: string };

    setSuggestion(
      result.minutes === null
        ? result.note
        : `Estimate: ${result.minutes} min. ${result.note}`,
    );

    if (result.minutes !== null) {
      setQuote(String(result.minutes));
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const guest = {
      guestName: name,
      partySize: Number(size),
      phone: phone || null,
      guestProfileId: profile?.id ?? null,
    };
    const saved = seatNow
      ? await submit("POST", "/api/waitlist/walk-in", {
          ...guest,
          tableIds: chosen,
          holdOverrideReason: holdReason.trim() || null,
        })
      : await submit("POST", "/api/waitlist", {
          ...guest,
          quotedWaitMinutes: quote === "" ? null : Number(quote),
          preferredAreaId: area || null,
        });

    if (saved) {
      setName("");
      setPhone("");
      setQuote("");
      setSuggestion(null);
      setChosen([]);
      setHoldReason("");
      setProfile(null);
    }
  }

  const heldChosen = tables.some((table) => chosen.includes(table.id) && table.held);

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Add walk-in"
      className="mb-6 grid gap-3 rounded-md border border-neutral-300 p-4"
    >
      <h2 className="font-semibold">Add walk-in</h2>
      {abilities.guests.manage && (
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
                setName((current) => current || picked.displayName);
              }}
            />
          )}
        </div>
      )}
      <label className="grid gap-1 text-sm font-medium">
        Guest name
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Party size
        <input
          required
          type="number"
          min={1}
          max={500}
          value={size}
          onChange={(event) => setSize(event.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Phone (optional)
        <input value={phone} onChange={(event) => setPhone(event.target.value)} className={INPUT_CLASS} />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={seatNow}
          onChange={(event) => setSeatNow(event.target.checked)}
          className="size-5"
        />
        Seat now, without waiting
      </label>
      {seatNow ? (
        <>
          <TablePicker
            legend="Seat at"
            tables={tables}
            chosen={chosen}
            onToggle={(id) => setChosen((current) => toggled(current, id))}
            onlyAvailable
          />
          {heldChosen && (
            <label className="grid gap-1 text-sm font-medium">
              {abilities.overrideHold
                ? "Hold override reason (a chosen table is held for a reservation)"
                : "A chosen table is held for a reservation. A manager can override this."}
              {abilities.overrideHold && (
                <input
                  value={holdReason}
                  onChange={(event) => setHoldReason(event.target.value)}
                  className={INPUT_CLASS}
                />
              )}
            </label>
          )}
        </>
      ) : (
        <>
          <label className="grid gap-1 text-sm font-medium">
            Quoted wait (minutes)
            <input
              type="number"
              min={0}
              value={quote}
              onChange={(event) => setQuote(event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <div>
            <button type="button" onClick={suggest} className={BUTTON_CLASS}>
              Suggest a quote
            </button>
            {suggestion && (
              <p role="status" className="mt-1 text-sm text-neutral-700">
                {suggestion}
              </p>
            )}
          </div>
          <label className="grid gap-1 text-sm font-medium">
            Area preference
            <select value={area} onChange={(event) => setArea(event.target.value)} className={INPUT_CLASS}>
              <option value="">No preference</option>
              {areas.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <ErrorText error={error} />
      <div>
        <button
          type="submit"
          disabled={pending || (seatNow && chosen.length === 0)}
          className={PRIMARY_CLASS}
        >
          {seatNow ? "Seat walk-in" : "Add to waitlist"}
        </button>
      </div>
    </form>
  );
}

function SeatPanel({
  entry,
  tables,
  suggestions,
  abilities,
  onDone,
}: {
  entry: WaitlistView;
  tables: readonly HostTableOption[];
  suggestions: readonly Recommendation[];
  abilities: WaitlistAbilities;
  onDone: () => void;
}) {
  const { submit, pending, error } = useSubmit();
  const [chosen, setChosen] = useState<string[]>(entry.assignedTables.map((table) => table.id));
  const [holdReason, setHoldReason] = useState("");
  const [capacityReason, setCapacityReason] = useState("");
  const capacity = tables
    .filter((table) => chosen.includes(table.id))
    .reduce((sum, table) => sum + table.capacity, 0);
  const heldChosen = tables.some((table) => chosen.includes(table.id) && table.held);
  const base = `/api/waitlist/${entry.id}`;

  return (
    <form
      aria-label="Seat waitlist party"
      className="mt-3 grid gap-3 rounded-md border border-neutral-300 p-3"
      onSubmit={async (event) => {
        event.preventDefault();

        if (
          await submit("POST", `${base}/seat`, {
            tableIds: chosen,
            holdOverrideReason: holdReason.trim() || null,
            capacityOverrideReason: capacityReason.trim() || null,
            expectedVersion: entry.version,
          })
        ) {
          onDone();
        }
      }}
    >
      <ul className="flex flex-wrap gap-2" aria-label="Suggested tables">
        {suggestions.length === 0 && (
          <li className="text-sm text-neutral-600">No table or combination fits right now.</li>
        )}
        {suggestions.map((row) => (
          <li key={row.tableIds.join("+")}>
            <button type="button" className={BUTTON_CLASS} onClick={() => setChosen(row.tableIds)}>
              Use {row.tableNumbers.join(" + ")} (seats {row.capacity})
            </button>
          </li>
        ))}
      </ul>
      <TablePicker
        legend="Seat at"
        tables={tables}
        chosen={chosen}
        onToggle={(id) => setChosen((current) => toggled(current, id))}
        onlyAvailable
      />
      {heldChosen && (
        <div className="grid gap-2 rounded border border-warning-500 bg-warning-50 p-3">
          <p className="text-sm font-medium">A chosen table is held for a reservation.</p>
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
      {chosen.length > 0 && entry.partySize > capacity && (
        <div className="grid gap-2 rounded border border-warning-500 bg-warning-50 p-3">
          <p className="text-sm font-medium">
            This party of {entry.partySize} is over the capacity of {capacity}.
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
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || chosen.length === 0} className={PRIMARY_CLASS}>
          Seat party
        </button>
        {abilities.manage && (
          <button
            type="button"
            disabled={pending || chosen.length === 0}
            className={BUTTON_CLASS}
            onClick={async () => {
              if (
                await submit("POST", `${base}/tables`, {
                  tableIds: chosen,
                  expectedVersion: entry.version,
                })
              ) {
                onDone();
              }
            }}
          >
            Save chosen tables
          </button>
        )}
        <button type="button" onClick={onDone} className={BUTTON_CLASS}>
          Close
        </button>
      </div>
    </form>
  );
}

function QuoteForm({ entry, onDone }: { entry: WaitlistView; onDone: () => void }) {
  const { submit, pending, error } = useSubmit();
  const [quote, setQuote] = useState(entry.quotedWaitMinutes?.toString() ?? "");

  return (
    <form
      aria-label="Edit quote"
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={async (event) => {
        event.preventDefault();

        if (
          await submit("PUT", `/api/waitlist/${entry.id}`, {
            quotedWaitMinutes: quote === "" ? null : Number(quote),
            expectedVersion: entry.version,
          })
        ) {
          onDone();
        }
      }}
    >
      <label className="grid gap-1 text-sm font-medium">
        Quoted wait (minutes)
        <input
          type="number"
          min={0}
          value={quote}
          onChange={(event) => setQuote(event.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <button type="submit" disabled={pending} className={PRIMARY_CLASS}>
        Save quote
      </button>
      <button type="button" onClick={onDone} className={BUTTON_CLASS}>
        Close
      </button>
      <ErrorText error={error} />
    </form>
  );
}

function EntryCard({
  entry,
  tables,
  areas,
  suggestions,
  timeZone,
  now,
  abilities,
}: {
  entry: WaitlistView;
  tables: readonly HostTableOption[];
  areas: WaitlistBoardProps["areas"];
  suggestions: readonly Recommendation[];
  timeZone: string;
  now: Date;
  abilities: WaitlistAbilities;
}) {
  const { submit, pending, error } = useSubmit();
  const [panel, setPanel] = useState<"seat" | "quote" | "guest" | null>(null);
  const close = () => setPanel(null);
  const base = `/api/waitlist/${entry.id}`;
  const version = { expectedVersion: entry.version };
  const waited = minutesBetween(entry.addedAt, now);
  const area = areas.find((row) => row.id === entry.preferredAreaId);
  const [best] = suggestions;

  return (
    <li
      aria-label={`Waitlist entry for ${entry.guestName}`}
      className="rounded border-2 border-neutral-400 bg-white p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">{entry.guestName}</h3>
          <GuestMarks guest={entry.guest} />
          <p className="text-sm">
            Party of {entry.partySize} · added {formatTime(entry.addedAt, timeZone)} · waiting{" "}
            {waited} min
          </p>
        </div>
        <StatusBadge domain="waitlist" status={entry.status} className="text-sm" />
      </div>
      <p className="text-sm">
        Quoted wait: {entry.quotedWaitMinutes === null ? "none" : `${entry.quotedWaitMinutes} min`}
        {area ? ` · prefers ${area.name}` : ""}
        {entry.hasReservation ? " · has a reservation" : ""}
      </p>
      {entry.phone && <p className="text-sm">Phone: {entry.phone}</p>}
      {entry.notifiedAt && (
        <p className="text-sm">Notified at {formatTime(entry.notifiedAt, timeZone)}</p>
      )}
      {entry.assignedTables.length > 0 && (
        <p className="text-sm">
          Chosen tables: {entry.assignedTables.map((table) => table.tableNumber).join(" + ")}
        </p>
      )}
      <p className="text-sm text-neutral-700">
        Suggested: {best ? `${best.tableNumbers.join(" + ")} (seats ${best.capacity})` : "nothing fits right now"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {(abilities.guests.manage || abilities.guests.view) && (
          <button type="button" className={BUTTON_CLASS} onClick={() => setPanel(panel === "guest" ? null : "guest")}>
            Guest &amp; allergies
          </button>
        )}
        {abilities.manage && (
          <button type="button" className={BUTTON_CLASS} onClick={() => setPanel("quote")}>
            Edit quote
          </button>
        )}
        {abilities.notify && entry.status === "WAITING" && (
          <button
            type="button"
            disabled={pending}
            className={BUTTON_CLASS}
            onClick={() => submit("POST", `${base}/notify`, version)}
          >
            Mark notified
          </button>
        )}
        {abilities.seat && (
          <button type="button" className={BUTTON_CLASS} onClick={() => setPanel("seat")}>
            Seat
          </button>
        )}
        {abilities.manage && (
          <>
            <button
              type="button"
              disabled={pending}
              className={BUTTON_CLASS}
              onClick={() => submit("POST", `${base}/remove`, { ...version, outcome: "LEFT" })}
            >
              Left
            </button>
            <button
              type="button"
              disabled={pending}
              className={BUTTON_CLASS}
              onClick={() => submit("POST", `${base}/remove`, { ...version, outcome: "CANCELLED" })}
            >
              Cancel
            </button>
          </>
        )}
      </div>
      <ErrorText error={error} />
      {panel === "quote" && <QuoteForm entry={entry} onDone={close} />}
      {panel === "guest" && (
        <PartyGuestPanel
          partyId={entry.guestPartyId}
          guestName={entry.guestName}
          guest={entry.guest}
          allergens={abilities.allergens}
          abilities={abilities.guests}
        />
      )}
      {panel === "seat" && (
        <SeatPanel
          entry={entry}
          tables={tables}
          suggestions={suggestions}
          abilities={abilities}
          onDone={close}
        />
      )}
    </li>
  );
}

export function WaitlistBoard({
  entries,
  tables,
  areas,
  recommendations,
  timeZone,
  nowIso,
  abilities,
}: WaitlistBoardProps) {
  useRefresh();

  const now = useMemo(() => new Date(nowIso), [nowIso]);

  return (
    <>
      {abilities.manage && <AddForm areas={areas} tables={tables} abilities={abilities} />}
      <section aria-label="Waiting parties">
        <h2 className="mb-3 text-lg font-semibold">Waiting ({entries.length})</h2>
        {entries.length === 0 && <p className="text-neutral-600">Nobody is waiting.</p>}
        <ul className="grid gap-3 lg:grid-cols-2">
          {entries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              tables={tables}
              areas={areas}
              suggestions={recommendations[entry.id] ?? []}
              timeZone={timeZone}
              now={now}
              abilities={abilities}
            />
          ))}
        </ul>
      </section>
    </>
  );
}
