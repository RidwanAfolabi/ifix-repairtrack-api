/**
 * Public, read-only media proxy — GET /api/media/*
 *
 * WHY THIS STILL EXISTS NOW THAT R2 HAS A CUSTOM DOMAIN
 *
 * In production it is unused: MEDIA_BASE_URL points at
 * repair-media.ifixexpress.com.my, so stored photo_urls resolve straight from
 * R2 at the edge and never reach this Worker.
 *
 * It is still required for LOCAL DEVELOPMENT. `wrangler dev --local` writes
 * uploads to the local R2 simulator, which the public custom domain cannot
 * see — fetching a locally-uploaded photo from repair-media.ifixexpress.com.my
 * returns 404. Running local dev with
 *     --var MEDIA_BASE_URL:http://127.0.0.1:8787/api/media
 * routes photos through here instead, so the intake and Repair Card flows can
 * be exercised offline.
 *
 * It also stands in as a fallback if the bucket's custom domain is ever
 * detached: switching MEDIA_BASE_URL back is a config change, not a redeploy
 * of new code.
 *
 * No extra exposure: the bucket is already world-readable through its custom
 * domain, so this route reveals nothing that domain does not. Still scoped to
 * the two key prefixes this API writes, and read-only — no PUT/DELETE here.
 */
import { Hono } from "hono";
import { notFound } from "../lib/http";
import type { AppEnv } from "../types";

const media = new Hono<AppEnv>();

/** Only keys this API actually writes may be read back. */
const ALLOWED_PREFIXES = ["photos/", "status-photos/"];

media.get("/*", async (c) => {
  // Strip the mount prefix to recover the raw R2 key.
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/media\//, ""));

  // Reject traversal and anything outside the known prefixes. Without this,
  // the route would expose every object in the bucket.
  if (
    key.includes("..") ||
    key.startsWith("/") ||
    !ALLOWED_PREFIXES.some((p) => key.startsWith(p))
  ) {
    throw notFound("Media not found", "MEDIA_NOT_FOUND");
  }

  const object = await c.env.MEDIA.get(key);
  if (!object) {
    throw notFound("Media not found", "MEDIA_NOT_FOUND");
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }

  return new Response(object.body, { headers });
});

export default media;
