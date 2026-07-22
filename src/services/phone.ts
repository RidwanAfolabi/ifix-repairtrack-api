/**
 * Malaysian WhatsApp number normalization.
 *
 * Produces a digits-only international string (e.g. "60123456789") suitable
 * for both storage and a wa.me deep link. Rejects anything that isn't a
 * plausible Malaysian MOBILE number — landlines can't receive WhatsApp, so
 * accepting them would silently break the customer's Repair Card link.
 *
 * Accepted shapes:
 *   "012-345 6789"   -> 60123456789
 *   "0123456789"     -> 60123456789
 *   "+60 12 345 6789"-> 60123456789
 *   "60123456789"    -> 60123456789
 *   "011-1234 5678"  -> 601112345678  (011 carries one extra digit)
 */

export type PhoneResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

/**
 * Malaysian mobile prefixes are 01X. After normalization the number is
 * "60" + "1X" + 7 or 8 subscriber digits, i.e. 11 or 12 digits total.
 * 011 is the block that uses 8.
 */
const MY_MOBILE = /^601[0-9]\d{7,8}$/;

export function normalizeMalaysianMobile(raw: unknown): PhoneResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "Phone number is required" };
  }

  const trimmed = raw.trim();

  // Reject letters outright rather than stripping them — "012-CALL-NOW"
  // silently becoming a valid-looking number would be worse than an error.
  if (/[a-z]/i.test(trimmed)) {
    return { ok: false, reason: "Phone number must not contain letters" };
  }

  // Strip formatting: spaces, dashes, dots, brackets, and a leading '+'.
  let digits = trimmed.replace(/[\s\-().]/g, "");
  digits = digits.replace(/^\+/, "");

  if (!/^\d+$/.test(digits)) {
    return { ok: false, reason: "Phone number must contain only digits" };
  }

  // '00' is the international dial-out prefix: 006012... -> 6012...
  if (digits.startsWith("00")) digits = digits.slice(2);

  if (digits.startsWith("60")) {
    // Already international.
  } else if (digits.startsWith("0")) {
    // Local format: leading 0 becomes the 60 country code.
    digits = `60${digits.slice(1)}`;
  } else if (digits.startsWith("1")) {
    // Bare mobile without trunk prefix, e.g. "123456789".
    digits = `60${digits}`;
  } else {
    return {
      ok: false,
      reason: "Not a recognisable Malaysian number — expected a 01X mobile number",
    };
  }

  if (!MY_MOBILE.test(digits)) {
    return {
      ok: false,
      reason:
        "Not a valid Malaysian mobile number — expected an 01X number such as 012-345 6789",
    };
  }

  return { ok: true, normalized: digits };
}
