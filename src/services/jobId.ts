/**
 * Job ID generation — format IFX-00001.
 *
 * Derives the next number from the current maximum rather than a row count,
 * so deleting a job never causes an ID to be reused.
 *
 * Concurrency: two simultaneous intakes can compute the same candidate. The
 * PRIMARY KEY on jobs(job_id) is the real guard — the loser's INSERT fails
 * and the caller retries via `insertWithUniqueJobId`. Checking first and
 * inserting later would race; the retry-on-conflict is what actually holds.
 */

const PREFIX = "IFX-";
const PAD = 5;

export function formatJobId(n: number): string {
  return `${PREFIX}${String(n).padStart(PAD, "0")}`;
}

/** Highest job number currently in use, or 0 when the table is empty. */
async function currentMax(db: D1Database): Promise<number> {
  // Numeric ordering on the suffix, so IFX-00010 correctly outranks IFX-00009
  // and the sequence keeps working past 99999.
  const row = await db
    .prepare(
      `SELECT MAX(CAST(substr(job_id, ${PREFIX.length + 1}) AS INTEGER)) AS max_n
         FROM jobs
        WHERE job_id LIKE '${PREFIX}%'`,
    )
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
  let next = (await currentMax(db)) + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const jobId = formatJobId(next);
    try {
      const result = await insert(jobId);
      return { jobId, result };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Someone else took this number between our read and write.
      console.warn(`Job ID ${jobId} taken, retrying`);
      next = Math.max(next + 1, (await currentMax(db)) + 1);
    }
  }

  throw new Error(`Could not allocate a unique job ID after ${maxAttempts} attempts`);
}
