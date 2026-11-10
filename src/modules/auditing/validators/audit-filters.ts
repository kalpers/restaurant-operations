import { z } from "zod";

import { AUDIT_CATEGORIES } from "@/db/schema/auditing";

const date = z.iso.date();

/** Query-string shape of the audit viewer. Range rules are checked by the query. */
export const auditFiltersSchema = z.object({
  locationId: z.uuid(),
  from: date,
  to: date,
  category: z.enum(AUDIT_CATEGORIES).optional(),
  action: z.string().regex(/^[a-z]+[.][a-z-]+$/).max(64).optional(),
  actorUserId: z.uuid().optional(),
  entityType: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  entityId: z.uuid().optional(),
  /** Cursor: only events older than this sequence. */
  before: z.coerce.number().int().positive().optional(),
});

export type AuditFilters = z.infer<typeof auditFiltersSchema>;

export const AUDIT_PAGE_SIZE = 100;
export const AUDIT_MAX_RANGE_DAYS = 92;
