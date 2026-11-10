import { FileClock } from "lucide-react";
import Link from "next/link";

import { AuditChanges, CopyId } from "@/components/audit/audit-changes";
import { actionLabel, entityHref, entityLabel, shortId } from "@/components/audit/audit-format";
import { humanizeCode } from "@/components/format/status-labels";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
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
import { INPUT_BASE } from "@/components/ui/field";

const INPUT_CLASS = INPUT_BASE;

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(iso));
}

function EventRow({ event, timeZone }: { event: AuditEventView; timeZone: string }) {
  const hasPayload = event.before !== null || event.after !== null || event.details !== null;
  const href = entityHref(event.entityType, event.entityId);

  return (
    <Tr aria-label={`Audit ${event.action}`}>
      <Td className="whitespace-nowrap">{formatTime(event.occurredAt, timeZone)}</Td>
      <Td>{event.actorType === "SYSTEM" ? "System" : (event.actorName ?? "Unknown user")}</Td>
      <Td>
        <span className="font-medium">{actionLabel(event.action)}</span>
        <span className="block text-xs text-neutral-600">
          {humanizeCode(event.category)} · <code>{event.action}</code>
        </span>
      </Td>
      <Td>
        {href ? (
          <Link href={href} className="font-medium text-brand-800 underline-offset-2 hover:underline">
            {entityLabel(event.entityType)}
          </Link>
        ) : (
          entityLabel(event.entityType)
        )}
        {event.entityId && (
          <span className="block">
            <CopyId id={event.entityId} label={shortId(event.entityId)} />
          </span>
        )}
      </Td>
      <Td className="min-w-64">
        {hasPayload ? (
          <AuditChanges before={event.before} after={event.after} details={event.details} />
        ) : (
          <span className="text-neutral-600">None</span>
        )}
      </Td>
    </Tr>
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
                {humanizeCode(category)}
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
                {actionLabel(action)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary">
          Filter
        </Button>
      </form>

      {error && (
        <p role="alert" className="mb-4 rounded border border-danger-300 bg-danger-50 p-3 text-danger-800">
          {error}
        </p>
      )}

      {page && page.events.length === 0 && (
        <EmptyState icon={FileClock} title="No audit events match">
          Widen the date range or clear the category and action filters.
        </EmptyState>
      )}

      {page && page.events.length > 0 && (
        <>
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <Th>When</Th>
                  <Th>Who</Th>
                  <Th>Action</Th>
                  <Th>Record</Th>
                  <Th>Changes</Th>
                </tr>
              </THead>
              <TBody>
                {page.events.map((event) => (
                  <EventRow key={event.sequence} event={event} timeZone={page.timeZone} />
                ))}
              </TBody>
            </Table>
          </TableFrame>
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
