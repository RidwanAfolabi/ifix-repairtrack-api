/**
 * Warranty calculation.
 *
 * All dates are plain 'YYYY-MM-DD' strings (matching how D1 stores them).
 * "Today" is evaluated in Malaysia time (UTC+8), NOT UTC — otherwise a
 * warranty would appear to tick over at 8am local instead of midnight,
 * and a same-day collection could compute -1 days remaining.
 *
 * Status precedence:
 *   claimed  > not_started > expired / active
 * A claim is a recorded fact about what happened, so it outranks the
 * date arithmetic — a claim made inside the window stays "claimed" even
 * after the window later lapses.
 */

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type WarrantyStatus = "not_started" | "active" | "expired" | "claimed";

export interface WarrantyClaim {
  claimed_at: string;
  claimed_by: string | null;
  note: string | null;
}

export interface WarrantyResult {
  status: WarrantyStatus;
  /** null until the job is collected and the countdown starts. */
  expiry_date: string | null;
  /** Negative once expired. null when not started. */
  days_remaining: number | null;
  /** True only when the warranty is active and 0 <= days_remaining <= 14. */
  expiry_soon: boolean;
  warranty_days: number;
  warranty_start_date: string | null;
  /** Populated only when the warranty has been claimed. */
  claim: WarrantyClaim | null;
}

/** Current date in Malaysia time, as 'YYYY-MM-DD'. */
export function todayInMYT(now: Date = new Date()): string {
  return new Date(now.getTime() + MYT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Current timestamp in Malaysia time, as 'YYYY-MM-DD HH:MM:SS'. */
export function nowInMYT(now: Date = new Date()): string {
  return new Date(now.getTime() + MYT_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

/** Parse 'YYYY-MM-DD' to a UTC-midnight epoch. Returns null if unparseable. */
function parseDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(ms) ? null : ms;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface WarrantyInput {
  warrantyDays: number;
  warrantyStartDate: string | null;
  claimedAt?: string | null;
  claimedBy?: string | null;
  claimNote?: string | null;
}

export function calculateWarranty(
  input: WarrantyInput,
  now: Date = new Date(),
): WarrantyResult {
  const { warrantyDays, warrantyStartDate, claimedAt, claimedBy, claimNote } = input;

  const claim: WarrantyClaim | null = claimedAt
    ? { claimed_at: claimedAt, claimed_by: claimedBy ?? null, note: claimNote ?? null }
    : null;

  const startMs = warrantyStartDate ? parseDate(warrantyStartDate) : null;

  // No usable start date: the countdown has not begun (or the stored value is
  // malformed). Emit an explicit status rather than NaN dates on the Repair Card.
  if (startMs === null) {
    return {
      status: claim ? "claimed" : "not_started",
      expiry_date: null,
      days_remaining: null,
      expiry_soon: false,
      warranty_days: warrantyDays,
      warranty_start_date: warrantyStartDate,
      claim,
    };
  }

  const expiryMs = startMs + warrantyDays * DAY_MS;
  const todayMs = parseDate(todayInMYT(now))!;
  const daysRemaining = Math.round((expiryMs - todayMs) / DAY_MS);
  const isActive = daysRemaining >= 0;

  return {
    status: claim ? "claimed" : isActive ? "active" : "expired",
    expiry_date: formatDate(expiryMs),
    days_remaining: daysRemaining,
    // A claimed warranty is spent — never nag the customer to use it.
    expiry_soon: !claim && isActive && daysRemaining <= 14,
    warranty_days: warrantyDays,
    warranty_start_date: warrantyStartDate,
    claim,
  };
}

/**
 * Guard for the staff claim route. A warranty can be claimed only when:
 *   - the countdown has started (device was collected),
 *   - it has not already been claimed, and
 *   - it has not expired.
 *
 * The expiry check is overridable via `allowExpired` so a manager can still
 * record a goodwill repair outside the window — but never silently, because
 * claiming an expired warranty flips the customer-visible status from
 * "expired" to "claimed" and would misrepresent the record.
 */
export function canClaim(
  warrantyDays: number,
  warrantyStartDate: string | null,
  claimedAt: string | null,
  allowExpired = false,
  now: Date = new Date(),
): { ok: true } | { ok: false; code: string; message: string } {
  if (claimedAt) {
    return {
      ok: false,
      code: "WARRANTY_ALREADY_CLAIMED",
      message: `Warranty was already claimed on ${claimedAt}`,
    };
  }
  if (!warrantyStartDate) {
    return {
      ok: false,
      code: "WARRANTY_NOT_STARTED",
      message:
        "Warranty has not started — the device must be collected before a claim can be recorded",
    };
  }

  if (!allowExpired) {
    const current = calculateWarranty({ warrantyDays, warrantyStartDate }, now);
    if (current.status === "expired") {
      return {
        ok: false,
        code: "WARRANTY_EXPIRED",
        message:
          `Warranty expired on ${current.expiry_date} ` +
          `(${Math.abs(current.days_remaining ?? 0)} days ago). ` +
          `Resend with allow_expired=true to record a goodwill claim.`,
      };
    }
  }

  return { ok: true };
}
