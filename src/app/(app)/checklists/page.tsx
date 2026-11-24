import Link from "next/link";

import { ChecklistStatusBadge, CHECKLIST_KIND_LABELS } from "@/components/restaurant/checklist-status-badge";
import { StartChecklistButton } from "@/components/restaurant/start-checklist-button";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/restaurant/services/access";
import { listChecklistsToday } from "@/modules/restaurant/services/checklist-service";

/**
 * Phase 36 (policy 5): today's checklists for the reader, meaning templates for everyone and
 * for positions they hold here. Managers see every checklist and everyone's side work.
 */
export default async function ChecklistsPage() {
  const { actor } = await requirePageActor("checklists.view");
  const today = await listChecklistsToday(getDatabase(), actor);
  const manage = actorHolds(actor, "checklists.manage");
  const canStart = actorHolds(actor, "checklists.complete");

  return (
    <>
      <PageHeader
        title="Checklists"
        description={`Today's checklists (business date ${today.businessDate}).`}
        actions={
          <>
            <ButtonLink href="/checklists/history" variant="secondary">
              History
            </ButtonLink>
            {manage && (
              <ButtonLink href="/checklists/manage" variant="secondary">
                Set up checklists
              </ButtonLink>
            )}
          </>
        }
      />
      {today.entries.length === 0 ? (
        <EmptyState title="No checklists for you today">
          {manage ? "Set up an opening, closing or side-work checklist to get started." : "There are no checklists for you today."}
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {today.entries.map(({ template, run }) => {
            const sideWorkWithoutEmployee = template.kind === "SIDE_WORK" && !today.canStartSideWork;

            return (
              <li key={template.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3" data-testid="checklist-today">
                  <div className="grid gap-1">
                    <h2 className="font-semibold">{template.name}</h2>
                    <div className="flex flex-wrap gap-2">
                      <Badge>{CHECKLIST_KIND_LABELS[template.kind]}</Badge>
                      <ChecklistStatusBadge status={run?.status ?? "NOT_STARTED"} />
                      {run && (
                        <span className="text-sm text-neutral-700">
                          {run.items.filter((item) => item.state !== "OPEN").length} of {run.items.length} done
                        </span>
                      )}
                    </div>
                  </div>
                  {run ? (
                    <ButtonLink href={`/checklists/${run.id}`} variant={run.workable ? "primary" : "secondary"}>
                      {run.workable ? "Continue" : "View"}
                    </ButtonLink>
                  ) : canStart && !sideWorkWithoutEmployee ? (
                    <StartChecklistButton templateId={template.id} />
                  ) : sideWorkWithoutEmployee ? (
                    <span className="text-sm text-neutral-700">Side work is started by each employee.</span>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {manage && today.sideWork.length > 0 && (
        <section aria-labelledby="side-work-heading" className="mt-6 grid gap-3">
          <h2 id="side-work-heading" className="text-lg font-semibold">
            Everyone&apos;s side work today
          </h2>
          <ul className="grid gap-2">
            {today.sideWork.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/checklists/${run.id}`} className="font-medium underline">
                  {run.employeeName ?? "Employee"}: {run.templateName}
                </Link>
                <ChecklistStatusBadge status={run.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
