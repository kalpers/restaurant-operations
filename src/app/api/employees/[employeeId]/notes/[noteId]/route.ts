import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { updateNote } from "@/modules/employees/services/note-service";
import {
  noteParamsSchema,
  updateNoteSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ employeeId: string; noteId: string }>(
  { module: "employees", operation: "update-note" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.notes.manage");
    const ids = parseWith(noteParamsSchema, params);
    const { expectedVersion, ...changes } = await parseJsonBody(request, updateNoteSchema);

    return { body: await updateNote(getDatabase(), actor, { ...ids, expectedVersion, changes }) };
  },
);
