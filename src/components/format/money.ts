const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Display text for a money decimal string: "1234.50" -> "$1,234.50", "-3.00" -> "-$3.00".
 * Money stays a string end to end; this never converts it to a JavaScript number.
 * Anything that isn't a decimal string is returned unchanged.
 */
export function formatMoney(value: string): string {
  const match = DECIMAL.exec(value.trim());

  if (!match) {
    return value;
  }

  const [, sign, whole, fraction] = match;
  const text = `$${groupThousands(whole)}${fraction === undefined ? "" : `.${fraction}`}`;

  return sign ? `-${text}` : text;
}

/** A signed change for comparisons: "+$12.00", "-$3.50", or "$0.00". */
export function formatMoneyChange(value: string): string {
  const formatted = formatMoney(value);

  if (formatted.startsWith("-") || !DECIMAL.test(value.trim())) {
    return formatted;
  }

  return /^0+(\.0+)?$/.test(value.trim()) ? formatted : `+${formatted}`;
}

/** Quantities stay strings; trailing zeros are trimmed for reading only. */
export function formatQuantity(value: string | null, unit?: string | null): string {
  if (value === null) {
    return "—";
  }

  const match = DECIMAL.exec(value.trim());
  let text = value;

  if (match) {
    const [, sign, whole, fraction = ""] = match;
    const kept = fraction.replace(/0+$/, "");
    text = `${sign}${groupThousands(whole)}${kept ? `.${kept}` : ""}`;
  }

  return unit ? `${text} ${unit}` : text;
}
