import { z } from "zod";

import { readErrorCode } from "@/infrastructure/health/check-database-health";
import { writeLog } from "@/infrastructure/logging/logger";
import { AppError, ValidationError } from "@/shared/errors/app-error";

import { runWithRequestContext } from "./request-context";

type RouteContext<Params> = { params: Promise<Params> };

type ApiRouteArgs<Params> = {
  request: Request;
  params: Params;
  requestId: string;
};

/** `response` sends a prepared Response as is, such as a file download. */
export type ApiResult =
  | { body?: unknown; status?: number; response?: undefined }
  | { response: Response };

/** The one error response shape. */
export function errorResponse(error: unknown, requestId: string): Response {
  const known = error instanceof AppError;
  const code = known ? error.code : "INTERNAL_ERROR";
  const message = known ? error.message : "Something went wrong.";

  const details = known && error.details !== undefined ? { details: error.details } : {};

  return Response.json(
    { error: { code, message, requestId, ...details } },
    { status: known ? error.httpStatus : 500 },
  );
}

/**
 * Wraps a Route Handler: assigns a request ID, maps errors to the structured shape,
 * and logs unexpected failures by name and code only.
 */
export function apiRoute<Params = Record<string, never>>(
  meta: { module: string; operation: string },
  handler: (args: ApiRouteArgs<Params>) => Promise<ApiResult>,
) {
  return async (
    request: Request,
    context: RouteContext<Params>,
  ): Promise<Response> => {
    const requestId = crypto.randomUUID();

    try {
      const params = await context.params;
      const result = await runWithRequestContext({ requestId }, () =>
        handler({ request, params, requestId }),
      );

      if (result.response) {
        return result.response;
      }

      const { body, status = 200 } = result;

      return body === undefined
        ? new Response(null, { status: 204 })
        : Response.json(body, { status });
    } catch (error) {
      if (!(error instanceof AppError)) {
        writeLog({
          severity: "error",
          ...meta,
          requestId,
          message: "Unexpected request failure",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorCode: readErrorCode(error),
        });
      }

      return errorResponse(error, requestId);
    }
  };
}

/** Validates shape only and reports field names, never submitted values. */
export function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const result = schema.safeParse(value);

  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ].filter(Boolean);

    throw new ValidationError(
      fields.length > 0
        ? `Check these fields: ${fields.join(", ")}.`
        : "The request is not valid.",
    );
  }

  return result.data;
}

export async function parseJsonBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<z.output<Schema>> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new ValidationError("The request body must be JSON.");
  }

  return parseWith(schema, body);
}
