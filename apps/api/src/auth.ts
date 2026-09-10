import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PlanId, User } from "@laptop-paas/shared";
import { config } from "./config.js";
import { query } from "./db/pool.js";

const scrypt = promisify(scryptCb);

export type AuthContext =
  | { kind: "user"; user: User; token: string }
  | { kind: "admin"; token: string };

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

type UserRow = {
  id: string;
  email: string;
  name: string;
  plan: PlanId;
  onboarding_completed: boolean;
  created_at: Date;
};

export function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: row.plan,
    onboardingCompleted: row.onboarding_completed,
    createdAt: row.created_at.toISOString(),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) return "";
  return header.startsWith("Bearer ") ? header.slice(7) : header;
}

function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expires.toISOString()],
  );
  return token;
}

export async function destroySession(token: string): Promise<void> {
  if (!token) return;
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export async function resolveAuth(
  request: FastifyRequest,
): Promise<AuthContext | null> {
  const token = bearerToken(request);
  if (!token) return null;

  if (config.adminToken && safeEqualString(token, config.adminToken)) {
    return { kind: "admin", token };
  }

  const { rows } = await query(
    `SELECT u.*
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hashToken(token)],
  );
  if (!rows[0]) return null;
  return { kind: "user", user: mapUser(rows[0] as UserRow), token };
}

/** Legacy alias used by older imports */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  return requireAuth(request, reply);
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = await resolveAuth(request);
  if (!auth) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  request.auth = auth;
}

export function ownerFilter(
  auth: AuthContext,
  column = "owner_id",
): { sql: string; params: unknown[] } {
  if (auth.kind === "admin") {
    return { sql: "TRUE", params: [] };
  }
  return { sql: `${column} = $1`, params: [auth.user.id] };
}

export function currentUserId(auth: AuthContext): string | null {
  return auth.kind === "user" ? auth.user.id : null;
}
