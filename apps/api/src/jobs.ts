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
  return mapJob(rows[0]);
}
