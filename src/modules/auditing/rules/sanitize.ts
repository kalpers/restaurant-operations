// Pure allow-list filtering for audit payloads (README section 20, CLAUDE.md rule 15).
// Only fields the registry names survive; `changedOnly` fields become booleans.

export type AuditValue = string | number | boolean | null | readonly string[];
export type AuditPayload = Record<string, unknown>;

/** Words that must never name a recorded field, matched per camelCase word. */
export const FORBIDDEN_FIELD_WORDS = [
  "password",
  "hash",
  "token",
  "secret",
  "card",
  "cvv",
  "pin",
  "account",
  "routing",
  "ssn",
  "birth",
  "address",
  "phone",
  "email",
  "rate",
  "wage",
  "salary",
] as const;

export function fieldWords(field: string): string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when a field name would be refused as sensitive outside a `changedOnly` marker. */
export function isForbiddenField(field: string): boolean {
  const words = fieldWords(field);

  return FORBIDDEN_FIELD_WORDS.some((word) => words.includes(word));
}

function toAuditValue(value: unknown): AuditValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value] as string[];
  }

  // Objects and anything else are never recorded: they could carry unlisted fields.
  return undefined;
}

/**
 * Keeps only `allowed` fields with primitive values. A `changedOnly` field is replaced by
 * whether it differs from `compareWith` (or `true` when there is nothing to compare).
 */
export function sanitizeAuditPayload(
  payload: AuditPayload | null | undefined,
  allowed: readonly string[],
  changedOnly: readonly string[] = [],
  compareWith?: AuditPayload | null,
): Record<string, AuditValue> | null {
  if (!payload) {
    return null;
  }

  const result: Record<string, AuditValue> = {};

  for (const field of allowed) {
    if (!(field in payload)) {
      continue;
    }

    if (changedOnly.includes(field)) {
      result[field] = compareWith ? String(compareWith[field] ?? "") !== String(payload[field] ?? "") : true;
      continue;
    }

    const value = toAuditValue(payload[field]);

    if (value !== undefined) {
      result[field] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/** The names of `fields` whose values differ between two records; values are not returned. */
export function changedFieldNames(
  before: AuditPayload,
  after: AuditPayload,
  fields: readonly string[],
): string[] {
  return fields.filter((field) => {
    const a = toAuditValue(before[field]);
    const b = toAuditValue(after[field]);

    return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  });
}
