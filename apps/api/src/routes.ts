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
  buildDatabaseConnectionUrl,
  databaseImage,
  slugHostname,
  type PlanId,
  type ResourceMetrics,
  type UsageSummary,
} from "@laptop-paas/shared";
import {
  createSession,
  currentUserId,
  destroySession,
  hashPassword,
  mapUser,
  ownerFilter,
  requireAuth,
  verifyPassword,
  type AuthContext,
} from "./auth.js";
import { config } from "./config.js";
import { query } from "./db/pool.js";
import { mapDatabase, mapDeploy, mapProject } from "./db/mappers.js";
import { enqueueJob } from "./jobs.js";
import { parseRepo, verifyGitHubSignature } from "./github.js";
import { containerLogs, containerStats, createDocker } from "@laptop-paas/docker";
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
  app.get("/api/health", async () => ({
    ok: true,
    service: "laptop-paas-api",
    publicHost: config.publicHost,
  }));

  app.get("/api/plans", async () => ({ plans: Object.values(PLANS) }));

  app.get("/api/database-presets", async () => ({
    presets: Object.values(DATABASE_PRESETS),
  }));

  app.post("/api/auth/signup", async (request, reply) => {
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
      "/api/plans",
      "/api/database-presets",
      "/api/auth/signup",
      "/api/auth/login",
      "/api/auth/logout",
      "/api/webhooks/github",
    ]);
    if (publicPaths.has(path) || path.startsWith("/api/webhooks/")) {
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
          email: "admin@dockyard.local",
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
      return { user: { id: "admin", email: "admin@dockyard.local", name: "Admin", plan: parsed.data.plan, onboardingCompleted: true, createdAt: new Date(0).toISOString() }, plan: PLANS[parsed.data.plan] };
    }
    const { rows } = await query(
      `UPDATE users SET plan = $2, onboarding_completed = TRUE WHERE id = $1
       RETURNING id, email, name, plan, onboarding_completed, created_at`,
      [auth.user.id, parsed.data.plan],
    );
    const user = mapUser(rows[0] as Parameters<typeof mapUser>[0]);
    return { user, plan: PLANS[user.plan] };
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
    const ownerId = currentUserId(auth);

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
    const planDefaults =
      auth.kind === "user" ? PLANS[auth.user.plan] : PLANS.pro;
    const memory = input.memoryLimitBytes ?? planDefaults.defaultMemoryBytes;
    const cpu = input.cpuNanoCpus ?? planDefaults.defaultCpuNano;
    const repoUrl = input.repoUrl || "";

    try {
      const { rows } = await query(
        `INSERT INTO projects (
          owner_id, name, repo_url, branch, dockerfile_path, build_context, port, env,
          hostname, memory_limit_bytes, cpu_nano_cpus, auto_deploy
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
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
    const cur = await getOwnedProject(authOf(request), id);
    if (!cur) return reply.code(404).send({ error: "Not found" });
    const p = parsed.data;
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
        p.memoryLimitBytes ?? cur.memoryLimitBytes,
        p.cpuNanoCpus ?? cur.cpuNanoCpus,
        p.autoDeploy ?? cur.autoDeploy,
      ],
    );
    return { project: mapProject(rows[0]) };
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
      const docker = createDocker();
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

  async function metricsForContainer(
    containerId: string | null,
    fallbackName: string,
  ): Promise<ResourceMetrics> {
    const sampledAt = new Date().toISOString();
    try {
      const docker = createDocker();
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
}
