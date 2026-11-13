import { apiFetch } from "./page-location";

export type ApiFailure = {
  ok: false;
  status: number;
  /** The error envelope's code, "NETWORK" when the server couldn't be reached. */
  code: string;
  message: string;
  requestId?: string;
};

export type ApiRequestResult = { ok: true } | ApiFailure;

export const NETWORK_FAILURE_MESSAGE =
  "Couldn't reach the server. Check your connection and try again.";

/** Calls a Route Handler. Errors come back as text for the form to display. */
export function sendApiRequest(
  method: string,
  url: string,
  body?: unknown,
): Promise<ApiRequestResult> {
  return send(url, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Uploads a form. The browser sets the multipart Content-Type and its boundary. */
export function sendFormData(
  url: string,
  body: FormData,
): Promise<ApiRequestResult> {
  return send(url, { method: "POST", body });
}

/** Reads `{ error: { code, message, requestId } }` from a failed response. */
export async function readFailure(response: Response): Promise<ApiFailure> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; requestId?: string };
  } | null;

  return {
    ok: false,
    status: response.status,
    code: payload?.error?.code ?? "ERROR",
    message: payload?.error?.message ?? "Something went wrong.",
    requestId: payload?.error?.requestId,
  };
}

async function send(url: string, init: RequestInit): Promise<ApiRequestResult> {
  try {
    const response = await apiFetch(url, init);

    return response.ok ? { ok: true } : await readFailure(response);
  } catch {
    return { ok: false, status: 0, code: "NETWORK", message: NETWORK_FAILURE_MESSAGE };
  }
}

/** True when the record changed under the user and a reload shows the latest. */
export function isStaleConflict(failure: Pick<ApiFailure, "code">): boolean {
  return failure.code === "CONCURRENCY_CONFLICT" || failure.code === "LOCATION_CHANGED";
}
