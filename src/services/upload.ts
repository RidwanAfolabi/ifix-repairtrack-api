/**
 * Photo uploads to R2.
 *
 * HOW PHOTOS BECOME VIEWABLE
 * An R2 bucket is not publicly readable by default, so a stored URL only loads
 * if something serves it. The stored URL is always `${MEDIA_BASE_URL}/${key}`,
 * which supports both strategies with no code change:
 *
 *   1. R2 custom domain — CURRENT PRODUCTION SETTING.
 *        MEDIA_BASE_URL = "https://repair-media.ifixexpress.com.my"
 *        -> https://repair-media.ifixexpress.com.my/photos/IFX-00001/0.jpg
 *      Served at the edge, no Worker invocation.
 *
 *   2. Worker proxy via routes/media.ts — used for LOCAL DEV, and as a
 *      fallback if the custom domain is detached.
 *        MEDIA_BASE_URL = "http://127.0.0.1:8787/api/media"
 *      Required locally because `wrangler dev --local` writes to the local R2
 *      simulator, which the public domain cannot reach.
 *
 * ⚠️ MEDIA_BASE_URL is baked into photo_url AT WRITE TIME. Changing it does
 * not rewrite existing rows — those need an UPDATE on job_photos and
 * status_history.
 */
import { badRequest } from "../lib/http";

/** Only formats a phone camera or browser will realistically produce. */
const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per photo
export const MAX_JOB_PHOTOS = 3;

export interface StoredPhoto {
  key: string;
  url: string;
}

function extensionFor(type: string): string | null {
  return ALLOWED_TYPES[type.toLowerCase().split(";")[0].trim()] ?? null;
}

/**
 * Validate a File from multipart form data.
 * Returns the extension to use, or throws a 400 naming the offending field.
 */
export function validate(file: File, field: string): string {
  const ext = extensionFor(file.type);
  if (!ext) {
    throw badRequest("Unsupported image format", {
      [field]: `must be JPEG, PNG or WebP (received "${file.type || "unknown"}")`,
    });
  }
  if (file.size === 0) {
    throw badRequest("Empty file", { [field]: "file is empty" });
  }
  if (file.size > MAX_BYTES) {
    throw badRequest("Image too large", {
      [field]: `must be ${MAX_BYTES / 1024 / 1024}MB or smaller`,
    });
  }
  return ext;
}

async function put(
  bucket: R2Bucket,
  key: string,
  file: File,
  mediaBaseUrl: string,
): Promise<StoredPhoto> {
  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: {
      contentType: file.type,
      // Photos are immutable once written (keys are unique per job/index).
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  // MEDIA_BASE_URL carries the full prefix (including /api/media in proxy
  // mode), so this works unchanged for both serving strategies.
  return { key, url: `${mediaBaseUrl.replace(/\/$/, "")}/${key}` };
}

/**
 * Validate every photo WITHOUT touching R2 or the database.
 *
 * Must be called during the request-validation phase, before the job row is
 * inserted — otherwise a rejected photo leaves a committed job with no photos
 * (a phantom job in the staff list) even though the client received a 400.
 */
export function validateJobPhotos(files: File[]): void {
  if (files.length > MAX_JOB_PHOTOS) {
    throw badRequest("Too many photos", {
      photos: `a maximum of ${MAX_JOB_PHOTOS} photos may be attached`,
    });
  }
  files.forEach((file, i) => validate(file, `photos[${i}]`));
}

/**
 * Upload up to MAX_JOB_PHOTOS device photos for a job.
 * Stored at photos/{jobId}/{index}.{ext}, index matching sort_order.
 * Assumes validateJobPhotos() has already passed.
 */
export async function uploadJobPhotos(
  bucket: R2Bucket,
  jobId: string,
  files: File[],
  mediaBaseUrl: string,
): Promise<StoredPhoto[]> {
  if (files.length > MAX_JOB_PHOTOS) {
    throw badRequest("Too many photos", {
      photos: `a maximum of ${MAX_JOB_PHOTOS} photos may be attached`,
    });
  }

  const stored: StoredPhoto[] = [];
  for (let i = 0; i < files.length; i++) {
    const ext = validate(files[i], `photos[${i}]`);
    stored.push(await put(bucket, `photos/${jobId}/${i}.${ext}`, files[i], mediaBaseUrl));
  }
  return stored;
}

/**
 * Upload a single photo attached to a status update.
 * Stored at status-photos/{jobId}/{timestamp}.{ext} — the timestamp keeps
 * successive updates for the same job from overwriting each other.
 */
export async function uploadStatusPhoto(
  bucket: R2Bucket,
  jobId: string,
  file: File,
  mediaBaseUrl: string,
): Promise<StoredPhoto> {
  const ext = validate(file, "photo");
  const key = `status-photos/${jobId}/${Date.now()}.${ext}`;
  return put(bucket, key, file, mediaBaseUrl);
}

/**
 * Recover the raw R2 key from a stored photo_url — the inverse of the
 * `${mediaBaseUrl}/${key}` join done in put(). Returns null for a URL that
 * doesn't start with the current MEDIA_BASE_URL (e.g. a row written back
 * when MEDIA_BASE_URL pointed somewhere else) rather than deleting the
 * wrong object.
 */
export function keyFromUrl(url: string, mediaBaseUrl: string): string | null {
  const prefix = `${mediaBaseUrl.replace(/\/$/, "")}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

/**
 * Delete R2 objects by key. Best-effort by design: called during a job
 * delete, and a stray orphaned object in R2 is a far cheaper mistake than
 * refusing to delete the job record the staff member actually asked to
 * remove. Callers should catch and log rather than let this block the
 * database delete.
 */
export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await bucket.delete(keys);
}
