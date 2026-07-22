/**
 * PBKDF2 password hashing via SubtleCrypto.
 *
 * bcrypt/argon2 are native modules and do not run on the Workers runtime;
 * PBKDF2-HMAC-SHA256 is the Web Crypto primitive available to us.
 *
 * Stored format (single self-describing string, so iterations can be raised
 * later without invalidating existing hashes):
 *
 *   pbkdf2$sha256$<iterations>$<base64 salt>$<base64 derived key>
 */

const ALGORITHM = "pbkdf2";
const DIGEST = "sha256";

/**
 * HARD PLATFORM CEILING — DO NOT RAISE.
 *
 * The Cloudflare Workers production runtime rejects PBKDF2 above 100,000
 * iterations:
 *   "Pbkdf2 failed: iteration counts above 100000 are not supported"
 *
 * `wrangler dev --local` does NOT enforce this, so a higher value works
 * perfectly in development and then fails in production — and because
 * verifyPassword swallows the error and returns false, the only symptom is
 * every login returning a generic 401. Raising this silently breaks auth.
 *
 * OWASP suggests 210,000 for PBKDF2-HMAC-SHA256; 100,000 is the most the
 * platform allows and is the binding constraint here.
 */
export const MAX_WORKERS_ITERATIONS = 100_000;
const DEFAULT_ITERATIONS = MAX_WORKERS_ITERATIONS;

const SALT_BYTES = 16;
const KEY_BITS = 256;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_BITS,
  );

  return new Uint8Array(bits);
}

/** Hash a plaintext password into the storable string format above. */
export async function hashPassword(
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveKey(password, salt, iterations);
  return `${ALGORITHM}$${DIGEST}$${iterations}$${toBase64(salt)}$${toBase64(derived)}`;
}

/**
 * Constant-time comparison. A plain `===` on secrets leaks length and
 * first-difference position through timing.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verify a plaintext password against a stored hash.
 * Returns false (never throws) on malformed stored values, so a corrupt row
 * cannot turn into a 500 that distinguishes it from a wrong password.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 5) return false;

    const [algorithm, digest, iterationsRaw, saltB64, hashB64] = parts;
    if (algorithm !== ALGORITHM || digest !== DIGEST) return false;

    const iterations = Number(iterationsRaw);
    if (!Number.isInteger(iterations) || iterations <= 0) return false;

    // A stored hash above the platform ceiling can NEVER be verified in
    // production — deriveBits throws and this would look like a wrong
    // password. Log it loudly so it is diagnosable from the tail.
    if (iterations > MAX_WORKERS_ITERATIONS) {
      console.error(
        `Stored password hash uses ${iterations} PBKDF2 iterations, above the ` +
          `Workers limit of ${MAX_WORKERS_ITERATIONS}. This hash can never verify ` +
          `in production and must be regenerated.`,
      );
      return false;
    }

    const salt = fromBase64(saltB64);
    const expected = fromBase64(hashB64);
    const actual = await deriveKey(password, salt, iterations);

    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
