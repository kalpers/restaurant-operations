import { toClientChecks } from "@/components/restaurant/temperature-checks";
import { TemperatureLogWorkspace } from "@/components/restaurant/temperature-log-workspace";
import { Button, ButtonLink } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds, readLocationClock } from "@/modules/restaurant/services/access";
import { listChecksDue, listTemperatureReadings } from "@/modules/restaurant/services/temperature-service";
import { temperatureLogQuerySchema } from "@/modules/restaurant/validators/temperature-validators";
import { AppError } from "@/shared/errors/app-error";

type SearchParams = Record<string, string | string[] | undefined>;

/** Phase 36 (policy 6): the temperature log, what's due, and recording a reading. */
export default async function TemperatureLogPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { actor } = await requirePageActor("food-safety.view");
  const database = getDatabase();
  const clock = await readLocationClock(database, actor.locationId, new Date());
  const raw = await searchParams;
  const pick = (name: string) => (typeof raw[name] === "string" && raw[name] !== "" ? (raw[name] as string) : undefined);
  const parsed = temperatureLogQuerySchema.safeParse({
    from: pick("from") ?? clock.businessDate,
    to: pick("to") ?? clock.businessDate,
    pointId: pick("pointId"),
    outOfRangeOnly: pick("outOfRangeOnly") === "on" ? "true" : undefined,
  });
  const due = await listChecksDue(database, actor);
  let problem: string | null = parsed.success ? null : "Choose valid dates.";
  let readings: Awaited<ReturnType<typeof listTemperatureReadings>> = [];

  if (parsed.success) {
    try {
      readings = await listTemperatureReadings(database, actor, parsed.data);
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }

      problem = error.message;
    }
  }

  const exportQuery = parsed.success
    ? new URLSearchParams({
        from: parsed.data.from,
        to: parsed.data.to,
        ...(parsed.data.pointId ? { pointId: parsed.data.pointId } : {}),
        ...(parsed.data.outOfRangeOnly ? { outOfRangeOnly: "true" } : {}),
      }).toString()
    : "";

  return (
    <>
      <PageHeader
        title="Temperature log"
        description={`Food-safety temperature checks (business date ${clock.businessDate}). Readings are never changed: a mistake is fixed by a correcting reading.`}
        actions={
          <>
            {actorHolds(actor, "reports.export") && parsed.success && (
              <ButtonLink href={`/api/temperature-log/export?${exportQuery}`} variant="secondary">
                Export CSV
              </ButtonLink>
            )}
            {actorHolds(actor, "food-safety.manage") && (
              <ButtonLink href="/temperature-log/points" variant="secondary">
                Set up check points
              </ButtonLink>
            )}
          </>
        }
      />
      <form method="get" aria-label="Choose dates" className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" name="from" defaultValue={parsed.success ? parsed.data.from : clock.businessDate} />
        </Field>
        <Field label="To">
          <Input type="date" name="to" defaultValue={parsed.success ? parsed.data.to : clock.businessDate} />
        </Field>
        <Field label="Check point">
          <Select name="pointId" defaultValue={parsed.success ? (parsed.data.pointId ?? "") : ""}>
            <option value="">All</option>
            {due.checks.map((check) => (
              <option key={check.point.id} value={check.point.id}>
                {check.point.name}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox name="outOfRangeOnly" label="Out of range only" defaultChecked={parsed.success && parsed.data.outOfRangeOnly} />
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      {problem && (
        <p role="alert" className="mb-4 rounded border border-danger-300 bg-danger-50 p-3 text-danger-800">
          {problem}
        </p>
      )}
      <TemperatureLogWorkspace
        checks={toClientChecks(due.checks)}
        readings={readings}
        canRecord={actorHolds(actor, "food-safety.record")}
        timeZone={clock.timeZone}
      />
    </>
  );
}
