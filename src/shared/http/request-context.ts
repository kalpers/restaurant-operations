import { AsyncLocalStorage } from "node:async_hooks";

// Request-scoped context (README section 28): the request ID assigned by `apiRoute`, so
// audit events can carry it without every service signature passing it along.

type RequestContext = { requestId: string };

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, callback: () => Promise<T>): Promise<T> {
  return storage.run(context, callback);
}

/** The current request's ID, or null outside a request (CLI scripts, Auth.js callbacks). */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}
