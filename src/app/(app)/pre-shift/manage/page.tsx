import { PreShiftManager } from "@/components/restaurant/pre-shift-manager";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listNotesForManager, listNoteTargets } from "@/modules/restaurant/services/pre-shift-service";
import { noteRangeSchema } from "@/modules/restaurant/validators/briefing-validators";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { NOTE_DAYS_AHEAD } from "@/modules/restaurant/rules/pre-shift-rules";
import { AppError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

type SearchParams = Record<string, string | string[] | undefined>;

/** Phase 32 (policies 7–9): every note in a range, with writing, editing and withdrawing. */
export default async function ManagePreShiftPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { actor } = await requirePageActor("pre-shift.manage");
  const database = getDatabase();
  const today = (await readLocationClock(database, actor.locationId, new Date())).businessDate;
  const raw = await searchParams;
  const pick = (name: string, fallback: string) => (typeof raw[name] === "string" && raw[name] !== "" ? (raw[name] as string) : fallback);
  const parsed = noteRangeSchema.safeParse({ from: pick("from", today), to: pick("to", addDays(today, NOTE_DAYS_AHEAD)) });
  let problem: string | null = parsed.success ? null : "Choose valid dates.";
  let notes: Awaited<ReturnType<typeof listNotesForManager>>["notes"] = [];

  if (parsed.success) {
    try {
      notes = (await listNotesForManager(database, actor, parsed.data)).notes;
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }

      problem = error.message;
    }
  }

  const positions = await listNoteTargets(database, actor);

  return (
    <>
      <PageHeader
        title="Manage pre-shift notes"
        description={`Write notes for today or up to ${NOTE_DAYS_AHEAD} days ahead. A note can be changed or withdrawn until its date has passed. Choosing positions decides who sees it on their pre-shift page; it doesn't keep it from anyone.`}
        breadcrumbs={[{ label: "Pre-shift", href: "/pre-shift" }, { label: "Manage notes" }]}
      />
      <form method="get" aria-label="Choose dates" className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" name="from" defaultValue={parsed.success ? parsed.data.from : today} />
        </Field>
        <Field label="To">
          <Input type="date" name="to" defaultValue={parsed.success ? parsed.data.to : addDays(today, NOTE_DAYS_AHEAD)} />
        </Field>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      {problem && (
        <p role="alert" className="mb-4 rounded border border-danger-300 bg-danger-50 p-3 text-danger-800">
          {problem}
        </p>
      )}
      <PreShiftManager
        notes={notes}
        positions={positions.map(({ id, name }) => ({ id, name }))}
        today={today}
        canRedact={actor.permissions.has("manager-log.redact")}
      />
    </>
  );
}
