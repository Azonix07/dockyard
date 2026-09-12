import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { GitHubRepo } from "@laptop-paas/shared";
import { ensurePlatformUser, PLATFORM_USER_ID } from "./auth.js";
import { config } from "./config.js";
import { query } from "./db/pool.js";
import { openSecret, sealSecret } from "./secret-box.js";

export function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!config.githubWebhookSecret) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", config.githubWebhookSecret)
    .update(rawBody)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(received, "utf8"),
    );
  } catch {
    return false;
  }
}

export async function getGitHubCloneToken(): Promise<string | null> {
  if (config.githubToken) return config.githubToken;
  if (
    !config.githubAppId ||
    !config.githubAppPrivateKey ||
    !config.githubAppInstallationId
  ) {
    return null;
  }
  const auth = createAppAuth({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
    installationId: Number(config.githubAppInstallationId),
  });
  const installationAuth = await auth({ type: "installation" });
  return installationAuth.token;
}

export async function getUserGitHubToken(
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const { rows } = await query(
    `SELECT github_access_token FROM users WHERE id = $1`,
    [userId],
  );
  const stored = rows[0]?.github_access_token as string | undefined;
  if (!stored) return null;
  try {
    return openSecret(stored, config.tokenEncryptionKey);
  } catch {
    return stored.startsWith("enc:v1:") ? null : stored;
  }
}

/** Prefer the project owner's OAuth token, then host PAT / App. */
export async function getCloneTokenForOwner(
  ownerId: string | null,
): Promise<string | null> {
  const userToken = await getUserGitHubToken(ownerId);
  if (userToken) return userToken;
  return getGitHubCloneToken();
}

export async function createOctokit(
  token?: string | null,
): Promise<Octokit | null> {
  const auth = token ?? (await getGitHubCloneToken());
  if (!auth) return null;
  return new Octokit({ auth });
}

export function parseRepo(repoUrl: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(repoUrl.replace(/\.git$/, ""));
    if (!u.hostname.includes("github.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

export function authenticatedCloneUrl(repoUrl: string, token: string): string {
  const u = new URL(repoUrl.replace(/\.git$/, "") + ".git");
  u.username = "x-access-token";
  u.password = token;
  return u.toString();
}

export function oauthConfigured(): boolean {
  return Boolean(config.githubClientId && config.githubClientSecret);
}

function stateSecret(): string {
  return (
    config.githubClientSecret ||
    config.adminToken ||
    "runbase-github-oauth-dev"
  );
}

export function signOAuthState(payload: {
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

export function verifyOAuthState(
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
      returnTo: parsed.returnTo || "/new",
    };
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl(state: string, callbackBase: string): string {
  const redirectUri = `${callbackBase.replace(/\/$/, "")}/api/github/callback`;
  const params = new URLSearchParams({
    client_id: config.githubClientId,
    redirect_uri: redirectUri,
    state,
  });
  // GitHub Apps ignore classic scopes; permissions come from the app.
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export function buildInstallUrl(): string | null {
  const slug = config.githubAppSlug;
  if (!slug) return null;
  return `https://github.com/apps/${slug}/installations/new`;
}

export async function exchangeOAuthCode(
  code: string,
  callbackBase: string,
): Promise<{ accessToken: string; scope: string }> {
  const redirectUri = `${callbackBase.replace(/\/$/, "")}/api/github/callback`;
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    throw new Error(
      data.error_description || data.error || "GitHub OAuth exchange failed",
    );
  }
  return { accessToken: data.access_token, scope: data.scope ?? "" };
}

export async function fetchGitHubRepos(
  token: string,
  opts: { q?: string; page?: number; perPage?: number } = {},
): Promise<{ repos: GitHubRepo[]; hasMore: boolean }> {
  const octokit = new Octokit({ auth: token });
  const page = opts.page ?? 1;
  const perPage = Math.min(opts.perPage ?? 30, 100);
  const listed = await listUserRepos(octokit, page, perPage);
  const q = opts.q?.trim().toLowerCase();
  if (!q) return listed;
  return {
    repos: listed.repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false),
    ),
    hasMore: listed.hasMore,
  };
}

async function listUserRepos(
  octokit: Octokit,
  page: number,
  perPage: number,
): Promise<{ repos: GitHubRepo[]; hasMore: boolean }> {
  try {
    const { data } = await octokit.repos.listForAuthenticatedUser({
      per_page: perPage,
      page,
      sort: "updated",
      affiliation: "owner,collaborator,organization_member",
    });
    if (data.length > 0) {
      return {
        repos: data.map(mapGhRepo),
        hasMore: data.length === perPage,
      };
    }
  } catch {
    /* fall through to installation listing */
  }

  // GitHub App user tokens: list repos via installations the user can access
  const installations = await octokit.apps.listInstallationsForAuthenticatedUser({
    per_page: 100,
  });
  const repos: GitHubRepo[] = [];
  for (const inst of installations.data.installations) {
    const listed =
      await octokit.apps.listInstallationReposForAuthenticatedUser({
        installation_id: inst.id,
        per_page: perPage,
        page,
      });
    for (const r of listed.data.repositories) {
      repos.push(mapGhRepo(r));
    }
  }
  repos.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return { repos, hasMore: false };
}

function mapGhRepo(r: {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  default_branch?: string;
  html_url: string;
  clone_url: string;
  description: string | null;
  updated_at: string | null;
}): GitHubRepo {
  return {
    id: r.id,
    fullName: r.full_name,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch ?? "main",
    htmlUrl: r.html_url,
    cloneUrl: r.clone_url,
    description: r.description,
    updatedAt: r.updated_at,
  };
}

export async function saveUserGitHubConnection(
  userId: string,
  accessToken: string,
): Promise<{ login: string }> {
  if (userId === PLATFORM_USER_ID) {
    await ensurePlatformUser();
  }
  const octokit = new Octokit({ auth: accessToken });
  const { data: ghUser } = await octokit.users.getAuthenticated();
  const sealed = sealSecret(accessToken, config.tokenEncryptionKey);
  await query(
    `UPDATE users SET
      github_login = $2,
      github_user_id = $3,
      github_access_token = $4,
      github_connected_at = NOW()
     WHERE id = $1`,
    [userId, ghUser.login, ghUser.id, sealed],
  );
  return { login: ghUser.login };
}

export async function clearUserGitHubConnection(userId: string): Promise<void> {
  await query(
    `UPDATE users SET
      github_login = NULL,
      github_user_id = NULL,
      github_access_token = NULL,
      github_connected_at = NULL
     WHERE id = $1`,
    [userId],
  );
}

export async function getUserGitHubStatus(userId: string | null): Promise<{
  login: string | null;
  connected: boolean;
}> {
  if (!userId) return { login: null, connected: false };
  const { rows } = await query(
    `SELECT github_login, github_access_token FROM users WHERE id = $1`,
    [userId],
  );
  const login = (rows[0]?.github_login as string | null) ?? null;
  const token = rows[0]?.github_access_token as string | undefined;
  return { login, connected: Boolean(token && login) };
}
