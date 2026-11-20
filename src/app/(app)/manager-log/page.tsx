import Link from "next/link";

import { ManagerLogWorkspace } from "@/components/restaurant/manager-log-workspace";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/restaurant/services/access";
import { listLogCategories } from "@/modules/restaurant/services/manager-log-category-service";
import { currentLogDate, listLogEntries } from "@/modules/restaurant/services/manager-log-service";
import { logQuerySchema } from "@/modules/restaurant/validators/briefing-validators";
import { AppError } from "@/shared/errors/app-error";

type SearchParams = Record<string, string | string[] | undefined>;

function single(params: SearchParams, name: string): string | undefined {
  const value = params[name];

  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Phase 32 manager log (policies 3–6, 10). One business date at a time, or a search across
 * up to 31 days by text and category. Managers only.
 */
export default async function ManagerLogPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { actor } = await requirePageActor("manager-log.view");
  const database = getDatabase();
  const currentDate = await currentLogDate(database, actor);
  const categories = await listLogCategories(database, actor);
  const raw = await searchParams;
  const searching = Boolean(single(raw, "from") || single(raw, "to") || single(raw, "q"));
  const parsed = logQuerySchema.safeParse(
    searching
      ? { from: single(raw, "from") ?? currentDate, to: single(raw, "to") ?? currentDate, category: single(raw, "category"), q: single(raw, "q") }
      : { date: single(raw, "date") ?? currentDate, category: single(raw, "category") },
  );
  let problem: string | null = parsed.success ? null : "Choose valid dates.";
  let result: Awaited<ReturnType<typeof listLogEntries>> = { entries: [], truncated: false };

  if (parsed.success) {
    try {
      result = await listLogEntries(database, actor, {
        from: parsed.data.date ?? parsed.data.from!,
        to: parsed.data.date ?? parsed.data.to!,
        category: parsed.data.category ?? null,
        text: parsed.data.q ?? null,
      });
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }

      problem = error.message;
    }
  }

  const shownDate = parsed.success && parsed.data.date ? parsed.data.date : currentDate;

  return (
    <>
      <PageHeader
        title="Manager log"
        description="What happened at this location, by business date. Entries can't be edited or deleted; a correction is a new entry."
        actions={
          actorHolds(actor, "manager-log.categories") ? (
            <Link href="/manager-log/categories" className="text-sm font-medium underline">
              Categories
            </Link>
          ) : undefined
        }
      />
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <form method="get" aria-label="Choose a business date" className="flex flex-wrap items-end gap-3">
          <Field label="Business date">
            <Input type="date" name="date" defaultValue={shownDate} />
          </Field>
          <Field label="Category">
            <Select name="category" defaultValue={!searching ? (single(raw, "category") ?? "") : ""}>
              <option value="">All</option>
              {categories.map((category) => (
                <option key={category.code} value={category.code}>
                  {category.active ? category.name : `${category.name} (inactive)`}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="secondary">
            Show
          </Button>
        </form>
        <form method="get" aria-label="Search the log" className="flex flex-wrap items-end gap-3">
          <Field label="Search text">
            <Input type="search" name="q" defaultValue={single(raw, "q") ?? ""} maxLength={200} />
          </Field>
          <Field label="From">
            <Input type="date" name="from" defaultValue={single(raw, "from") ?? currentDate} />
          </Field>
          <Field label="To">
            <Input type="date" name="to" defaultValue={single(raw, "to") ?? currentDate} />
          </Field>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>
      {searching ? (
        <p className="mb-4 text-sm text-neutral-700">
          Search results, up to 31 days.{" "}
          <Link href="/manager-log" className="font-medium underline">
            Back to today
          </Link>
        </p>
      ) : (
        <h2 className="mb-4 text-lg font-semibold">
          {shownDate === currentDate ? `Today, ${shownDate}` : `Business date ${shownDate}`}
        </h2>
      )}
      {problem && (
        <p role="alert" className="mb-4 rounded border border-danger-300 bg-danger-50 p-3 text-danger-800">
          {problem}
        </p>
      )}
      {result.truncated && <p className="mb-4 text-sm text-neutral-700">Showing the first 300 entries. Narrow the search to see the rest.</p>}
      <ManagerLogWorkspace
        entries={result.entries}
        categories={categories.map(({ code, name, active }) => ({ code, name, active }))}
        abilities={{ write: actorHolds(actor, "manager-log.write"), redact: actorHolds(actor, "manager-log.redact") }}
        currentDate={currentDate}
        showDates={searching}
      />
    </>
  );
}
