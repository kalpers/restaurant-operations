import { humanizeCode } from "@/components/format/status-labels";

// Display helpers for the audit viewer. They only rearrange what the audit API already
// returned (allow-listed and redacted on the server); nothing new is read or revealed.

export type AuditFieldRow = {
  field: string;
  before: string | null;
  after: string | null;
  /** Present on both sides with different values, or added, or removed. */
  changed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text for one recorded value. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (Array.isArray(value)) {
    return value.length === 0 ? "None" : value.map((entry) => displayValue(entry)).join(", ");
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * One row per field found in either payload, in a stable order (before's keys, then
 * after's new ones). A payload that isn't an object is shown as a single "value" row.
 */
export function diffAuditFields(before: unknown, after: unknown): AuditFieldRow[] {
  const left = isRecord(before) ? before : before === null || before === undefined ? {} : { value: before };
  const right = isRecord(after) ? after : after === null || after === undefined ? {} : { value: after };
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;

  return fields.map((field) => {
    const inLeft = field in left;
    const inRight = field in right;
    const beforeText = inLeft ? displayValue(left[field]) : null;
    const afterText = inRight ? displayValue(right[field]) : null;

    return {
      field,
      before: hasBefore ? beforeText : null,
      after: hasAfter ? afterText : null,
      changed: hasBefore && hasAfter ? beforeText !== afterText : false,
    };
  });
}

/** "settlements.completed" -> "Settlements · Completed"; "auth.sign-in-failed" -> "Auth · Sign in failed". */
export function actionLabel(action: string): string {
  const [domain, ...rest] = action.split(".");
  const what = rest.join(".").replaceAll("-", "_").replaceAll(".", "_");

  return what ? `${humanizeCode(domain ?? "")} · ${humanizeCode(what)}` : humanizeCode(domain ?? action);
}

/** "inventory_count" -> "Inventory count". */
export function entityLabel(entityType: string): string {
  return humanizeCode(entityType);
}

const ENTITY_PAGES: Record<string, (id: string) => string> = {
  employee: (id) => `/employees/${id}`,
  inventory_count: (id) => `/inventory/counts/${id}`,
  inventory_item: (id) => `/inventory/items/${id}`,
  menu_item: (id) => `/menu/items/${id}`,
  order: (id) => `/orders/${id}`,
  purchase_order: (id) => `/purchasing/orders/${id}`,
  recipe: (id) => `/recipes/${id}`,
  schedule_period: (id) => `/scheduling/${id}`,
};

/** The record's own page, when one exists. That page still checks permission itself. */
export function entityHref(entityType: string, entityId: string | null): string | null {
  return entityId && ENTITY_PAGES[entityType] ? ENTITY_PAGES[entityType](entityId) : null;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
