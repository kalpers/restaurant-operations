import Link from "next/link";

import { ChecklistStatusBadge, CHECKLIST_KIND_LABELS } from "@/components/restaurant/checklist-status-badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { CHECKLIST_KINDS } from "@/db/schema/checklists";
import { requirePageActor } from "@/modules/auth/guards";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { listChecklistHistory } from "@/modules/restaurant/services/checklist-service";
import { checklistHistoryQuerySchema } from "@/modules/restaurant/validators/checklist-validators";
import { AppError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

type SearchParams = Record<string, string | string[] | undefined>;

/** Phase 36 (policy 5): what happened on each date, missed checklists included, up to 31 days. */
export default async function ChecklistHistoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { actor } = await requirePageActor("checklists.view");
  const database = getDatabase();
  const today = (await readLocationClock(database, actor.locationId, new Date())).businessDate;
  const raw = await searchParams;
  const pick = (name: string) => (typeof raw[name] === "string" && raw[name] !== "" ? (raw[name] as string) : undefined);
  const parsed = checklistHistoryQuerySchema.safeParse({
    from: pick("from") ?? addDays(today, -6),
    to: pick("to") ?? today,
    kind: pick("kind"),
  });
  let problem: string | null = parsed.success ? null : "Choose valid dates.";
  let rows: Awaited<ReturnType<typeof listChecklistHistory>>["rows"] = [];

  if (parsed.success) {
    try {
      rows = (await listChecklistHistory(database, actor, parsed.data)).rows;
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }

      problem = error.message;
    }
  }

  return (
    <>
      <PageHeader title="Checklist history" breadcrumbs={[{ label: "Checklists", href: "/checklists" }, { label: "History" }]} />
      <form method="get" aria-label="Choose dates" className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" name="from" defaultValue={parsed.success ? parsed.data.from : addDays(today, -6)} />
        </Field>
        <Field label="To">
          <Input type="date" name="to" defaultValue={parsed.success ? parsed.data.to : today} />
        </Field>
        <Field label="Kind">
          <Select name="kind" defaultValue={parsed.success ? (parsed.data.kind ?? "") : ""}>
            <option value="">All</option>
            {CHECKLIST_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {CHECKLIST_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
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
      {rows.length === 0 ? (
        <EmptyState title="Nothing to show">No checklists for these dates.</EmptyState>
      ) : (
        <TableFrame>
          <Table>
            <THead>
              <Tr>
                <Th>Date</Th>
                <Th>Checklist</Th>
                <Th>Kind</Th>
                <Th>Status</Th>
                <Th>Completed by</Th>
              </Tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <Tr key={`${row.businessDate}-${row.templateId}-${row.run?.id ?? "none"}`}>
                  <Td>{row.businessDate}</Td>
                  <Td>
                    {row.run ? (
                      <Link href={`/checklists/${row.run.id}`} className="underline">
                        {row.templateName}
                        {row.run.employeeName ? ` (${row.run.employeeName})` : ""}
                      </Link>
                    ) : (
                      row.templateName
                    )}
                  </Td>
                  <Td>{CHECKLIST_KIND_LABELS[row.kind]}</Td>
                  <Td>
                    <ChecklistStatusBadge status={row.status} />
                  </Td>
                  <Td>{row.run?.completedAt ? (row.run.completedByName ?? "No employee record") : ""}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </>
  );
}
