import type { FastifyReply, FastifyRequest } from "fastify";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Simple in-memory sliding window rate limit (per-process). */
export function rateLimit(opts: {
  key: string;
  limit: number;
  windowMs: number;
}): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  let b = buckets.get(opts.key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + opts.windowMs };
    buckets.set(opts.key, b);
  }
  b.count += 1;
  if (b.count > opts.limit) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    };
  }
  return { ok: true, retryAfterSec: 0 };
}

export function clientIp(request: FastifyRequest): string {
  const xf = request.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0]!.trim();
  return request.ip || "unknown";
}

export function enforceRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  name: string,
  limit: number,
  windowMs: number,
): boolean {
  const result = rateLimit({
    key: `${name}:${clientIp(request)}`,
    limit,
    windowMs,
  });
  if (!result.ok) {
    void reply
      .code(429)
      .header("Retry-After", String(result.retryAfterSec))
      .send({ error: "Too many requests. Try again shortly." });
    return false;
  }
  return true;
}

// Opportunistic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}, 60_000).unref?.();
