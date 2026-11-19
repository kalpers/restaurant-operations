import { Pin } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { PreShiftNoteView } from "@/modules/restaurant/services/pre-shift-service";

/** Phase 32 (policies 7, 9): a day's pre-shift notes as staff read them. */
export function PreShiftNoteList({ notes, compact = false }: { notes: PreShiftNoteView[]; compact?: boolean }) {
  return (
    <ul className="grid gap-3" aria-label="Pre-shift notes">
      {notes.map((note) => (
        <li key={note.id}>
          <Card className={compact ? "grid gap-1 p-3" : "grid gap-2"} data-testid="pre-shift-note">
            <div className="flex flex-wrap items-center gap-2">
              {note.pinned && <Pin aria-label="Pinned" className="size-4 text-brand-700" />}
              <h3 className="font-semibold">{note.title}</h3>
              {note.positions.length === 0 ? (
                <Badge>Everyone</Badge>
              ) : (
                note.positions.map((position) => (
                  <Badge key={position.id} tone="info">
                    {position.name}
                  </Badge>
                ))
              )}
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{note.body}</p>
          </Card>
        </li>
      ))}
    </ul>
  );
}
