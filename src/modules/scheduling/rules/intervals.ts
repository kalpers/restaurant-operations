/** A half-open span of time in epoch milliseconds: `[start, end)`. */
export type Interval = { start: number; end: number };

export function overlaps(left: Interval, right: Interval): boolean {
  return left.start < right.end && right.start < left.end;
}

/** What remains of each interval after removing `removed`. */
export function subtract(
  intervals: readonly Interval[],
  removed: Interval,
): Interval[] {
  return intervals.flatMap((interval) => {
    if (!overlaps(interval, removed)) {
      return [interval];
    }

    const remainder: Interval[] = [];

    if (interval.start < removed.start) {
      remainder.push({ start: interval.start, end: removed.start });
    }

    if (removed.end < interval.end) {
      remainder.push({ start: removed.end, end: interval.end });
    }

    return remainder;
  });
}
