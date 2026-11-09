import { z } from "zod";

import { ORDER_TYPES, REPORT_AREAS, TENDER_TYPES } from "../types";

const date = z.iso.date();

/** Query-string shape of every report request. Range rules are checked by the service. */
export const reportFiltersSchema = z.object({
  locationId: z.uuid(),
  from: date,
  to: date,
  employeeId: z.uuid().optional(),
  orderType: z.enum(ORDER_TYPES).optional(),
  tenderType: z.enum(TENDER_TYPES).optional(),
});

export const reportAreaParamsSchema = z.object({ area: z.enum(REPORT_AREAS) });

export const exportQuerySchema = z.object({
  section: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
});

export const dashboardQuerySchema = z.object({
  locationId: z.uuid(),
  businessDate: date.optional(),
});

/** Reads a URL's search params into an object, dropping empty values. */
export function searchParamsToObject(searchParams: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of searchParams) {
    if (value !== "") {
      result[key] = value;
    }
  }

  return result;
}
