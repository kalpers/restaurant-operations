import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { searchParamsToObject } from "@/modules/reporting/validators/report-filters";
import { addLogEntry, listLogEntries } from "@/modules/restaurant/services/manager-log-service";
import { addLogEntrySchema, logQuerySchema } from "@/modules/restaurant/validators/briefing-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 32 (policy 10): one business date's entries, or a search across up to 31 days. */
export const GET = apiRoute({ module: "restaurant", operation: "list-manager-log" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(logQuerySchema, searchParamsToObject(new URL(request.url).searchParams));

  return {
    body: await listLogEntries(getDatabase(), actor, {
      from: query.date ?? query.from!,
      to: query.date ?? query.to!,
      category: query.category ?? null,
      text: query.q ?? null,
    }),
  };
});

/** Policies 3, 4 and 12: adds an entry (or a correction). Retry-safe with the same key. */
export const POST = apiRoute({ module: "restaurant", operation: "add-manager-log-entry" }, async ({ request }) => {
  const actor = await requireApiActor();
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const body = parseWith(addLogEntrySchema, {
    ...(raw ?? {}),
    idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
  });

  return { body: await addLogEntry(getDatabase(), actor, body), status: 201 };
});
