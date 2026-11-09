export type OrderApiResult<Data> =
  | { ok: true; data: Data }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

/** Calls an order Route Handler and returns its JSON, or the structured error. */
export async function callOrderApi<Data = unknown>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<OrderApiResult<Data>> {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | (Data & { error?: undefined })
      | { error?: { code?: string; message?: string; details?: unknown } }
      | null;

    if (response.ok) {
      return { ok: true, data: payload as Data };
    }

    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;

    return {
      ok: false,
      status: response.status,
      code: error?.code ?? "ERROR",
      message: error?.message ?? "Something went wrong.",
      details: error?.details,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      code: "NETWORK",
      message: "Couldn't reach the server. Check your connection and try again; nothing is sent twice.",
    };
  }
}

/** A client-generated idempotency key for one SEND attempt. */
export function newIdempotencyKey(): string {
  return `send-${crypto.randomUUID()}`;
}

export function formatMoney(value: string): string {
  const negative = value.startsWith("-");

  return `${negative ? "-" : ""}$${negative ? value.slice(1) : value}`;
}

export const ORDER_TYPE_LABELS: Record<string, string> = {
  DINE_IN: "Dine-in",
  BAR: "Bar",
  TAKEOUT: "Takeout",
};
