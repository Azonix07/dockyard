import type { FastifyInstance } from "fastify";
import {
  CreateDatabaseSchema,
  CreateProjectSchema,
  TriggerDeploySchema,
  UpdateProjectSchema,
  slugHostname,
} from "@laptop-paas/shared";
import { requireAdmin } from "./auth.js";
import { config } from "./config.js";
import { query } from "./db/pool.js";
import { mapDatabase, mapDeploy, mapProject } from "./db/mappers.js";
import { enqueueJob } from "./jobs.js";
import { parseRepo, verifyGitHubSignature } from "./github.js";
import { createDocker, containerLogs } from "@laptop-paas/docker";
import { randomBytes } from "node:crypto";
import { z } from "zod";

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

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (
      path === "/api/health" ||
      path === "/api/webhooks/github" ||
      path.startsWith("/api/webhooks/")
    ) {
      return;
    }
    if (path.startsWith("/api/")) {
      return requireAdmin(request, reply);
    }
  });

  app.get("/api/projects", async () => {
    const { rows } = await query(`SELECT * FROM projects ORDER BY created_at DESC`);
    return { projects: rows.map(mapProject) };
  });

  app.post("/api/projects", async (request, reply) => {
    const parsed = CreateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const input = parsed.data;
    const hostname = slugHostname(input.name, config.publicHost);
    const memory = input.memoryLimitBytes ?? config.defaultMemory;
    const cpu = input.cpuNanoCpus ?? config.defaultCpu;
    try {
      const { rows } = await query(
        `INSERT INTO projects (
          name, repo_url, branch, dockerfile_path, build_context, port, env,
          hostname, memory_limit_bytes, cpu_nano_cpus, auto_deploy
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
        RETURNING *`,
        [
          input.name,
          input.repoUrl,
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
      return reply.code(201).send({ project });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("unique") || message.includes("duplicate")) {
        return reply.code(409).send({ error: "Project name already exists" });
      }
      throw err;
    }
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { rows } = await query(`SELECT * FROM projects WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    return { project: mapProject(rows[0]) };
  });

  app.patch("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const existing = await query(`SELECT * FROM projects WHERE id = $1`, [id]);
    if (!existing.rows[0]) return reply.code(404).send({ error: "Not found" });
    const cur = mapProject(existing.rows[0]);
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
    const existing = await query(`SELECT * FROM projects WHERE id = $1`, [id]);
    if (!existing.rows[0]) return reply.code(404).send({ error: "Not found" });
    const project = mapProject(existing.rows[0]);

    // Destroy container BEFORE deleting the row
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
    const { rows: projects } = await query(`SELECT * FROM projects WHERE id = $1`, [
      id,
    ]);
    if (!projects[0]) return reply.code(404).send({ error: "Not found" });
    const project = mapProject(projects[0]);

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
    const { rows } = await query(`SELECT * FROM projects WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    await enqueueJob("stop", { projectId: id });
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/projects/:id/restart", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { rows } = await query(`SELECT * FROM projects WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    await enqueueJob("restart", { projectId: id });
    return reply.code(202).send({ ok: true });
  });

  app.get("/api/projects/:id/deploys", async (request, reply) => {
    const { id } = request.params as { id: string };
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
    return { deploy: mapDeploy(rows[0]) };
  });

  app.get("/api/projects/:id/logs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { rows } = await query(`SELECT * FROM projects WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    const project = mapProject(rows[0]);
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

  app.get("/api/databases", async () => {
    const { rows } = await query(`SELECT * FROM databases ORDER BY created_at DESC`);
    return { databases: rows.map(mapDatabase) };
  });

  app.post("/api/databases", async (request, reply) => {
    const parsed = CreateDatabaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const input = parsed.data;
    const password = randomBytes(18).toString("base64url");
    const volumeName = `paas-db-${input.name}-data`;
    const connectionUrl =
      input.kind === "postgres"
        ? `postgres://paas:${password}@paas-db-${input.name}:5432/paas`
        : `redis://:${password}@paas-db-${input.name}:6379`;

    try {
      const { rows } = await query(
        `INSERT INTO databases (name, kind, project_id, volume_name, connection_url, status)
         VALUES ($1, $2, $3, $4, $5, 'provisioning')
         RETURNING *`,
        [
          input.name,
          input.kind,
          input.projectId ?? null,
          volumeName,
          connectionUrl,
        ],
      );
      const database = mapDatabase(rows[0]);
      await enqueueJob("provision_database", {
        databaseId: database.id,
        password,
      });

      let redeployQueued = false;
      if (input.projectId) {
        const proj = await query(`SELECT * FROM projects WHERE id = $1`, [
          input.projectId,
        ]);
        if (proj.rows[0]) {
          const project = mapProject(proj.rows[0]);
          const env = { ...project.env };
          if (input.kind === "postgres") env.DATABASE_URL = connectionUrl;
          if (input.kind === "redis") env.REDIS_URL = connectionUrl;
          await query(
            `UPDATE projects SET env = $2::jsonb, updated_at = NOW() WHERE id = $1`,
            [input.projectId, JSON.stringify(env)],
          );
          // Redeploy so the running container picks up new env
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
    const { id } = request.params as { id: string };
    const parsed = LinkDatabaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { rows } = await query(`SELECT * FROM databases WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Not found" });
    const db = mapDatabase(rows[0]);

    await query(`UPDATE databases SET project_id = $2 WHERE id = $1`, [
      id,
      parsed.data.projectId,
    ]);

    if (parsed.data.projectId) {
      const proj = await query(`SELECT * FROM projects WHERE id = $1`, [
        parsed.data.projectId,
      ]);
      if (!proj.rows[0]) return reply.code(404).send({ error: "Project not found" });
      const project = mapProject(proj.rows[0]);
      const env = { ...project.env };
      if (db.kind === "postgres") env.DATABASE_URL = db.connectionUrl;
      if (db.kind === "redis") env.REDIS_URL = db.connectionUrl;
      await query(
        `UPDATE projects SET env = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [parsed.data.projectId, JSON.stringify(env)],
      );
      await enqueueJob("provision_database", {
        databaseId: db.id,
        password: "", // already running; worker will reconnect network if needed
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
    const { id } = request.params as { id: string };
    const { rows } = await query(`SELECT * FROM databases WHERE id = $1`, [id]);
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
        // Skip overlapping webhook deploys; still record intent via newest only
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
