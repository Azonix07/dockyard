import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { assertConfig, config } from "./config.js";
import { registerRoutes } from "./routes.js";
import { pool } from "./db/pool.js";

assertConfig();

const app = Fastify({
  logger: true,
  bodyLimit: 5 * 1024 * 1024,
});

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = new Set(
      [config.webOrigin, "http://localhost:3000", "http://127.0.0.1:3000"].filter(
        Boolean,
      ),
    );
    // Allow same-tailnet hosts for dashboard (any http origin in private use)
    if (allowed.has(origin) || origin.includes(".ts.net") || origin.includes("localhost")) {
      return cb(null, true);
    }
    return cb(null, true); // single-user laptop PaaS; token still required
  },
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

try {
  await pool.query("SELECT 1");
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
