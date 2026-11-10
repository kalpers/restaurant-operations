import Link from "next/link";

import { getDatabase } from "@/db";
import { AUDIT_CATEGORIES } from "@/db/schema/auditing";
import {
  AUDIT_ACTIONS,
  type AuditEventView,
  auditFiltersSchema,
  currentAuditBusinessDate,
  listAuditEvents,
} from "@/modules/auditing";
import { requirePageActor } from "@/modules/auth/guards";
import { AppError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

const INPUT_CLASS = "min-h-11 rounded border border-neutral-300 bg-white px-3 py-2 text-base";

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(iso));
}

function Payload({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) {
    return null;
  }

  return (
    <div>
      <dt className="font-medium">{label}</dt>
      <dd>
        <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(value, null, 2)}</pre>
      </dd>
    </div>
  );
}

function EventRow({ event, timeZone }: { event: AuditEventView; timeZone: string }) {
  const hasPayload = event.before !== null || event.after !== null || event.details !== null;

  return (
    <tr aria-label={`Audit ${event.action}`} className="border-b border-neutral-100 align-top">
      <td className="whitespace-nowrap py-2 pr-3">{formatTime(event.occurredAt, timeZone)}</td>
      <td className="py-2 pr-3">{event.actorType === "SYSTEM" ? "System" : (event.actorName ?? "Unknown user")}</td>
      <td className="py-2 pr-3">
        <span className="font-medium">{event.action}</span>
        <span className="block text-xs text-neutral-600">{event.category}</span>
      </td>
      <td className="py-2 pr-3">
        {event.entityType}
        {event.entityId && <span className="block break-all text-xs text-neutral-600">{event.entityId}</span>}
      </td>
      <td className="py-2">
        {hasPayload ? (
          <details>
            <summary className="min-h-11 cursor-pointer py-2">Show</summary>
            <dl className="mt-2 grid gap-2">
              <Payload label="Before" value={event.before} />
              <Payload label="After" value={event.after} />
              <Payload label="Details" value={event.details} />
            </dl>
          </details>
        ) : (
          <span className="text-neutral-500">None</span>
        )}
      </td>
    </tr>
  );
}

/**
 * The audit trail: read-only, newest first, for the current location plus organization-level
 * events. Nothing here can be changed, and viewing it is not itself audited.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { location, actor } = await requirePageActor("audit.view");
  const database = getDatabase();
  const today = await currentAuditBusinessDate(database, actor);
  const raw: Record<string, string> = Object.fromEntries(
    Object.entries(await searchParams).flatMap(([key, value]) =>
      typeof value === "string" && value !== "" ? [[key, value]] : [],
    ),
  );
  const parsed = auditFiltersSchema.safeParse({
    from: addDays(today, -6),
    to: today,
    ...raw,
    locationId: location.locationId,
  });
  let page: Awaited<ReturnType<typeof listAuditEvents>> | null = null;
  let error: string | null = parsed.success ? null : "Check the filters.";

  if (parsed.success) {
    try {
      page = await listAuditEvents(database, actor, parsed.data);
    } catch (caught) {
      if (!(caught instanceof AppError)) {
        throw caught;
      }

      error = caught.message;
    }
  }

  const filters = parsed.success ? parsed.data : undefined;
  const olderQuery = new URLSearchParams({ ...raw, before: String(page?.nextBefore ?? "") });

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Audit trail</h1>
      <p className="mb-4 text-neutral-600">
        {location.locationName}, plus organization-wide events such as sign-ins and role changes. Records can&apos;t
        be changed or deleted.
      </p>

      <form method="get" aria-label="Filter audit events" className="mb-6 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm font-medium">
          From business date
          <input type="date" name="from" defaultValue={filters?.from} className={INPUT_CLASS} />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          To business date
          <input type="date" name="to" defaultValue={filters?.to} className={INPUT_CLASS} />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Category
          <select name="category" defaultValue={filters?.category ?? ""} className={INPUT_CLASS}>
            <option value="">All categories</option>
            {AUDIT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Action
          <select name="action" defaultValue={filters?.action ?? ""} className={INPUT_CLASS}>
            <option value="">All actions</option>
            {Object.keys(AUDIT_ACTIONS).map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="min-h-11 rounded border border-neutral-400 px-4 font-medium">
          Filter
        </button>
      </form>

      {error && (
        <p role="alert" className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-red-800">
          {error}
        </p>
      )}

      {page && page.events.length === 0 && <p className="text-neutral-600">No audit events match.</p>}

      {page && page.events.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-300">
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Who</th>
                  <th className="py-2 pr-3">Action</th>
                  <th className="py-2 pr-3">Record</th>
                  <th className="py-2">Changes</th>
                </tr>
              </thead>
              <tbody>
                {page.events.map((event) => (
                  <EventRow key={event.sequence} event={event} timeZone={page.timeZone} />
                ))}
              </tbody>
            </table>
          </div>
          {page.nextBefore && (
            <Link
              href={`/audit?${olderQuery.toString()}`}
              className="mt-4 inline-flex min-h-11 items-center font-medium underline"
            >
              Load older events
            </Link>
          )}
        </>
      )}
    </>
  );
}
