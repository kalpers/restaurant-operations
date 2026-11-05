import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { addNote, listNotes } from "@/modules/employees/services/note-service";
import {
  addNoteSchema,
  employeeIdParamsSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "list-notes" },
  async ({ params }) => {
    const actor = await requireApiPermission("hr.notes.view");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);

    return { body: { notes: await listNotes(getDatabase(), actor, employeeId) } };
  },
);

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "add-note" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.notes.manage");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, addNoteSchema);

    return { body: await addNote(getDatabase(), actor, employeeId, input), status: 201 };
  },
);
