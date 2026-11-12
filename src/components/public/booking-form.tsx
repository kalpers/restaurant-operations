"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldHint, Input, Select, Textarea } from "@/components/ui/field";

// Phase 22 (policies 8, 9 and 12): the guest's booking form. Times come from the server; the
// server checks everything again when the booking is made.

type Allergen = { code: string; name: string };

type Booked = {
  reference: string;
  status: "CONFIRMED" | "PENDING";
  when: string;
  partySize: number;
  locationName: string;
  manageUrl: string;
};

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;

  return body?.error?.message ?? "Something went wrong. Please try again.";
}

export function BookingForm({
  code,
  today,
  lastDate,
  maxPartySize,
  allergens,
}: {
  code: string;
  today: string;
  lastDate: string;
  maxPartySize: number;
  allergens: Allergen[];
}) {
  const [date, setDate] = useState(today);
  const [partySize, setPartySize] = useState(2);
  const [times, setTimes] = useState<string[] | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [requests, setRequests] = useState("");
  const [texts, setTexts] = useState(false);
  const [emails, setEmails] = useState(false);
  const [chosen, setChosen] = useState<Record<string, "ALLERGY" | "SEVERE">>({});
  const [website, setWebsite] = useState("");
  // One key per booking attempt, so a resubmit after a lost reply doesn't book twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/public/locations/${encodeURIComponent(code)}/availability?date=${date}&partySize=${partySize}`,
        );

        if (cancelled) {
          return;
        }

        if (response.ok) {
          const body = (await response.json()) as { times: string[] };

          if (!cancelled) {
            setTimes(body.times);
            setTime((current) => (current && body.times.includes(current) ? current : null));
          }
        } else {
          setTimes([]);
          setError(await readError(response));
        }
      } catch {
        if (!cancelled) {
          setError("Couldn't reach the restaurant. Check your connection and try again.");
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [code, date, partySize]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (!time) {
      setError("Pick a time.");

      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/public/locations/${encodeURIComponent(code)}/reservations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localDate: date,
          localTime: time,
          partySize,
          guestName: name,
          phone: phone || null,
          email: email || null,
          specialRequests: requests || null,
          messageConsent: { sms: texts, email: emails },
          allergies: Object.entries(chosen).map(([allergenCode, severity]) => ({ code: allergenCode, severity })),
          website,
          idempotencyKey,
        }),
      });

      if (response.ok) {
        setBooked((await response.json()) as Booked);
      } else {
        setError(await readError(response));
        // A refused booking wrote nothing, so the next attempt is a new request.
        setIdempotencyKey(crypto.randomUUID());
      }
    } catch {
      setError("Couldn't reach the restaurant. Your booking may not have been made; please try again.");
    } finally {
      setPending(false);
    }
  }

  if (booked) {
    return (
      <section aria-label="Booking made" className="grid gap-3">
        <p role="status" className="text-lg font-semibold">
          {booked.status === "CONFIRMED" ? "Your table is booked." : "We received your request."}
        </p>
        <p>
          {booked.locationName}, {booked.when}, {booked.partySize === 1 ? "1 guest" : `${booked.partySize} guests`}.
          {booked.status === "PENDING" && " We'll confirm it soon."}
        </p>
        <p className="text-sm text-neutral-700">Reference {booked.reference}</p>
        <p className="text-sm">
          Keep this private link to view or cancel your booking:{" "}
          <a className="break-all font-medium text-brand-800 underline" href={booked.manageUrl}>
            {booked.manageUrl}
          </a>
        </p>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Book a table" className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date">
          <Input type="date" required min={today} max={lastDate} value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Field label="Guests">
          <Select value={partySize} onChange={(event) => setPartySize(Number(event.target.value))}>
            {Array.from({ length: maxPartySize }, (_, index) => index + 1).map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <FieldHint>For a larger party, please call us.</FieldHint>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium text-neutral-800">Time</legend>
        {times === null && <p className="text-sm text-neutral-600">Finding times…</p>}
        {times?.length === 0 && <p className="text-sm text-neutral-700">No times are available on this date. Try another day.</p>}
        <div className="flex flex-wrap gap-2">
          {times?.map((option) => (
            <Button
              key={option}
              type="button"
              variant={option === time ? "primary" : "secondary"}
              aria-pressed={option === time}
              onClick={() => setTime(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      </fieldset>
      <Field label="Name">
        <Input required maxLength={120} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mobile phone">
          <Input type="tel" maxLength={40} autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" maxLength={200} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
      </div>
      <FieldHint>Give a phone number or an email address so we can reach you about this booking.</FieldHint>
      <fieldset className="grid gap-1">
        <legend className="text-sm font-medium text-neutral-800">Messages about this booking</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5" checked={texts} onChange={(event) => setTexts(event.target.checked)} />
          Text me about this booking
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5" checked={emails} onChange={(event) => setEmails(event.target.checked)} />
          Email me about this booking
        </label>
        <FieldHint>
          Only this booking&apos;s confirmation, changes and a reminder. Never marketing. Reply STOP to texts, or use
          the link in an email, to stop.
        </FieldHint>
      </fieldset>
      {allergens.length > 0 && (
        <fieldset className="grid gap-1">
          <legend className="text-sm font-medium text-neutral-800">Food allergies in your party</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {allergens.map((allergen) => (
              <div key={allergen.code} className="flex min-h-11 flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={allergen.code in chosen}
                    onChange={(event) =>
                      setChosen((current) => {
                        const next = { ...current };

                        if (event.target.checked) {
                          next[allergen.code] = "ALLERGY";
                        } else {
                          delete next[allergen.code];
                        }

                        return next;
                      })
                    }
                  />
                  {allergen.name}
                </label>
                {allergen.code in chosen && (
                  <label className="flex items-center gap-1 text-neutral-700">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={chosen[allergen.code] === "SEVERE"}
                      onChange={(event) =>
                        setChosen((current) => ({ ...current, [allergen.code]: event.target.checked ? "SEVERE" : "ALLERGY" }))
                      }
                    />
                    severe
                  </label>
                )}
              </div>
            ))}
          </div>
        </fieldset>
      )}
      <Field label="Special requests (optional)">
        <Textarea maxLength={500} rows={3} value={requests} onChange={(event) => setRequests(event.target.value)} />
      </Field>
      {/* The spam trap: hidden from people and from assistive technology. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input tabIndex={-1} autoComplete="off" name="website" value={website} onChange={(event) => setWebsite(event.target.value)} />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending || !time}>
        {pending ? "Booking…" : "Book table"}
      </Button>
    </form>
  );
}
