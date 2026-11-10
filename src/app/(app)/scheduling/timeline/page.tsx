import { z } from "zod";

import {
  ScheduleTimeline,
  type TimelineView,
} from "@/components/scheduling/timeline/schedule-timeline";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getDayTimeline } from "@/modules/scheduling/services/timeline-service";

const searchSchema = z.object({
  date: z.iso.date().optional().catch(undefined),
  view: z.enum(["employee", "position"]).catch("employee"),
  includeDrafts: z.enum(["true", "false"]).catch("true"),
  selected: z.string().max(128).optional().catch(undefined),
});

/** One day of the schedule as a Gantt chart. Read-only; needs `schedule.view`. */
export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor } = await requirePageActor("schedule.view");
  const raw = await searchParams;
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const query = searchSchema.parse({
    date: first(raw.date),
    view: first(raw.view),
    includeDrafts: first(raw.includeDrafts),
    selected: first(raw.selected),
  });
  const data = await getDayTimeline(getDatabase(), actor, {
    date: query.date,
    includeDrafts: query.includeDrafts === "true",
  });
  const view: TimelineView = query.view;

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Schedule timeline</h1>
      <p className="mb-4 text-neutral-600">
        Shifts starting on {data.date}, in {data.timeZone} time. Select a bar for details.
      </p>
      <ScheduleTimeline data={data} view={view} selected={query.selected ?? null} />
    </>
  );
}
