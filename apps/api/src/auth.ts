import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const header = request.headers.authorization;
  const token =
    header?.startsWith("Bearer ") ? header.slice(7) : (header ?? "");
  const expected = config.adminToken;
  if (!token || !expected) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}
