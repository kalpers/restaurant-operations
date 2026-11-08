// Exact decimal arithmetic on strings, using BigInt scaled integers. Authoritative money
// and quantities never pass through a JavaScript `number`. Operations that would lose
// precision throw instead of rounding.

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalError";
  }
}

type Parsed = { units: bigint; scale: number };

function parse(value: string): Parsed {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new DecimalError(`"${value}" is not a decimal string.`);
  }

  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units = BigInt(whole + fraction);

  return { units: negative ? -units : units, scale: fraction.length };
}

function format(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  const text = scale === 0 ? whole : `${whole}.${fraction}`;

  return negative && units !== 0n ? `-${text}` : text;
}

function rescale(parsed: Parsed, scale: number): bigint {
  return parsed.units * 10n ** BigInt(scale - parsed.scale);
}

/** Number of fractional digits after trailing zeros are ignored. */
export function significantScale(value: string): number {
  const { units, scale } = parse(value);
  let remaining = units;
  let used = scale;

  while (used > 0 && remaining % 10n === 0n) {
    remaining /= 10n;
    used -= 1;
  }

  return used;
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

/** Normalizes to exactly `scale` places, refusing a value that has more precision. */
export function toScale(value: string, scale: number): string {
  if (significantScale(value) > scale) {
    throw new DecimalError(`"${value}" has more than ${scale} decimal places.`);
  }

  const parsed = parse(value);

  // Any dropped digits are zeros (checked above), so the division is exact.
  const units =
    scale >= parsed.scale
      ? rescale(parsed, scale)
      : parsed.units / 10n ** BigInt(parsed.scale - scale);

  return format(units, scale);
}

export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  const left = parse(a);
  const right = parse(b);
  const scale = Math.max(left.scale, right.scale);
  const x = rescale(left, scale);
  const y = rescale(right, scale);

  return x < y ? -1 : x > y ? 1 : 0;
}

export function isPositiveDecimal(value: string): boolean {
  return compareDecimals(value, "0") === 1;
}

export function addDecimals(a: string, b: string): string {
  const left = parse(a);
  const right = parse(b);
  const scale = Math.max(left.scale, right.scale);

  return format(rescale(left, scale) + rescale(right, scale), scale);
}

/** Sums to the given scale; throws if any addend or the total needs more places. */
export function sumDecimals(values: readonly string[], scale: number): string {
  let total = "0";

  for (const value of values) {
    total = addDecimals(total, toScale(value, scale));
  }

  return toScale(total, scale);
}

/**
 * Exact product, returned at `scale` places. Throws if the exact product needs more
 * places than `scale`, so a conversion never silently rounds.
 */
export function multiplyDecimals(a: string, b: string, scale: number): string {
  const left = parse(a);
  const right = parse(b);
  const product = format(left.units * right.units, left.scale + right.scale);

  return toScale(product, scale);
}
