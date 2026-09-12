import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CreateDatabaseSchema,
  CreateProjectSchema,
  DATABASE_PRESETS,
  LoginSchema,
  PLANS,
  SelectPlanSchema,
  SignupSchema,
  TriggerDeploySchema,
  UpdateProjectSchema,
  LinkVercelProjectSchema,
  buildDatabaseConnectionUrl,
  clampResourcesToPlan,
  databaseImage,
  slugHostname,
  type PlanId,
  type ResourceMetrics,
  type UsageSummary,
} from "@laptop-paas/shared";
import {
  connectionOwnerId,
  createSession,
  currentUserId,
  destroySession,
  ensurePlatformUser,
  hashPassword,
  mapUser,
  ownerFilter,
  requireAuth,
  verifyPassword,
  type AuthContext,
} from "./auth.js";
import { config } from "./config.js";
import { pingDatabase, query } from "./db/pool.js";
import { mapDatabase, mapDeploy, mapProject } from "./db/mappers.js";
import { enqueueJob } from "./jobs.js";
import { enforceRateLimit } from "./rate-limit.js";
import {
  buildAuthorizeUrl,
  buildInstallUrl,
  clearUserGitHubConnection,
  createOctokit,
  exchangeOAuthCode,
  fetchGitHubRepos,
  getUserGitHubStatus,
  getUserGitHubToken,
  oauthConfigured,
  parseRepo,
  saveUserGitHubConnection,
  signOAuthState,
  verifyGitHubSignature,
  verifyOAuthState,
} from "./github.js";
import { analyzeRepository } from "./analyze.js";
import { registerAdminRoutes } from "./admin.js";
import {
  backendPublicUrl,
  buildVercelAuthorizeUrl,
  clearUserVercelConnection,
  exchangeVercelOAuthCode,
  fetchVercelProjects,
  getUserVercelStatus,
  getUserVercelToken,
  getVercelProject,
  redeployVercelProject,
  resolveVercelProjectUrl,
  saveUserVercelConnection,
  signVercelOAuthState,
  upsertVercelEnvVars,
  verifyVercelOAuthState,
  vercelDashboardUrl,
  vercelOauthConfigured,
} from "./vercel.js";
import {
  caddyAdminReachable,
  containerLogs,
  containerStats,
  getDocker,
} from "@laptop-paas/docker";
import { randomBytes } from "node:crypto";
import { z } from "zod";

function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new Error("Missing auth context");
  return request.auth;
}

async function getOwnedProject(auth: AuthContext, id: string) {
  const filter = ownerFilter(auth);
  const { rows } = filter.params.length
    ? await query(
        `SELECT * FROM projects WHERE id = $2 AND owner_id = $1`,
        [filter.params[0], id],
      )
    : await query(`SELECT * FROM projects WHERE id = $1`, [id]);
  return rows[0] ? mapProject(rows[0]) : null;
}

async function enqueueDeploy(
  projectId: string,
  opts: {
    commitSha?: string | null;
    triggeredBy?: string;
    redeploy?: boolean;
  } = {},
) {
  const triggeredBy = opts.triggeredBy ?? "manual";
  const { rows } = await query(
    `INSERT INTO deploys (project_id, commit_sha, status, triggered_by)
     VALUES ($1, $2, 'queued', $3)
     RETURNING *`,
    [projectId, opts.commitSha ?? null, triggeredBy],
  );
  const deploy = mapDeploy(rows[0]);
  await query(
    `UPDATE projects SET status = 'deploying', updated_at = NOW() WHERE id = $1`,
    [projectId],
  );
  await enqueueJob("deploy", {
    projectId,
    deployId: deploy.id,
    commitSha: opts.commitSha ?? null,
    redeploy: Boolean(opts.redeploy),
  });
  return deploy;
}

export async function registerRoutes(app: FastifyInstance) {
  /**
   * Liveness only — never touches the database, so an uptime monitor can tell
   * "the API process is gone" apart from "Postgres is slow".
   */
  app.get("/api/health", async (request, reply) => {
    void reply.header("Cache-Control", "no-store");
    return {
      ok: true,
      service: "laptop-paas-api",
      publicHost: config.publicHost,
      uptimeSec: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    };
  });

  /** Readiness — checks the dependencies this API actually needs. */
  app.get("/api/ready", async (request, reply) => {
    void reply.header("Cache-Control", "no-store");
    const [dbMs, proxyOk] = await Promise.all([
      pingDatabase(3000),
      caddyAdminReachable(process.env.CADDY_ADMIN_URL),
    ]);

    let dockerOk = false;
    try {
      await getDocker().ping();
      dockerOk = true;
    } catch {
      dockerOk = false;
    }

    const ok = dbMs !== null && dockerOk;
    if (!ok) void reply.code(503);
    return {
      ok,
      checks: {
        database: { ok: dbMs !== null, latencyMs: dbMs },
        docker: { ok: dockerOk },
        proxy: { ok: proxyOk },
      },
      uptimeSec: Math.round(process.uptime()),
    };
  });

  app.get("/api/plans", async () => ({ plans: Object.values(PLANS) }));

  app.get("/api/database-presets", async () => ({
    presets: Object.values(DATABASE_PRESETS),
  }));

  app.post("/api/auth/signup", async (request, reply) => {
    if (!enforceRateLimit(request, reply, "signup", 10, 15 * 60_000)) return;
    const parsed = SignupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { email, password, name } = parsed.data;
    const passwordHash = await hashPassword(password);
    try {
      const { rows } = await query(
        `INSERT INTO users (email, password_hash, name, plan, onboarding_completed)
         VALUES ($1, $2, $3, 'hobby', FALSE)
         RETURNING id, email, name, plan, onboarding_completed, created_at`,
        [email.toLowerCase(), passwordHash, name.trim()],
      );
      const user = mapUser(rows[0] as Parameters<typeof mapUser>[0]);
      const token = await createSession(user.id);
      return reply.code(201).send({ user, token, plans: Object.values(PLANS) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("unique") || message.includes("duplicate")) {
        return reply.code(409).send({ error: "An account with that email already exists" });
      }
      throw err;
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    if (!enforceRateLimit(request, reply, "login", 20, 15 * 60_000)) return;
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const { rows } = await query(
      `SELECT * FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    if (!rows[0]) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    const ok = await verifyPassword(password, rows[0].password_hash as string);
    if (!ok) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    const user = mapUser(rows[0] as Parameters<typeof mapUser>[0]);
    const token = await createSession(user.id);
    return { user, token };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const header = request.headers.authorization;
    const token =
      header?.startsWith("Bearer ") ? header.slice(7) : (header ?? "");
    await destroySession(token);
    return reply.send({ ok: true });
  });

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0];
    const publicPaths = new Set([
      "/api/health",
      "/api/ready",
      "/api/plans",
      "/api/database-presets",
      "/api/auth/signup",
      "/api/auth/login",
      "/api/auth/logout",
      "/api/webhooks/github",
      "/api/github/callback",
      "/api/vercel/callback",
    ]);
    if (
      publicPaths.has(path) ||
      path.startsWith("/api/webhooks/") ||
      path === "/api/github/callback" ||
      path === "/api/vercel/callback"
    ) {
      return;
    }
    if (path.startsWith("/api/")) {
      return requireAuth(request, reply);
    }
  });

  app.get("/api/auth/me", async (request) => {
    const auth = authOf(request);
    if (auth.kind === "admin") {
      return {
        user: {
          id: "admin",
          email: "admin@runbase.local",
          name: "Admin",
          plan: "pro" as PlanId,
          onboardingCompleted: true,
          createdAt: new Date(0).toISOString(),
        },
        authKind: "admin",
        plan: PLANS.pro,
      };
    }
    return {
      user: auth.user,
      authKind: "user",
      plan: PLANS[auth.user.plan],
    };
  });

  app.post("/api/auth/plan", async (request, reply) => {
    const auth = authOf(request);
    const parsed = SelectPlanSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (auth.kind === "admin") {
      return { user: { id: "admin", email: "admin@runbase.local", name: "Admin", plan: parsed.data.plan, onboardingCompleted: true, createdAt: new Date(0).toISOString() }, plan: PLANS[parsed.data.plan] };
    }
    // Self-serve may complete onboarding on Hobby only; Pro is admin-granted
    if (parsed.data.plan === "pro" && auth.user.plan !== "pro") {
      return reply.code(403).send({
        error: "Pro plan is granted by the platform admin.",
      });
    }
    const { rows } = await query(
      `UPDATE users SET plan = $2, onboarding_completed = TRUE WHERE id = $1
       RETURNING id, email, name, plan, onboarding_completed, created_at`,
      [auth.user.id, parsed.data.plan],
    );
    const user = mapUser(rows[0] as Parameters<typeof mapUser>[0]);
    return { user, plan: PLANS[user.plan] };
  });

  function oauthCallbackBase(request: FastifyRequest): string {
    if (config.githubOAuthCallbackBase) {
      return config.githubOAuthCallbackBase.replace(/\/$/, "");
    }
    const proto = String(request.headers["x-forwarded-proto"] ?? "http");
    const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost");
    return `${proto}://${host}`;
  }

  app.get("/api/github/status", async (request) => {
    const auth = authOf(request);
    await ensurePlatformUser();
    const userId = connectionOwnerId(auth);
    const status = await getUserGitHubStatus(userId);
    const hostToken = Boolean(config.githubToken) && auth.kind === "admin";
    let hostLogin: string | null = null;
    if (!status.connected && hostToken) {
      try {
        const octokit = await createOctokit(config.githubToken);
        if (octokit) {
          const { data } = await octokit.users.getAuthenticated();
          hostLogin = data.login;
        }
      } catch {
        hostLogin = null;
      }
    }
    return {
      configured: oauthConfigured(),
      connected: status.connected,
      login: status.login ?? hostLogin,
      // Host GITHUB_TOKEN is only for super-admin (shared org PAT)
      canListViaHostToken: hostToken && auth.kind === "admin",
    };
  });

  app.post("/api/github/token", async (request, reply) => {
    const auth = authOf(request);
    await ensurePlatformUser();
    const userId = connectionOwnerId(auth);
    const body = z
      .object({ token: z.string().min(20).max(256) })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Provide a GitHub personal access token" });
    }
    try {
      const { login } = await saveUserGitHubConnection(userId, body.data.token.trim());
      return { connected: true, login };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: `Invalid GitHub token: ${message}` });
    }
  });

  app.get("/api/github/connect", async (request, reply) => {
    const auth = authOf(request);
    if (!oauthConfigured()) {
      return reply.code(503).send({
        error:
          "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on the API.",
      });
    }
    await ensurePlatformUser();
    const returnTo =
      typeof (request.query as { returnTo?: string }).returnTo === "string"
        ? (request.query as { returnTo: string }).returnTo
        : "/new";
    const safeReturnTo =
      returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/new";
    const state = signOAuthState({
      userId: connectionOwnerId(auth),
      returnTo: safeReturnTo,
    });
    const url = buildAuthorizeUrl(state, oauthCallbackBase(request));
    return { url };
  });

  app.get("/api/github/callback", async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string };
    const web = config.webOrigin.replace(/\/$/, "");
    if (q.error) {
      return reply.redirect(`${web}/new?github=error&reason=${encodeURIComponent(q.error)}`);
    }
    if (!q.code || !q.state) {
      return reply.redirect(`${web}/new?github=error&reason=missing_code`);
    }
    const verified = verifyOAuthState(q.state);
    if (!verified) {
      return reply.redirect(`${web}/new?github=error&reason=invalid_state`);
    }
    try {
      await ensurePlatformUser();
      const { accessToken } = await exchangeOAuthCode(
        q.code,
        oauthCallbackBase(request),
      );
      const { login } = await saveUserGitHubConnection(
        verified.userId,
        accessToken,
      );
      // Railway-style: after OAuth, ensure the GitHub App is installed so repos appear
      const installUrl = buildInstallUrl();
      if (installUrl) {
        return reply.redirect(installUrl);
      }
      const dest = verified.returnTo.startsWith("/")
        ? verified.returnTo
        : "/new";
      return reply.redirect(
        `${web}${dest}${dest.includes("?") ? "&" : "?"}github=connected&login=${encodeURIComponent(login)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "oauth_failed";
      return reply.redirect(
        `${web}/new?github=error&reason=${encodeURIComponent(msg)}`,
      );
    }
  });

  app.delete("/api/github/disconnect", async (request, reply) => {
    const auth = authOf(request);
    const userId = connectionOwnerId(auth);
    await clearUserGitHubConnection(userId);
    return { ok: true };
  });

  app.get("/api/github/repos", async (request, reply) => {
    const auth = authOf(request);
    const q = request.query as { q?: string; page?: string };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const userId = connectionOwnerId(auth);
    let token = await getUserGitHubToken(userId);
    if (!token && config.githubToken && auth.kind === "admin") {
      token = config.githubToken;
    }
    if (!token) {
      return reply.code(401).send({
        error: "Connect your GitHub account first",
        code: "github_not_connected",
      });
    }
    try {
      const result = await fetchGitHubRepos(token, {
        q: q.q,
        page,
        perPage: 30,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `GitHub API error: ${message}` });
    }
  });

  app.get("/api/vercel/status", async (request) => {
    const auth = authOf(request);
    await ensurePlatformUser();
    const status = await getUserVercelStatus(connectionOwnerId(auth));
    return status;
  });

  app.post("/api/vercel/token", async (request, reply) => {
    const auth = authOf(request);
    const userId = connectionOwnerId(auth);
    await ensurePlatformUser();
    const body = z
      .object({
        token: z.string().min(20).max(256),
        teamId: z.string().min(1).optional(),
      })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Provide a Vercel access token" });
    }
    try {
      const saved = await saveUserVercelConnection(
        userId,
        body.data.token.trim(),
        body.data.teamId ?? null,
      );
      return { connected: true, username: saved.username, teamId: saved.teamId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: `Invalid Vercel token: ${message}` });
    }
  });

  app.get("/api/vercel/connect", async (request, reply) => {
    const auth = authOf(request);
    if (!vercelOauthConfigured()) {
      return reply.code(503).send({
        error:
          "Vercel OAuth is not configured on this host. Use Connect Vercel account (one-time bind), or set VERCEL_CLIENT_ID and VERCEL_CLIENT_SECRET.",
      });
    }
    await ensurePlatformUser();
    const returnTo =
      typeof (request.query as { returnTo?: string }).returnTo === "string"
        ? (request.query as { returnTo: string }).returnTo
        : "/dashboard";
    const safeReturnTo =
      returnTo.startsWith("/") && !returnTo.startsWith("//")
        ? returnTo
        : "/dashboard";
    const state = signVercelOAuthState({
      userId: connectionOwnerId(auth),
      returnTo: safeReturnTo,
    });
    const callbackBase =
      config.vercelOAuthCallbackBase ||
      config.githubOAuthCallbackBase ||
      oauthCallbackBase(request);
    const url = buildVercelAuthorizeUrl(state, callbackBase);
    return { url };
  });

  app.get("/api/vercel/callback", async (request, reply) => {
    const q = request.query as {
      code?: string;
      state?: string;
      error?: string;
      teamId?: string;
      configurationId?: string;
      next?: string;
    };
    const web = config.webOrigin.replace(/\/$/, "");
    if (q.error) {
      return reply.redirect(
        `${web}/dashboard?vercel=error&reason=${encodeURIComponent(q.error)}`,
      );
    }
    if (!q.code || !q.state) {
      return reply.redirect(`${web}/dashboard?vercel=error&reason=missing_code`);
    }
    const verified = verifyVercelOAuthState(q.state);
    if (!verified) {
      return reply.redirect(`${web}/dashboard?vercel=error&reason=invalid_state`);
    }
    try {
      await ensurePlatformUser();
      const callbackBase =
        config.vercelOAuthCallbackBase ||
        config.githubOAuthCallbackBase ||
        oauthCallbackBase(request);
      const { accessToken, teamId } = await exchangeVercelOAuthCode(
        q.code,
        callbackBase,
      );
      const { username } = await saveUserVercelConnection(
        verified.userId,
        accessToken,
        teamId ?? q.teamId ?? null,
      );
      const dest = verified.returnTo.startsWith("/")
        ? verified.returnTo
        : "/dashboard";
      // Prefer Vercel's "next" (finish install) then our app, when present
      if (q.next) {
        try {
          const nextUrl = new URL(q.next);
          if (
            nextUrl.protocol === "https:" &&
            (nextUrl.hostname === "vercel.com" ||
              nextUrl.hostname.endsWith(".vercel.com"))
          ) {
            return reply.redirect(nextUrl.toString());
          }
        } catch {
          /* ignore invalid next */
        }
      }
      return reply.redirect(
        `${web}${dest}${dest.includes("?") ? "&" : "?"}vercel=connected&user=${encodeURIComponent(username)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "oauth_failed";
      return reply.redirect(
        `${web}/dashboard?vercel=error&reason=${encodeURIComponent(msg)}`,
      );
    }
  });

  app.delete("/api/vercel/disconnect", async (request, reply) => {
    const auth = authOf(request);
    const userId = connectionOwnerId(auth);
    await clearUserVercelConnection(userId);
    return { ok: true };
  });

  app.get("/api/vercel/projects", async (request, reply) => {
    const auth = authOf(request);
    const userId = connectionOwnerId(auth);
    const creds = await getUserVercelToken(userId);
    if (!creds) {
      return reply.code(401).send({
        error: "Connect your Vercel account first",
        code: "vercel_not_connected",
      });
    }
    const q = (request.query as { q?: string }).q;
    try {
      return await fetchVercelProjects(creds.token, creds.teamId, { q });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/api/projects/:id/backend-url", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getOwnedProject(authOf(request), id);
    if (!project) return reply.code(404).send({ error: "Not found" });
    return {
      backendUrl: backendPublicUrl(project.name),
      pathUrl: `/p/${project.name}`,
      hostname: project.hostname,
      publicHost: config.publicHost,
    };
  });

  app.post("/api/projects/:id/vercel/link", async (request, reply) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const project = await getOwnedProject(auth, id);
    if (!project) return reply.code(404).send({ error: "Not found" });

    const userId = connectionOwnerId(auth);
    const creds = await getUserVercelToken(userId);
    if (!creds) {
      return reply.code(401).send({
        error: "Connect your Vercel account first",
        code: "vercel_not_connected",
      });
    }

    const parsed = LinkVercelProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const input = parsed.data;
    const envKey = input.envKey || "NEXT_PUBLIC_API_URL";
    const backendUrl = backendPublicUrl(project.name, input.backendUrl);

    try {
      const vercelProject = await getVercelProject(
        creds.token,
        input.vercelProjectId,
        creds.teamId,
      );

      await upsertVercelEnvVars(
        creds.token,
        vercelProject.id,
        creds.teamId,
        [
          { key: envKey, value: backendUrl },
          { key: "DOCKYARD_BACKEND_URL", value: backendUrl },
          { key: "DOCKYARD_PROJECT", value: project.name },
        ],
      );

      let redeploy: {
        ok: boolean;
        deploymentUrl: string | null;
        error?: string;
      } = { ok: false, deploymentUrl: null };
      if (input.redeploy) {
        redeploy = await redeployVercelProject(
          creds.token,
          vercelProject.id,
          vercelProject.name,
          creds.teamId,
        );
      }

      const projectUrl = await resolveVercelProjectUrl(
        creds.token,
        vercelProject.id,
        vercelProject.name,
        creds.teamId,
      );

      const { rows } = await query(
        `UPDATE projects SET
           vercel_project_id = $2,
           vercel_project_name = $3,
           vercel_project_url = $4,
           vercel_env_key = $5,
           vercel_linked_at = NOW(),
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, vercelProject.id, vercelProject.name, projectUrl, envKey],
      );

      return {
        project: mapProject(rows[0]),
        backendUrl,
        envKey,
        vercel: {
          projectId: vercelProject.id,
          projectName: vercelProject.name,
          url: projectUrl,
          dashboardUrl: vercelDashboardUrl(vercelProject.name),
        },
        redeploy,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete("/api/projects/:id/vercel/link", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getOwnedProject(authOf(request), id);
    if (!project) return reply.code(404).send({ error: "Not found" });
    const { rows } = await query(
      `UPDATE projects SET
         vercel_project_id = NULL,
         vercel_project_name = NULL,
         vercel_project_url = NULL,
         vercel_env_key = NULL,
         vercel_linked_at = NULL,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return { project: mapProject(rows[0]) };
  });

  app.get("/api/projects", async (request) => {
    const auth = authOf(request);
    const filter = ownerFilter(auth);
    const { rows } = filter.params.length
      ? await query(
          `SELECT * FROM projects WHERE owner_id = $1 ORDER BY created_at DESC`,
          filter.params,
        )
      : await query(`SELECT * FROM projects ORDER BY created_at DESC`);
    return { projects: rows.map(mapProject) };
  });

  app.post("/api/projects", async (request, reply) => {
    const auth = authOf(request);
    const parsed = CreateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const input = parsed.data;
    await ensurePlatformUser();
    const ownerId = connectionOwnerId(auth);

    if (auth.kind === "user") {
      const plan = PLANS[auth.user.plan];
      const count = await query(
        `SELECT COUNT(*)::int AS c FROM projects WHERE owner_id = $1`,
        [auth.user.id],
      );
      if ((count.rows[0]?.c as number) >= plan.maxProjects) {
        return reply.code(403).send({
          error: `Your ${plan.name} plan allows ${plan.maxProjects} projects. Upgrade to Pro for more.`,
        });
      }
    }

    const hostname = slugHostname(input.name, config.publicHost);
    const planId =
      auth.kind === "user" ? auth.user.plan : ("pro" as PlanId);
    const planDefaults = PLANS[planId];
    const { memory, cpu } = clampResourcesToPlan(
      planId,
      input.memoryLimitBytes ?? planDefaults.defaultMemoryBytes,
      input.cpuNanoCpus ?? planDefaults.defaultCpuNano,
    );
    const repoUrl = input.repoUrl || "";

    try {
      const { rows } = await query(
        `INSERT INTO projects (
          owner_id, name, repo_url, branch, dockerfile_path, build_context, port, env,
          hostname, memory_limit_bytes, cpu_nano_cpus, auto_deploy, service_role, start_command
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)
        RETURNING *`,
        [
          ownerId,
          input.name,
          repoUrl,
          input.branch,
          input.dockerfilePath,
          input.buildContext,
          input.port,
          JSON.stringify(input.env),
          hostname,
          memory,
          cpu,
          input.autoDeploy,
          input.serviceRole ?? "full",
          input.startCommand ?? null,
        ],
      );
      const project = mapProject(rows[0]);
      await enqueueJob("update_proxy", {});

      let deploy = null;
      if (input.deployNow && repoUrl) {
        deploy = await enqueueDeploy(project.id, { triggeredBy: "manual" });
      }

      return reply.code(201).send({ project, deploy });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("unique") || message.includes("duplicate")) {
        return reply.code(409).send({ error: "Project name already exists" });
      }
      throw err;
    }
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const project = await getOwnedProject(authOf(request), (request.params as { id: string }).id);
    if (!project) return reply.code(404).send({ error: "Not found" });
    return { project };
  });

  app.patch("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const auth = authOf(request);
    const cur = await getOwnedProject(auth, id);
    if (!cur) return reply.code(404).send({ error: "Not found" });
    const p = parsed.data;
    const planId: PlanId =
      auth.kind === "user" ? auth.user.plan : "pro";
    const { memory, cpu } = clampResourcesToPlan(
      planId,
      p.memoryLimitBytes ?? cur.memoryLimitBytes,
      p.cpuNanoCpus ?? cur.cpuNanoCpus,
    );
    const { rows } = await query(
      `UPDATE projects SET
        repo_url = $2,
        branch = $3,
        dockerfile_path = $4,
        build_context = $5,
        port = $6,
        env = $7::jsonb,
        memory_limit_bytes = $8,
        cpu_nano_cpus = $9,
        auto_deploy = $10,
        service_role = $11,
        start_command = $12,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [
        id,
        p.repoUrl ?? cur.repoUrl,
        p.branch ?? cur.branch,
        p.dockerfilePath ?? cur.dockerfilePath,
        p.buildContext ?? cur.buildContext,
        p.port ?? cur.port,
        JSON.stringify(p.env ?? cur.env),
        memory,
        cpu,
        p.autoDeploy ?? cur.autoDeploy,
        p.serviceRole ?? cur.serviceRole,
        p.startCommand !== undefined ? p.startCommand : cur.startCommand,
      ],
    );
    return { project: mapProject(rows[0]) };
  });

  app.post("/api/projects/:id/analyze", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = authOf(request);
    const project = await getOwnedProject(auth, id);
    if (!project) return reply.code(404).send({ error: "Not found" });
    const body = z
      .object({
        apply: z.boolean().optional(),
        serviceRole: z.enum(["web", "api", "worker", "full"]).optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    const repoUrl = project.repoUrl;
    if (!repoUrl) {
      return reply.code(400).send({ error: "Add a GitHub repo URL before analyzing" });
    }

    const userId = connectionOwnerId(auth);
    let token = await getUserGitHubToken(userId);
    if (!token && config.githubToken && auth.kind === "admin") {
      token = config.githubToken;
    }
    if (!token) {
      return reply
        .code(401)
        .send({ error: "Connect GitHub to analyze this repository" });
    }

    try {
      const octokit = await createOctokit(token);
      if (!octokit) throw new Error("GitHub client unavailable");
      const analysis = await analyzeRepository(
        octokit,
        repoUrl,
        project.branch,
        body.data.serviceRole ?? project.serviceRole,
      );

      if (!body.data.apply) {
        return { analysis };
      }

      const mergedEnv = {
        ...analysis.suggestedEnv,
        ...project.env,
      };
      const { rows } = await query(
        `UPDATE projects SET
          dockerfile_path = $2,
          build_context = $3,
          port = $4,
          service_role = $5,
          start_command = $6,
          env = $7::jsonb,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
        [
          id,
          analysis.dockerfilePath,
          analysis.buildContext,
          analysis.port,
          analysis.serviceRole,
          analysis.startCommand,
          JSON.stringify(mergedEnv),
        ],
      );
      return { analysis, project: mapProject(rows[0]) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `Analyze failed: ${message}` });
    }
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getOwnedProject(authOf(request), id);
    if (!project) return reply.code(404).send({ error: "Not found" });

    await enqueueJob("stop", {
      projectId: id,
      containerName: `paas-app-${project.name}`,
      destroy: true,
    });

    await query(`DELETE FROM projects WHERE id = $1`, [id]);
    await enqueueJob("update_proxy", {});
    return { ok: true };
  });

  app.post("/api/projects/:id/deploy", async (request, reply) => {
    if (!enforceRateLimit(request, reply, "deploy", 30, 10 * 60_000)) return;
    const { id } = request.params as { id: string };
    const parsed = TriggerDeploySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const project = await getOwnedProject(authOf(request), id);
    if (!project) return reply.code(404).send({ error: "Not found" });
    if (!project.repoUrl) {
      return reply.code(400).send({ error: "Add a GitHub repo URL before deploying" });
    }

    if (project.status === "deploying") {
      const active = await query(
        `SELECT id FROM deploys WHERE project_id = $1 AND status IN ('queued','building','deploying') LIMIT 1`,
        [id],
      );
      if (active.rows[0]) {
        return reply
          .code(409)
          .send({ error: "A deploy is already in progress for this project" });
      }
    }

    if (parsed.data.triggeredBy === "redeploy" && !project.previousImageTag) {
      return reply.code(400).send({ error: "No previous image to redeploy" });
    }

    const deploy = await enqueueDeploy(id, {
      commitSha: parsed.data.commitSha ?? null,
      triggeredBy: parsed.data.triggeredBy,
      redeploy: parsed.data.triggeredBy === "redeploy",
    });
    return reply.code(202).send({ deploy });
  });

  app.post("/api/projects/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getOwnedProject(authOf(request), id);
    if (!project) return reply.code(404).send({ error: "Not found" });
    await enqueueJob("stop", { projectId: id });
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/projects/:id/restart", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getOwnedProject(authOf(request), id);
    if (!project) return reply.code(404).send({ error: "Not found" });
    await enqueueJob("restart", { projectId: id });
    return reply.code(202).send({ ok: true });
  });

  app.get("/api/projects/:id/deploys", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getOwnedProject(authOf(request), id);
    if (!project) return reply.code(404).send({ error: "Not found" });
    const { rows } = await query(
      `SELECT * FROM deploys WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id],
    );
    return { deploys: rows.map(mapDeploy) };
  });

  app.get("/api/deploys/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { rows } = await query(`SELECT * FROM deploys WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    const deploy = mapDeploy(rows[0]);
    const project = await getOwnedProject(authOf(request), deploy.projectId);
    if (!project) return reply.code(404).send({ error: "Not found" });
    return { deploy };
  });

  app.get("/api/projects/:id/logs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getOwnedProject(authOf(request), id);
    if (!project) return reply.code(404).send({ error: "Not found" });
    try {
      const docker = getDocker();
      const logs = await containerLogs(
        docker,
        project.containerId ?? `paas-app-${project.name}`,
        300,
      );
      return { logs };
    } catch (err) {
      return {
        logs: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.get("/api/databases", async (request) => {
    const auth = authOf(request);
    const filter = ownerFilter(auth);
    const { rows } = filter.params.length
      ? await query(
          `SELECT * FROM databases WHERE owner_id = $1 ORDER BY created_at DESC`,
          filter.params,
        )
      : await query(`SELECT * FROM databases ORDER BY created_at DESC`);
    return { databases: rows.map(mapDatabase) };
  });

  app.get("/api/usage", async (request) => {
    const auth = authOf(request);
    const plan =
      auth.kind === "user" ? PLANS[auth.user.plan] : PLANS.pro;
    const ownerId = currentUserId(auth);

    const projectQ = ownerId
      ? await query(
          `SELECT COUNT(*)::int AS c,
                  COALESCE(SUM(memory_limit_bytes),0)::bigint AS mem,
                  COALESCE(SUM(cpu_nano_cpus),0)::bigint AS cpu,
                  COUNT(*) FILTER (WHERE status = 'running')::int AS running
           FROM projects WHERE owner_id = $1`,
          [ownerId],
        )
      : await query(
          `SELECT COUNT(*)::int AS c,
                  COALESCE(SUM(memory_limit_bytes),0)::bigint AS mem,
                  COALESCE(SUM(cpu_nano_cpus),0)::bigint AS cpu,
                  COUNT(*) FILTER (WHERE status = 'running')::int AS running
           FROM projects`,
        );

    const dbQ = ownerId
      ? await query(
          `SELECT COUNT(*)::int AS c FROM databases WHERE owner_id = $1`,
          [ownerId],
        )
      : await query(`SELECT COUNT(*)::int AS c FROM databases`);

    const deployQ = ownerId
      ? await query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE d.status = 'failed')::int AS failed
           FROM deploys d
           JOIN projects p ON p.id = d.project_id
           WHERE p.owner_id = $1 AND d.created_at > NOW() - INTERVAL '24 hours'`,
          [ownerId],
        )
      : await query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM deploys WHERE created_at > NOW() - INTERVAL '24 hours'`,
        );

    const recentQ = ownerId
      ? await query(
          `SELECT d.id, p.name AS project_name, d.status, d.triggered_by, d.created_at
           FROM deploys d
           JOIN projects p ON p.id = d.project_id
           WHERE p.owner_id = $1
           ORDER BY d.created_at DESC LIMIT 12`,
          [ownerId],
        )
      : await query(
          `SELECT d.id, p.name AS project_name, d.status, d.triggered_by, d.created_at
           FROM deploys d
           JOIN projects p ON p.id = d.project_id
           ORDER BY d.created_at DESC LIMIT 12`,
        );

    const usage: UsageSummary = {
      plan,
      projectsUsed: Number(projectQ.rows[0]?.c ?? 0),
      projectsLimit: plan.maxProjects,
      databasesUsed: Number(dbQ.rows[0]?.c ?? 0),
      databasesLimit: plan.maxDatabases,
      reservedMemoryBytes: Number(projectQ.rows[0]?.mem ?? 0),
      reservedCpuNano: Number(projectQ.rows[0]?.cpu ?? 0),
      runningServices: Number(projectQ.rows[0]?.running ?? 0),
      deploysLast24h: Number(deployQ.rows[0]?.total ?? 0),
      failedDeploysLast24h: Number(deployQ.rows[0]?.failed ?? 0),
      recentDeploys: recentQ.rows.map((r) => ({
        id: r.id as string,
        projectName: r.project_name as string,
        status: r.status as UsageSummary["recentDeploys"][number]["status"],
        triggeredBy: r.triggered_by as string,
        createdAt: (r.created_at as Date).toISOString(),
      })),
    };
    return { usage };
  });

  /**
   * Docker's stats endpoint costs ~100-300ms per call and the project page polls
   * it every few seconds. Two browser tabs on the same project used to mean two
   * full round trips to the daemon per tick; a short TTL collapses them.
   */
  const metricsCache = new Map<
    string,
    { at: number; value: Promise<ResourceMetrics> }
  >();
  const METRICS_TTL_MS = Number(process.env.METRICS_CACHE_MS ?? 2000);

  async function metricsForContainer(
    containerId: string | null,
    fallbackName: string,
  ): Promise<ResourceMetrics> {
    const key = containerId ?? fallbackName;
    const hit = metricsCache.get(key);
    if (hit && Date.now() - hit.at < METRICS_TTL_MS) return hit.value;

    const value = sampleContainerMetrics(containerId, fallbackName);
    metricsCache.set(key, { at: Date.now(), value });
    if (metricsCache.size > 200) {
      for (const [k, v] of metricsCache) {
        if (Date.now() - v.at > METRICS_TTL_MS * 5) metricsCache.delete(k);
      }
    }
    return value;
  }

  async function sampleContainerMetrics(
    containerId: string | null,
    fallbackName: string,
  ): Promise<ResourceMetrics> {
    const sampledAt = new Date().toISOString();
    try {
      const docker = getDocker();
      const stats = await containerStats(
        docker,
        containerId ?? fallbackName,
      );
      return {
        available: true,
        cpuPercent: stats.cpuPercent,
        memoryUsedBytes: stats.memoryUsedBytes,
        memoryLimitBytes: stats.memoryLimitBytes,
        memoryPercent: stats.memoryPercent,
        netRxBytes: stats.netRxBytes,
        netTxBytes: stats.netTxBytes,
        blockReadBytes: stats.blockReadBytes,
        blockWriteBytes: stats.blockWriteBytes,
        sampledAt,
      };
    } catch {
      return {
        available: false,
        cpuPercent: null,
        memoryUsedBytes: null,
        memoryLimitBytes: null,
        memoryPercent: null,
        netRxBytes: null,
        netTxBytes: null,
        blockReadBytes: null,
        blockWriteBytes: null,
        sampledAt,
      };
    }
  }

  app.get("/api/projects/:id/metrics", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getOwnedProject(authOf(request), id);
    if (!project) return reply.code(404).send({ error: "Not found" });
    const metrics = await metricsForContainer(
      project.containerId,
      `paas-app-${project.name}`,
    );
    return {
      metrics,
      limits: {
        memoryLimitBytes: project.memoryLimitBytes,
        cpuNanoCpus: project.cpuNanoCpus,
      },
    };
  });

  app.get("/api/databases/:id/metrics", async (request, reply) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const filter = ownerFilter(auth);
    const { rows } = filter.params.length
      ? await query(`SELECT * FROM databases WHERE id = $2 AND owner_id = $1`, [
          filter.params[0],
          id,
        ])
      : await query(`SELECT * FROM databases WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    const db = mapDatabase(rows[0]);
    const metrics = await metricsForContainer(
      db.containerId,
      `paas-db-${db.name}`,
    );
    return { metrics, database: db };
  });

  app.post("/api/databases", async (request, reply) => {
    const auth = authOf(request);
    const parsed = CreateDatabaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const input = parsed.data;
    const ownerId = currentUserId(auth);
    const preset = DATABASE_PRESETS[input.kind];
    const version = input.version ?? preset.defaultVersion;
    const memoryMb = input.memoryMb ?? preset.defaultMemoryMb;
    const cpu = input.cpu ?? preset.defaultCpu;

    if (auth.kind === "user") {
      const plan = PLANS[auth.user.plan];
      const count = await query(
        `SELECT COUNT(*)::int AS c FROM databases WHERE owner_id = $1`,
        [auth.user.id],
      );
      if ((count.rows[0]?.c as number) >= plan.maxDatabases) {
        return reply.code(403).send({
          error: `Your ${plan.name} plan allows ${plan.maxDatabases} databases.`,
        });
      }
    }

    if (input.projectId) {
      const project = await getOwnedProject(auth, input.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
    }

    const password = randomBytes(18).toString("base64url");
    const volumeName = `paas-db-${input.name}-data`;
    const { connectionUrl, injectEnv } = buildDatabaseConnectionUrl({
      kind: input.kind,
      name: input.name,
      password,
      version,
    });
    const dbConfig = {
      version,
      memoryMb,
      cpu,
      image: databaseImage(input.kind, version),
      volumePath: preset.volumePath,
      port: preset.port,
      engine: preset.engine,
    };

    try {
      const { rows } = await query(
        `INSERT INTO databases (owner_id, name, kind, project_id, volume_name, connection_url, status, config)
         VALUES ($1, $2, $3, $4, $5, $6, 'provisioning', $7::jsonb)
         RETURNING *`,
        [
          ownerId,
          input.name,
          input.kind,
          input.projectId ?? null,
          volumeName,
          connectionUrl,
          JSON.stringify(dbConfig),
        ],
      );
      const database = mapDatabase(rows[0]);
      await enqueueJob("provision_database", {
        databaseId: database.id,
        password,
      });

      let redeployQueued = false;
      if (input.projectId) {
        const project = await getOwnedProject(auth, input.projectId);
        if (project) {
          const env = { ...project.env, ...injectEnv };
          await query(
            `UPDATE projects SET env = $2::jsonb, updated_at = NOW() WHERE id = $1`,
            [input.projectId, JSON.stringify(env)],
          );
          if (project.imageTag || project.status === "running") {
            await enqueueDeploy(input.projectId, {
              triggeredBy: "manual",
            });
            redeployQueued = true;
          }
        }
      }

      return reply.code(201).send({ database, redeployQueued });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("unique") || message.includes("duplicate")) {
        return reply.code(409).send({ error: "Database name already exists" });
      }
      throw err;
    }
  });

  const LinkDatabaseSchema = z.object({
    projectId: z.string().uuid().nullable(),
  });

  app.post("/api/databases/:id/link", async (request, reply) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const parsed = LinkDatabaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const filter = ownerFilter(auth);
    const { rows } = filter.params.length
      ? await query(`SELECT * FROM databases WHERE id = $2 AND owner_id = $1`, [
          filter.params[0],
          id,
        ])
      : await query(`SELECT * FROM databases WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    const db = mapDatabase(rows[0]);

    await query(`UPDATE databases SET project_id = $2 WHERE id = $1`, [
      id,
      parsed.data.projectId,
    ]);

    if (parsed.data.projectId) {
      const project = await getOwnedProject(auth, parsed.data.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const env = { ...project.env };
      const preset = DATABASE_PRESETS[db.kind];
      if (preset) {
        if (db.kind === "mongodb") {
          env.MONGO_URL = db.connectionUrl;
          env.MONGODB_URI = db.connectionUrl;
        } else if (db.kind === "minio") {
          env.S3_ENDPOINT = db.connectionUrl;
        } else if (db.kind === "redis") {
          env.REDIS_URL = db.connectionUrl;
        } else {
          env.DATABASE_URL = db.connectionUrl;
          // Railway/Flask apps often expect MYSQL* (not only DATABASE_URL).
          try {
            const u = new URL(db.connectionUrl);
            if (u.protocol.startsWith("mysql")) {
              env.MYSQLHOST = u.hostname;
              env.MYSQLPORT = u.port || "3306";
              env.MYSQLUSER = decodeURIComponent(u.username || "root");
              env.MYSQLPASSWORD = decodeURIComponent(u.password || "");
              env.MYSQLDATABASE = decodeURIComponent(
                (u.pathname || "/").replace(/^\//, "") || "railway",
              );
              env.DB_HOST = env.MYSQLHOST;
              env.DB_PORT = env.MYSQLPORT;
              env.DB_USER = env.MYSQLUSER;
              env.DB_PASSWORD = env.MYSQLPASSWORD;
              env.DB_NAME = env.MYSQLDATABASE;
            }
          } catch {
            /* keep DATABASE_URL only */
          }
        }
      }
      await query(
        `UPDATE projects SET env = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [parsed.data.projectId, JSON.stringify(env)],
      );
      await enqueueJob("provision_database", {
        databaseId: db.id,
        password: "",
        relinkOnly: true,
      });
      const deploy = await enqueueDeploy(parsed.data.projectId, {
        triggeredBy: "manual",
      });
      return { ok: true, deploy };
    }

    // Disconnect: clear injected connection vars from the previously linked project
    if (db.projectId) {
      const project = await getOwnedProject(auth, db.projectId);
      if (project) {
        const env = { ...project.env };
        delete env.DATABASE_URL;
        delete env.REDIS_URL;
        delete env.MONGO_URL;
        delete env.MONGODB_URI;
        delete env.S3_ENDPOINT;
        delete env.MYSQLHOST;
        delete env.MYSQLPORT;
        delete env.MYSQLUSER;
        delete env.MYSQLPASSWORD;
        delete env.MYSQLDATABASE;
        delete env.DB_HOST;
        delete env.DB_PORT;
        delete env.DB_USER;
        delete env.DB_PASSWORD;
        delete env.DB_NAME;
        await query(
          `UPDATE projects SET env = $2::jsonb, updated_at = NOW() WHERE id = $1`,
          [db.projectId, JSON.stringify(env)],
        );
      }
    }

    return { ok: true };
  });

  app.delete("/api/databases/:id", async (request, reply) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const filter = ownerFilter(auth);
    const { rows } = filter.params.length
      ? await query(`SELECT * FROM databases WHERE id = $2 AND owner_id = $1`, [
          filter.params[0],
          id,
        ])
      : await query(`SELECT * FROM databases WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    const db = mapDatabase(rows[0]);
    await query(`DELETE FROM databases WHERE id = $1`, [id]);
    await enqueueJob("stop", {
      containerName: `paas-db-${db.name}`,
      volumeName: db.volumeName,
      destroy: true,
    });
    return { ok: true };
  });

  app.post("/api/webhooks/github", async (request, reply) => {
    if (!enforceRateLimit(request, reply, "webhook", 120, 60_000)) return;
    const raw =
      (request as { rawBody?: string }).rawBody ??
      JSON.stringify(request.body ?? {});
    const signature = request.headers["x-hub-signature-256"] as
      | string
      | undefined;

    if (!config.githubWebhookSecret) {
      if (!config.allowInsecureWebhooks) {
        return reply.code(503).send({
          error:
            "GITHUB_WEBHOOK_SECRET is not configured. Set it, or ALLOW_INSECURE_WEBHOOKS=true for local testing only.",
        });
      }
    } else if (!verifyGitHubSignature(raw, signature)) {
      return reply.code(401).send({ error: "Invalid signature" });
    }

    const event = request.headers["x-github-event"];
    if (event === "ping") {
      return { ok: true, pong: true };
    }
    if (event !== "push") {
      return { ok: true, ignored: true };
    }

    const body = request.body as {
      ref?: string;
      after?: string;
      repository?: { clone_url?: string; html_url?: string; full_name?: string };
    };

    const branch = body.ref?.replace(/^refs\/heads\//, "");
    const sha = body.after;
    const cloneUrl =
      body.repository?.clone_url ??
      (body.repository?.html_url ? `${body.repository.html_url}.git` : null);
    if (
      !branch ||
      !sha ||
      !cloneUrl ||
      sha === "0000000000000000000000000000000000000000"
    ) {
      return { ok: true, ignored: true };
    }

    const parsedRepo = parseRepo(cloneUrl);
    const { rows } = await query(`SELECT * FROM projects WHERE auto_deploy = TRUE`);
    const matches = rows.map(mapProject).filter((p) => {
      if (!p.repoUrl) return false;
      if (p.branch !== branch) return false;
      const a = parseRepo(p.repoUrl);
      if (parsedRepo && a) {
        return (
          a.owner.toLowerCase() === parsedRepo.owner.toLowerCase() &&
          a.repo.toLowerCase() === parsedRepo.repo.toLowerCase()
        );
      }
      return (
        p.repoUrl.replace(/\.git$/, "") === cloneUrl.replace(/\.git$/, "") ||
        p.repoUrl.includes(body.repository?.full_name ?? "___")
      );
    });

    const deploys = [];
    for (const project of matches) {
      if (project.status === "deploying") {
        const active = await query(
          `SELECT id FROM deploys WHERE project_id = $1 AND status IN ('queued','building','deploying') LIMIT 1`,
          [project.id],
        );
        if (active.rows[0]) continue;
      }
      const deploy = await enqueueDeploy(project.id, {
        commitSha: sha,
        triggeredBy: "webhook",
      });
      deploys.push(deploy);
    }

    return { ok: true, matched: matches.length, deploys };
  });

  await registerAdminRoutes(app);
}
