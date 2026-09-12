import pg from "pg";

/**
 * Pool tuning matters a lot on a WSL2/Docker Desktop host: idle TCP connections
 * get silently dropped by the NAT layer when the laptop sleeps or the network
 * flaps. Without `keepAlive` the first query after an idle period hangs until
 * the OS TCP timeout (~2 minutes) instead of failing fast and reconnecting —
 * which is exactly what "the dashboard froze / the API is slow" looks like.
 */
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 16),
  min: Number(process.env.PG_POOL_MIN ?? 2),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 8_000),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 20_000),
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS ?? 20_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  allowExitOnIdle: false,
});

// A pool-level error (server restart, dropped socket) is emitted on the pool,
// not on the caller's promise. Unhandled, it takes the whole process down.
pool.on("error", (err) => {
  console.error("[pg] idle client error:", err.message);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return pool.query<T>(text, params);
}

/** Cheap liveness probe used by /api/health. */
export async function pingDatabase(timeoutMs = 3000): Promise<number | null> {
  const started = Date.now();
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    return Date.now() - started;
  } catch {
    return null;
  }
}
