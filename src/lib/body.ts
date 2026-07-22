/**
 * Request body parsing.
 *
 * Centralised because every raw `await c.req.json()` / `c.req.formData()` has
 * two failure modes that otherwise surface as a misleading 500:
 *   - formData() THROWS on malformed multipart
 *   - json() SUCCEEDS on the literal `null` (and on arrays/strings), which
 *     then explodes at the first property access
 * Both are client errors and must be 400.
 */
import type { Context } from "hono";
import { badRequest } from "./http";
import type { AppEnv } from "../types";

export interface ParsedBody {
  fields: Record<string, unknown>;
  files: { name: string; file: File }[];
}

/** True for a plain JSON object — rejects null, arrays and primitives. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a JSON body into an object.
 * `allowEmpty` permits a completely absent body (used by warranty-claim,
 * where every field is optional).
 */
export async function parseJson(
  c: Context<AppEnv>,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    if (allowEmpty) return {};
    throw badRequest("Request body must be valid JSON");
  }

  if (raw === undefined || raw === null) {
    if (allowEmpty) return {};
    throw badRequest("Request body must be a JSON object");
  }

  if (!isPlainObject(raw)) {
    throw badRequest("Request body must be a JSON object");
  }

  return raw;
}

/**
 * Parse either multipart/form-data or JSON, returning a uniform shape.
 * Used by the routes that accept optional file uploads.
 */
export async function parseBody(c: Context<AppEnv>): Promise<ParsedBody> {
  const contentType = c.req.header("Content-Type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      // Malformed multipart is a client error, not a server fault.
      throw badRequest("Malformed multipart/form-data body");
    }

    const fields: Record<string, unknown> = {};
    const files: { name: string; file: File }[] = [];
    for (const [key, value] of form.entries()) {
      if (value instanceof File) files.push({ name: key, file: value });
      else fields[key] = value;
    }
    return { fields, files };
  }

  return { fields: await parseJson(c), files: [] };
}
