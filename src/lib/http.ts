/**
 * Shared response helpers enforcing the Step 9 error contract:
 *   { "error": "human readable message", "code": "MACHINE_READABLE_CODE" }
 *
 * Internal plumbing only — not a route or feature surface.
 */
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ApiErrorBody {
  error: string;
  code: string;
  /** Present only for 400 validation failures: field name -> problem. */
  fields?: Record<string, string>;
}

/**
 * Thrown anywhere in a route; caught by app.onError() and rendered as a
 * consistent JSON error. Anything that is NOT an ApiError becomes a
 * generic 500 so internals never leak to clients.
 */
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new ApiError(400, "VALIDATION_ERROR", message, fields);

export const unauthorized = (message = "Invalid credentials") =>
  new ApiError(401, "UNAUTHORIZED", message);

export const forbidden = (message = "You do not have access to this resource") =>
  new ApiError(403, "FORBIDDEN", message);

export const notFound = (message: string, code = "NOT_FOUND") =>
  new ApiError(404, code, message);
