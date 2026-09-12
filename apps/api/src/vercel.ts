import { createHmac, timingSafeEqual } from "node:crypto";
import type { VercelProject, VercelStatus } from "@laptop-paas/shared";
import { ensurePlatformUser, PLATFORM_USER_ID } from "./auth.js";
import { config } from "./config.js";
import { query } from "./db/pool.js";
import { openSecret, sealSecret } from "./secret-box.js";

export function vercelOauthConfigured(): boolean {
  return Boolean(config.vercelClientId && config.vercelClientSecret);
}

function stateSecret(): string {
  return (
    config.vercelClientSecret ||
    config.adminToken ||
    "runbase-vercel-oauth-dev"
  );
}

export function signVercelOAuthState(payload: {
  userId: string;
  returnTo: string;
}): string {
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      exp: Date.now() + 1000 * 60 * 15,
    }),
    "utf8",
  ).toString("base64url");
  const sig = createHmac("sha256", stateSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

export function verifyVercelOAuthState(
  state: string,
): { userId: string; returnTo: string } | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", stateSecret())
    .update(body)
    .digest("base64url");
  try {
    if (
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ||
      sig.length !== expected.length
    ) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as { userId?: string; returnTo?: string; exp?: number };
    if (!parsed.userId || !parsed.exp || parsed.exp < Date.now()) return null;
    return {
      userId: parsed.userId,
      returnTo: parsed.returnTo || "/dashboard",
    };
  } catch {
    return null;
  }
}

export function buildVercelAuthorizeUrl(
  state: string,
  callbackBase: string,
): string {
  // Classic connectable-account integration: install → redirect with code
  if (config.vercelIntegrationSlug) {
    const params = new URLSearchParams({ state });
    return `https://vercel.com/integrations/${encodeURIComponent(config.vercelIntegrationSlug)}/new?${params.toString()}`;
  }
  const redirectUri = `${callbackBase.replace(/\/$/, "")}/api/vercel/callback`;
  const params = new URLSearchParams({
    client_id: config.vercelClientId,
    redirect_uri: redirectUri,
    state,
  });
  return `https://vercel.com/oauth/authorize?${params.toString()}`;
}

export async function exchangeVercelOAuthCode(
  code: string,
  callbackBase: string,
): Promise<{ accessToken: string; teamId: string | null }> {
  const redirectUri = `${callbackBase.replace(/\/$/, "")}/api/vercel/callback`;
  const res = await fetch("https://api.vercel.com/v2/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.vercelClientId,
      client_secret: config.vercelClientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    team_id?: string | null;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    throw new Error(
      data.error_description || data.error || "Vercel OAuth exchange failed",
    );
  }
  return {
    accessToken: data.access_token,
    teamId: data.team_id ?? null,
  };
}

async function vercelFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {},
  teamId?: string | null,
): Promise<T> {
  const url = new URL(`https://api.vercel.com${path}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & {
    error?: { message?: string } | string;
    message?: string;
  };
  if (!res.ok) {
    const err =
      typeof data.error === "string"
        ? data.error
        : data.error?.message || data.message || `Vercel API ${res.status}`;
    throw new Error(err);
  }
  return data;
}

export async function fetchVercelUser(token: string): Promise<{
  id: string;
  username: string;
  name: string | null;
}> {
  const data = await vercelFetch<{
    user?: { id?: string; username?: string; name?: string };
    id?: string;
    username?: string;
    name?: string;
  }>(token, "/v2/user");
  const u = data.user ?? data;
  if (!u.id || !u.username) throw new Error("Invalid Vercel token");
  return {
    id: String(u.id),
    username: u.username,
    name: u.name ?? null,
  };
}

export async function saveUserVercelConnection(
  userId: string,
  accessToken: string,
  teamId: string | null = null,
): Promise<{ username: string; teamId: string | null }> {
  if (userId === PLATFORM_USER_ID) {
    await ensurePlatformUser();
  }
  const user = await fetchVercelUser(accessToken);
  const sealed = sealSecret(accessToken, config.tokenEncryptionKey);
  await query(
    `UPDATE users SET
       vercel_user_id = $2,
       vercel_username = $3,
       vercel_access_token = $4,
       vercel_team_id = $5,
       vercel_connected_at = NOW()
     WHERE id = $1`,
    [userId, user.id, user.username, sealed, teamId],
  );
  return { username: user.username, teamId };
}

export async function clearUserVercelConnection(userId: string): Promise<void> {
  await query(
    `UPDATE users SET
       vercel_user_id = NULL,
       vercel_username = NULL,
       vercel_access_token = NULL,
       vercel_team_id = NULL,
       vercel_connected_at = NULL
     WHERE id = $1`,
    [userId],
  );
}

export async function getUserVercelStatus(
  userId: string | null,
): Promise<VercelStatus> {
  if (!userId) {
    return {
      configured: vercelOauthConfigured(),
      connected: false,
      username: null,
      teamId: null,
    };
  }
  const { rows } = await query(
    `SELECT vercel_username, vercel_access_token, vercel_team_id
     FROM users WHERE id = $1`,
    [userId],
  );
  const row = rows[0];
  return {
    configured: vercelOauthConfigured(),
    connected: Boolean(row?.vercel_access_token),
    username: (row?.vercel_username as string) ?? null,
    teamId: (row?.vercel_team_id as string) ?? null,
  };
}

export async function getUserVercelToken(
  userId: string | null,
): Promise<{ token: string; teamId: string | null } | null> {
  if (!userId) return null;
  const { rows } = await query(
    `SELECT vercel_access_token, vercel_team_id FROM users WHERE id = $1`,
    [userId],
  );
  const token = rows[0]?.vercel_access_token as string | undefined;
  if (!token) return null;
  try {
    return {
      token: openSecret(token, config.tokenEncryptionKey),
      teamId: (rows[0]?.vercel_team_id as string) ?? null,
    };
  } catch {
    if (token.startsWith("enc:v1:")) return null;
    return {
      token,
      teamId: (rows[0]?.vercel_team_id as string) ?? null,
    };
  }
}

export async function fetchVercelProjects(
  token: string,
  teamId: string | null,
  opts: { q?: string } = {},
): Promise<{ projects: VercelProject[] }> {
  const data = await vercelFetch<{
    projects?: Array<{
      id: string;
      name: string;
      framework?: string | null;
      accountId?: string | null;
      updatedAt?: number | null;
      link?: { type?: string; repo?: string } | null;
    }>;
  }>(token, "/v9/projects?limit=100", {}, teamId);

  let projects: VercelProject[] = (data.projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    framework: p.framework ?? null,
    accountId: p.accountId ?? null,
    updatedAt: p.updatedAt ?? null,
    link: p.link ?? null,
  }));

  const q = opts.q?.trim().toLowerCase();
  if (q) {
    projects = projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.link?.repo?.toLowerCase().includes(q) ?? false),
    );
  }

  projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { projects };
}

export async function getVercelProject(
  token: string,
  projectId: string,
  teamId: string | null,
): Promise<{
  id: string;
  name: string;
  link?: { type?: string; repo?: string } | null;
}> {
  const data = await vercelFetch<{
    id: string;
    name: string;
    link?: { type?: string; repo?: string } | null;
  }>(token, `/v9/projects/${encodeURIComponent(projectId)}`, {}, teamId);
  return data;
}

/**
 * Prefer a verified custom production domain (e.g. restosync.in) over *.vercel.app.
 */
export async function resolveVercelProjectUrl(
  token: string,
  projectId: string,
  projectName: string,
  teamId: string | null,
): Promise<string> {
  try {
    const data = await vercelFetch<{
      domains?: Array<{
        name: string;
        verified?: boolean;
        redirect?: string | null;
        gitBranch?: string | null;
      }>;
    }>(
      token,
      `/v9/projects/${encodeURIComponent(projectId)}/domains`,
      {},
      teamId,
    );
    const domains = (data.domains ?? []).filter(
      (d) => d.verified !== false && !d.gitBranch,
    );
    const custom = domains.find(
      (d) =>
        !d.name.endsWith(".vercel.app") &&
        !d.redirect &&
        Boolean(d.name.trim()),
    );
    if (custom?.name) return `https://${custom.name}`;

    const redirectedTo = domains.find((d) => d.redirect && !d.redirect.includes("vercel.app"));
    if (redirectedTo?.redirect) {
      const host = redirectedTo.redirect.replace(/^https?:\/\//, "").split("/")[0];
      if (host) return `https://${host}`;
    }

    const vercelApp = domains.find(
      (d) => d.name.endsWith(".vercel.app") && !d.redirect,
    );
    if (vercelApp?.name) return `https://${vercelApp.name}`;
  } catch {
    /* fall through */
  }
  return `https://${projectName}.vercel.app`;
}

export async function upsertVercelEnvVars(
  token: string,
  projectId: string,
  teamId: string | null,
  vars: Array<{ key: string; value: string }>,
): Promise<void> {
  await vercelFetch(
    token,
    `/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true`,
    {
      method: "POST",
      body: JSON.stringify(
        vars.map((v) => ({
          key: v.key,
          value: v.value,
          type: "plain",
          target: ["production", "preview", "development"],
        })),
      ),
    },
    teamId,
  );
}

/** Best-effort redeploy from the latest production deployment. */
export async function redeployVercelProject(
  token: string,
  projectId: string,
  projectName: string,
  teamId: string | null,
): Promise<{ ok: boolean; deploymentUrl: string | null; error?: string }> {
  try {
    const listUrl = `/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1`;
    const listed = await vercelFetch<{
      deployments?: Array<{
        uid?: string;
        url?: string;
        meta?: Record<string, string>;
      }>;
    }>(token, listUrl, {}, teamId);

    const latest = listed.deployments?.[0];
    const body: Record<string, unknown> = {
      name: projectName,
      project: projectId,
      target: "production",
    };
    if (latest?.meta?.githubCommitSha && latest.meta.githubRepo) {
      body.gitSource = {
        type: "github",
        repo: latest.meta.githubRepo,
        ref: latest.meta.githubCommitRef || "main",
        sha: latest.meta.githubCommitSha,
      };
    }

    const created = await vercelFetch<{ url?: string }>(
      token,
      "/v13/deployments?forceNew=1",
      { method: "POST", body: JSON.stringify(body) },
      teamId,
    );
    return {
      ok: true,
      deploymentUrl: created.url ? `https://${created.url}` : null,
    };
  } catch (err) {
    return {
      ok: false,
      deploymentUrl: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Public URL a Vercel frontend should use to reach this Runbase backend. */
export function backendPublicUrl(
  projectName: string,
  override?: string,
): string {
  if (override?.trim()) return override.trim().replace(/\/$/, "");
  const base = (
    config.publicAppBase ||
    config.githubOAuthCallbackBase ||
    `http://${config.publicHost}`
  ).replace(/\/$/, "");
  return `${base}/p/${projectName}`;
}

export function vercelDashboardUrl(projectName: string): string {
  return `https://vercel.com/${projectName}`;
}
