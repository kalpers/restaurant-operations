import { PreShiftNoteList } from "@/components/restaurant/pre-shift-note-list";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/restaurant/services/access";
import { listNotesForReader } from "@/modules/restaurant/services/pre-shift-service";

/**
 * Phase 32 pre-shift notes (policies 9–10): today's briefing, meaning notes for everyone and
 * for the positions the reader holds here. Managers see every note for today.
 */
export default async function PreShiftPage() {
  const { actor } = await requirePageActor("pre-shift.view");
  const { businessDate, notes } = await listNotesForReader(getDatabase(), actor);
  const manage = actorHolds(actor, "pre-shift.manage");

  return (
    <>
      <PageHeader
        title="Pre-shift"
        description={`Today's notes (business date ${businessDate}).${manage ? " You see every note for today." : ""}`}
        actions={
          manage ? (
            <ButtonLink href="/pre-shift/manage" variant="secondary">
              Manage notes
            </ButtonLink>
          ) : undefined
        }
      />
      {notes.length === 0 ? (
        <EmptyState title="No notes for today">There are no pre-shift notes for you today.</EmptyState>
      ) : (
        <PreShiftNoteList notes={notes} />
      )}
    </>
  );
}
