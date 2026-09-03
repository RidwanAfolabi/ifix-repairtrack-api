/**
 * Job ID generation — format IFX-YYMM-NNNNNN, e.g. IFX-2609-000001.
 *
 * YYMM (year before month) rather than MMYY — job IDs double as a sort key
 * elsewhere (`ORDER BY job_id`), and month-before-year breaks chronological
 * string-sort across year boundaries ("1226" > "0127" as strings, putting
 * January ahead of the previous December). Year-first keeps it correct.
 *
 * The serial resets to 1 at the start of each calendar month (Malaysia
 * time, matching services/warranty.ts) — "next number" is scoped to jobs
 * created within the CURRENT YYMM bucket, not the whole table, so a new
 * month starting back at 000001 can never collide with the previous
 * month's numbers.
 *
 * Derives the next number from the current maximum within that month
 * rather than a row count, so deleting a job never causes a number to be
 * reused within the same month.
 *
 * Concurrency: two simultaneous intakes can compute the same candidate. The
 * PRIMARY KEY on jobs(job_id) is the real guard — the loser's INSERT fails
 * and the caller retries via `insertWithUniqueJobId`. Checking first and
 * inserting later would race; the retry-on-conflict is what actually holds.
 *
 * Jobs created before this format shipped (plain IFX-00001, no YYMM) are
 * untouched and keep working as historical records — this only governs IDs
 * assigned to NEW jobs from here on; their numbering is entirely unrelated
 * to (and never collides with) the old sequence.
 */
import { todayInMYT } from "./warranty";

const PREFIX = "IFX-";
const SERIAL_PAD = 6;

/** "2609" for September 2026, Malaysia time. */
function currentYearMonth(): string {
  const today = todayInMYT(); // "2026-09-02"
  return today.slice(2, 4) + today.slice(5, 7);
}

export function formatJobId(yearMonth: string, n: number): string {
  return `${PREFIX}${yearMonth}-${String(n).padStart(SERIAL_PAD, "0")}`;
}

/** Highest serial currently used within this YYMM bucket, or 0 when none exist yet. */
async function currentMax(db: D1Database, yearMonth: string): Promise<number> {
  const monthPrefix = `${PREFIX}${yearMonth}-`;

  // Numeric ordering on the suffix, so 000010 correctly outranks 000009 and
  // the sequence keeps working past 999999 within a single month.
  const row = await db
    .prepare(
      `SELECT MAX(CAST(substr(job_id, ${monthPrefix.length + 1}) AS INTEGER)) AS max_n
         FROM jobs
        WHERE job_id LIKE ?`,
    )
    .bind(`${monthPrefix}%`)
    .first<{ max_n: number | null }>();

  return row?.max_n ?? 0;
}

/** True when a D1 failure is a uniqueness violation rather than a real fault. */
function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|PRIMARY KEY must be unique|constraint failed/i.test(
    message,
  );
}

/**
 * Allocate the next free job ID and run `insert` with it, retrying on
 * collision. `insert` must perform the INSERT into jobs so the PK conflict
 * surfaces here.
 */
export async function insertWithUniqueJobId<T>(
  db: D1Database,
  insert: (jobId: string) => Promise<T>,
  maxAttempts = 5,
): Promise<{ jobId: string; result: T }> {
  const yearMonth = currentYearMonth();
  let next = (await currentMax(db, yearMonth)) + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const jobId = formatJobId(yearMonth, next);
    try {
      const result = await insert(jobId);
      return { jobId, result };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Someone else took this number between our read and write.
      console.warn(`Job ID ${jobId} taken, retrying`);
      next = Math.max(next + 1, (await currentMax(db, yearMonth)) + 1);
    }
  }

  throw new Error(`Could not allocate a unique job ID after ${maxAttempts} attempts`);
}
