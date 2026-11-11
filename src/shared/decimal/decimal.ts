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

export function negateDecimal(value: string): string {
  const parsed = parse(value);

  return format(-parsed.units, parsed.scale);
}

export function subtractDecimals(a: string, b: string): string {
  return addDecimals(a, negateDecimal(b));
}

/** The exact product, at the combined scale of both factors. */
export function multiplyExact(a: string, b: string): string {
  const left = parse(a);
  const right = parse(b);

  return format(left.units * right.units, left.scale + right.scale);
}

/**
 * `a / b` rounded ROUND_HALF_UP (halves away from zero) to `scale` places. This is the one
 * place a rounding rule is applied; callers choose to use it only where policy allows.
 */
export function divideRoundHalfUp(a: string, b: string, scale: number): string {
  const left = parse(a);
  const right = parse(b);

  if (right.units === 0n) {
    throw new DecimalError("Division by zero.");
  }

  // a/b * 10^scale = (ua * 10^(sb + scale)) / (ub * 10^sa)
  const numerator = left.units * 10n ** BigInt(right.scale + scale);
  const denominator = right.units * 10n ** BigInt(left.scale);
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;

  if ((n % d) * 2n >= d) {
    quotient += 1n;
  }

  return format(negative ? -quotient : quotient, scale);
}

/**
 * How many whole times `b` fits in `a`, for non-negative `a` and positive `b` (floor of the
 * exact quotient), as a decimal string with no fraction. Used for counts such as portions
 * remaining and whole purchase units; nothing is rounded.
 */
export function wholeQuotient(a: string, b: string): string {
  const left = parse(a);
  const right = parse(b);

  if (right.units <= 0n) {
    throw new DecimalError("The divisor must be positive.");
  }

  if (left.units < 0n) {
    throw new DecimalError("The dividend can't be negative.");
  }

  const numerator = left.units * 10n ** BigInt(right.scale);
  const denominator = right.units * 10n ** BigInt(left.scale);

  return (numerator / denominator).toString();
}

/** The smallest whole number at or above `a / b`, for non-negative `a` and positive `b`. */
export function wholeQuotientCeiling(a: string, b: string): string {
  const left = parse(a);
  const right = parse(b);

  if (right.units <= 0n) {
    throw new DecimalError("The divisor must be positive.");
  }

  if (left.units < 0n) {
    throw new DecimalError("The dividend can't be negative.");
  }

  const numerator = left.units * 10n ** BigInt(right.scale);
  const denominator = right.units * 10n ** BigInt(left.scale);
  const quotient = numerator / denominator;

  return (numerator % denominator === 0n ? quotient : quotient + 1n).toString();
}

/** Rounds ROUND_HALF_UP to `scale` places. */
export function roundHalfUp(value: string, scale: number): string {
  return divideRoundHalfUp(value, "1", scale);
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
