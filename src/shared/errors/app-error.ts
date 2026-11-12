/**
 * Base for errors that are safe to show to a client. The message must never contain
 * SQL, credentials, stack traces or internal identifiers.
 */
export class AppError extends Error {
  /** Optional structured, client-safe detail (for example shortage quantities). */
  details?: unknown;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication is required.") {
    super("AUTHENTICATION_REQUIRED", message, 401);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "You do not have permission to do this.", code = "PERMISSION_DENIED") {
    super(code, message, 403);
  }
}

export class ValidationError extends AppError {
  constructor(message = "The request is not valid.") {
    super("VALIDATION_FAILED", message, 400);
  }
}

export class NotFoundError extends AppError {
  constructor(entityType: string) {
    super("NOT_FOUND", `The ${entityType} was not found.`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}

/** Phase 22 (policy 10): too many public requests in the window. Says nothing about why. */
export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests. Please wait a while and try again.") {
    super("TOO_MANY_REQUESTS", message, 429);
  }
}

export class BusinessRuleError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 422);

    if (details !== undefined) {
      this.details = details;
    }
  }
}
