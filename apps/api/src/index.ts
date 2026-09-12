import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { assertConfig, config } from "./config.js";
import { registerRoutes } from "./routes.js";
import { pool } from "./db/pool.js";
import { sealSecret, isSealedSecret } from "./secret-box.js";

assertConfig();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  bodyLimit: 5 * 1024 * 1024,
  trustProxy: true,
  // Keep idle upstream connections alive longer than the proxy in front of us
  // (Caddy holds them for 2m). If the API hangs up first, the proxy can send a
  // request onto a socket that is closing and surface it as a 502.
  keepAliveTimeout: Number(process.env.KEEPALIVE_TIMEOUT_MS ?? 150_000),
  connectionTimeout: Number(process.env.CONNECTION_TIMEOUT_MS ?? 0),
});

function isAllowedOrigin(origin: string): boolean {
  const allowed = new Set(
    [
      config.webOrigin,
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3100",
      "http://127.0.0.1:3100",
      "https://dockyard-azonix07s-projects.vercel.app",
      "https://runbase.in",
      "https://www.runbase.in",
      ...config.corsExtraOrigins,
    ].filter(Boolean),
  );
  if (allowed.has(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith(".ts.net")) return true;
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    // Vercel preview deployments for this project
    if (
      u.hostname.endsWith(".vercel.app") &&
      (u.hostname.includes("azonix07") || u.hostname.startsWith("web-"))
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / server-to-server
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Accept"],
  maxAge: 86400,
});

app.addHook("onSend", async (request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (config.nodeEnv === "production") {
    reply.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  // Don't cache authenticated API responses
  if (request.url.startsWith("/api/") && request.headers.authorization) {
    reply.header("Cache-Control", "no-store");
  }
  return payload;
});

app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (req, body, done) => {
    try {
      const raw = body as string;
      (req as { rawBody?: string }).rawBody = raw;
      const json = raw ? JSON.parse(raw) : {};
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

await registerRoutes(app);

/** One-time: seal any plaintext OAuth tokens still in the DB. */
async function migrateSealTokens(): Promise<void> {
  if (!config.tokenEncryptionKey) return;
  const { rows } = await pool.query(
    `SELECT id, github_access_token, vercel_access_token FROM users
     WHERE (github_access_token IS NOT NULL AND github_access_token <> '')
        OR (vercel_access_token IS NOT NULL AND vercel_access_token <> '')`,
  );
  for (const row of rows) {
    const id = row.id as string;
    let gh = row.github_access_token as string | null;
    let vx = row.vercel_access_token as string | null;
    let changed = false;
    if (gh && !isSealedSecret(gh)) {
      gh = sealSecret(gh, config.tokenEncryptionKey);
      changed = true;
    }
    if (vx && !isSealedSecret(vx)) {
      vx = sealSecret(vx, config.tokenEncryptionKey);
      changed = true;
    }
    if (changed) {
      await pool.query(
        `UPDATE users SET github_access_token = $2, vercel_access_token = $3 WHERE id = $1`,
        [id, gh, vx],
      );
    }
  }
}

/**
 * Postgres may not be accepting connections yet — after a Windows reboot the
 * whole stack comes up at once. Retry instead of exiting, so the API does not
 * enter a crash/restart cycle while the database finishes starting.
 */
async function waitForDatabase(maxWaitMs = 120_000): Promise<void> {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      await pool.query("SELECT 1");
      if (attempt > 0) {
        app.log.info(`Database reachable after ${Date.now() - started}ms`);
      }
      return;
    } catch (err) {
      attempt += 1;
      if (Date.now() - started > maxWaitMs) throw err;
      const delay = Math.min(5000, 250 * attempt);
      app.log.warn(
        `Database not ready (attempt ${attempt}): ${
          err instanceof Error ? err.message : String(err)
        }. Retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

let shuttingDown = false;

/** Finish in-flight requests before the process goes away. */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received — draining`);
  const timer = setTimeout(() => {
    app.log.warn("Drain timed out — exiting");
    process.exit(1);
  }, 15_000);
  timer.unref?.();
  try {
    await app.close();
    await pool.end();
  } catch (err) {
    app.log.warn({ err }, "shutdown error");
  }
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}

// Never let a stray rejection take the API down — it is the front door.
process.on("unhandledRejection", (reason) => {
  app.log.error({ reason }, "unhandled rejection");
});
process.on("uncaughtException", (err) => {
  app.log.error({ err }, "uncaught exception");
});

try {
  await waitForDatabase();
  await migrateSealTokens();
  await app.listen({ port: config.port, host: "0.0.0.0" });

  // Prune expired sessions periodically
  setInterval(() => {
    void pool
      .query(`DELETE FROM sessions WHERE expires_at < NOW()`)
      .catch((err) => app.log.warn({ err }, "session prune failed"));
  }, 60 * 60_000).unref?.();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
