import { query } from "./db/pool.js";
import { mapJob } from "./db/mappers.js";
import type { JobType } from "@laptop-paas/shared";

export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown>,
) {
  const { rows } = await query(
    `INSERT INTO jobs (type, status, payload)
     VALUES ($1, 'queued', $2::jsonb)
     RETURNING *`,
    [type, JSON.stringify(payload)],
  );
  // Wake the worker immediately instead of making it wait for the next poll.
  // Best-effort: the worker still polls as a fallback.
  try {
    await query(`NOTIFY runbase_jobs`);
  } catch {
    /* the poll loop will pick it up */
  }
  return mapJob(rows[0]);
}
