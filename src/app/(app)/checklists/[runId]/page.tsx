import { notFound } from "next/navigation";
import { z } from "zod";

import { ChecklistRunView } from "@/components/restaurant/checklist-run-view";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getChecklistRun } from "@/modules/restaurant/services/checklist-service";
import { NotFoundError } from "@/shared/errors/app-error";

/** Phase 36 (policy 5): one checklist, worked through item by item. */
export default async function ChecklistRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { actor } = await requirePageActor("checklists.view");
  const parsed = z.uuid().safeParse((await params).runId);

  if (!parsed.success) {
    notFound();
  }

  const run = await getChecklistRun(getDatabase(), actor, parsed.data).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });

  return (
    <>
      <PageHeader title={run.templateName} breadcrumbs={[{ label: "Checklists", href: "/checklists" }, { label: run.templateName }]} />
      <ChecklistRunView initial={run} />
    </>
  );
}
