const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A value as JSON with IDs, instants and row sequence numbers left out, for checking that a
 * figure (a wage, an amount, a card's last four) isn't in it. Random UUIDs and timestamps
 * can contain the same digits by chance ("…021906…" holds "190"), which made such checks flaky.
 */
export function textWithoutIds(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (item instanceof Date || key === "sequence") {
      return undefined;
    }

    if (typeof item === "string" && (UUID.test(item) || ISO_INSTANT.test(item))) {
      return undefined;
    }

    return item;
  });
}
