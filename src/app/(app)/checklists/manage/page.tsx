import { ChecklistTemplateManager } from "@/components/restaurant/checklist-template-manager";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { findTargetPositions } from "@/modules/employees/queries/briefing-positions";
import { listChecklistTemplates } from "@/modules/restaurant/services/checklist-service";

/** Phase 36 (policy 5): the location's checklist templates. */
export default async function ManageChecklistsPage() {
  const { actor } = await requirePageActor("checklists.manage");
  const database = getDatabase();
  const [templates, positions] = await Promise.all([
    listChecklistTemplates(database, actor),
    findTargetPositions(database, { organizationId: actor.organizationId }),
  ]);

  return (
    <>
      <PageHeader
        title="Set up checklists"
        description="Checklists started today keep the items they started with; changes here apply from the next one. Choosing positions decides who sees a checklist on their list; it doesn't keep it from anyone. Side work is one list per employee."
        breadcrumbs={[{ label: "Checklists", href: "/checklists" }, { label: "Set up" }]}
      />
      <ChecklistTemplateManager
        templates={templates}
        positions={positions.filter((position) => position.active).map(({ id, name }) => ({ id, name }))}
      />
    </>
  );
}
