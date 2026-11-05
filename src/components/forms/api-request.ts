export type ApiRequestResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

/** Calls a Route Handler. Errors come back as text for the form to display. */
export async function sendApiRequest(
  method: string,
  url: string,
  body?: unknown,
): Promise<ApiRequestResult> {
  try {
    const response = await fetch(url, {
      method,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.ok) {
      return { ok: true };
    }

    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;

    return {
      ok: false,
      status: response.status,
      message: payload?.error?.message ?? "Something went wrong.",
    };
  } catch {
    return {
      ok: false,
      status: 0,
      message: "Couldn't reach the server. Check your connection and try again.",
    };
  }
}
