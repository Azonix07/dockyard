import type { FastifyInstance } from "fastify";
import {
  PLANS,
  UpdateAdminAccountSchema,
  type AdminAccount,
  type AdminDatabaseRow,
  type AdminHostInfo,
  type AdminOverview,
  type AdminProjectRow,
  type DeployStatus,
  type PlanId,
  type ProjectStatus,
} from "@laptop-paas/shared";
import { getDocker } from "@laptop-paas/docker";
import { requireSuperAdmin, mapUser, PLATFORM_USER_ID } from "./auth.js";
import { config } from "./config.js";
import { query } from "./db/pool.js";
import { loadDeviceHealth, loadUserElectricityShares } from "./device-health.js";

async function loadHostInfo(): Promise<AdminHostInfo> {
  try {
    const docker = getDocker();
    const info = await docker.info();
    const containers = await docker.listContainers({ all: true });
    const paasContainers = containers.filter((c) =>
      (c.Names ?? []).some((n) => n.includes("paas-")),
    ).length;
    return {
      available: true,
      name: (info.Name as string) ?? null,
      dockerVersion: (info.ServerVersion as string) ?? null,
      ncpu: typeof info.NCPU === "number" ? info.NCPU : null,
      memTotalBytes:
        typeof info.MemTotal === "number" ? info.MemTotal : null,
      containers: typeof info.Containers === "number" ? info.Containers : null,
      containersRunning:
        typeof info.ContainersRunning === "number"
          ? info.ContainersRunning
          : null,
      containersPaused:
        typeof info.ContainersPaused === "number"
          ? info.ContainersPaused
          : null,
      containersStopped:
        typeof info.ContainersStopped === "number"
          ? info.ContainersStopped
          : null,
      images: typeof info.Images === "number" ? info.Images : null,
      driver: (info.Driver as string) ?? null,
      operatingSystem: (info.OperatingSystem as string) ?? null,
      architecture: (info.Architecture as string) ?? null,
      paasContainers,
    };
  } catch {
    return {
      available: false,
      name: null,
      dockerVersion: null,
      ncpu: null,
      memTotalBytes: null,
      containers: null,
      containersRunning: null,
      containersPaused: null,
      containersStopped: null,
      images: null,
      driver: null,
      operatingSystem: null,
      architecture: null,
      paasContainers: null,
    };
  }
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/admin")) return;
    return requireSuperAdmin(request, reply);
  });

  app.get("/api/admin/overview", async () => {
    const [
      accountsQ,
      fleetQ,
      dbQ,
      deployQ,
      jobsQ,
      recentDeploysQ,
      recentAccountsQ,
      host,
    ] = await Promise.all([
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE plan = 'hobby')::int AS hobby,
           COUNT(*) FILTER (WHERE plan = 'pro')::int AS pro,
           COUNT(*) FILTER (WHERE github_login IS NOT NULL)::int AS with_github,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS new_7d
         FROM users
         WHERE id <> $1`,
        [PLATFORM_USER_ID],
      ),
      query(
        `SELECT
           COUNT(*)::int AS projects,
           COUNT(*) FILTER (WHERE status = 'running')::int AS running,
           COUNT(*) FILTER (WHERE status = 'error')::int AS failed,
           COUNT(*) FILTER (WHERE status = 'deploying')::int AS deploying,
           COUNT(*) FILTER (WHERE status = 'idle')::int AS idle,
           COUNT(*) FILTER (WHERE status = 'stopped')::int AS stopped,
           COALESCE(SUM(memory_limit_bytes), 0)::bigint AS mem,
           COALESCE(SUM(cpu_nano_cpus), 0)::bigint AS cpu
         FROM projects`,
      ),
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'running')::int AS running
         FROM databases`,
      ),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS d24,
           COUNT(*) FILTER (
             WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'failed'
           )::int AS fail24,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS d7
         FROM deploys`,
      ),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
           COUNT(*) FILTER (WHERE status = 'running')::int AS running,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM jobs`,
      ),
      query(
        `SELECT d.id, p.name AS project_name, u.email AS owner_email,
                d.status, d.triggered_by, d.created_at, d.error
         FROM deploys d
         JOIN projects p ON p.id = d.project_id
         LEFT JOIN users u ON u.id = p.owner_id
         ORDER BY d.created_at DESC
         LIMIT 20`,
      ),
      query(
        `SELECT id, email, name, plan, created_at
         FROM users
         WHERE id <> $1
         ORDER BY created_at DESC
         LIMIT 8`,
        [PLATFORM_USER_ID],
      ),
      loadHostInfo(),
    ]);

    const a = accountsQ.rows[0] ?? {};
    const f = fleetQ.rows[0] ?? {};
    const d = dbQ.rows[0] ?? {};
    const dep = deployQ.rows[0] ?? {};
    const j = jobsQ.rows[0] ?? {};

    const overview: AdminOverview = {
      generatedAt: new Date().toISOString(),
      accounts: {
        total: Number(a.total ?? 0),
        hobby: Number(a.hobby ?? 0),
        pro: Number(a.pro ?? 0),
        withGithub: Number(a.with_github ?? 0),
        newLast7d: Number(a.new_7d ?? 0),
      },
      fleet: {
        projects: Number(f.projects ?? 0),
        running: Number(f.running ?? 0),
        failed: Number(f.failed ?? 0),
        deploying: Number(f.deploying ?? 0),
        idle: Number(f.idle ?? 0),
        stopped: Number(f.stopped ?? 0),
        databases: Number(d.total ?? 0),
        databasesRunning: Number(d.running ?? 0),
        reservedMemoryBytes: Number(f.mem ?? 0),
        reservedCpuNano: Number(f.cpu ?? 0),
      },
      activity: {
        deploysLast24h: Number(dep.d24 ?? 0),
        failedDeploysLast24h: Number(dep.fail24 ?? 0),
        deploysLast7d: Number(dep.d7 ?? 0),
        jobsQueued: Number(j.queued ?? 0),
        jobsRunning: Number(j.running ?? 0),
        jobsFailed: Number(j.failed ?? 0),
      },
      host,
      recentDeploys: recentDeploysQ.rows.map((r) => ({
        id: r.id as string,
        projectName: r.project_name as string,
        ownerEmail: (r.owner_email as string) ?? null,
        status: r.status as DeployStatus,
        triggeredBy: r.triggered_by as string,
        createdAt: (r.created_at as Date).toISOString(),
        error: (r.error as string) ?? null,
      })),
      recentAccounts: recentAccountsQ.rows.map((r) => ({
        id: r.id as string,
        email: r.email as string,
        name: r.name as string,
        plan: r.plan as PlanId,
        createdAt: (r.created_at as Date).toISOString(),
      })),
    };

    return {
      overview,
      publicHost: config.publicHost,
      webOrigin: config.webOrigin,
    };
  });

  app.get("/api/admin/accounts", async () => {
    const { rows } = await query(
      `SELECT
         u.id, u.email, u.name, u.plan, u.onboarding_completed, u.created_at,
         u.github_login,
         COUNT(DISTINCT p.id)::int AS project_count,
         COUNT(DISTINCT db.id)::int AS database_count,
         COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'running')::int AS running_projects,
         MAX(d.created_at) AS last_deploy_at
       FROM users u
       LEFT JOIN projects p ON p.owner_id = u.id
       LEFT JOIN databases db ON db.owner_id = u.id
       LEFT JOIN deploys d ON d.project_id = p.id
       WHERE u.id <> $1
       GROUP BY u.id
       ORDER BY u.created_at DESC`,
      [PLATFORM_USER_ID],
    );

    const accounts: AdminAccount[] = rows.map((r) => ({
      id: r.id as string,
      email: r.email as string,
      name: r.name as string,
      plan: r.plan as PlanId,
      onboardingCompleted: Boolean(r.onboarding_completed),
      createdAt: (r.created_at as Date).toISOString(),
      githubLogin: (r.github_login as string) ?? null,
      projectCount: Number(r.project_count ?? 0),
      databaseCount: Number(r.database_count ?? 0),
      runningProjects: Number(r.running_projects ?? 0),
      lastDeployAt: r.last_deploy_at
        ? (r.last_deploy_at as Date).toISOString()
        : null,
    }));

    return { accounts, plans: Object.values(PLANS) };
  });

  app.patch("/api/admin/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === PLATFORM_USER_ID) {
      return reply.code(400).send({ error: "Cannot modify the platform system account" });
    }
    const parsed = UpdateAdminAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { plan, onboardingCompleted } = parsed.data;
    if (plan === undefined && onboardingCompleted === undefined) {
      return reply.code(400).send({ error: "No changes" });
    }

    const { rows: existing } = await query(`SELECT * FROM users WHERE id = $1`, [
      id,
    ]);
    if (!existing[0]) return reply.code(404).send({ error: "Not found" });

    const nextPlan = plan ?? (existing[0].plan as PlanId);
    const nextOnboarding =
      onboardingCompleted ?? Boolean(existing[0].onboarding_completed);

    const { rows } = await query(
      `UPDATE users
       SET plan = $2, onboarding_completed = $3
       WHERE id = $1
       RETURNING id, email, name, plan, onboarding_completed, created_at, github_login`,
      [id, nextPlan, nextOnboarding],
    );

    const user = mapUser(rows[0] as Parameters<typeof mapUser>[0]);
    return {
      user: {
        ...user,
        githubLogin: (rows[0].github_login as string) ?? null,
      },
      plan: PLANS[user.plan],
    };
  });

  app.get("/api/admin/fleet", async () => {
    const [projectsQ, databasesQ] = await Promise.all([
      query(
        `SELECT p.id, p.name, p.status, p.hostname, p.repo_url, p.owner_id,
                u.email AS owner_email, p.memory_limit_bytes, p.cpu_nano_cpus,
                p.updated_at
         FROM projects p
         LEFT JOIN users u ON u.id = p.owner_id
         ORDER BY p.updated_at DESC`,
      ),
      query(
        `SELECT db.id, db.name, db.kind, db.status, db.owner_id, db.project_id,
                db.created_at, u.email AS owner_email, p.name AS project_name
         FROM databases db
         LEFT JOIN users u ON u.id = db.owner_id
         LEFT JOIN projects p ON p.id = db.project_id
         ORDER BY db.created_at DESC`,
      ),
    ]);

    const projects: AdminProjectRow[] = projectsQ.rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      status: r.status as ProjectStatus,
      hostname: r.hostname as string,
      repoUrl: (r.repo_url as string) ?? "",
      ownerId: (r.owner_id as string) ?? null,
      ownerEmail: (r.owner_email as string) ?? null,
      memoryLimitBytes: Number(r.memory_limit_bytes ?? 0),
      cpuNanoCpus: Number(r.cpu_nano_cpus ?? 0),
      updatedAt: (r.updated_at as Date).toISOString(),
    }));

    const databases: AdminDatabaseRow[] = databasesQ.rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as AdminDatabaseRow["kind"],
      status: r.status as string,
      ownerId: (r.owner_id as string) ?? null,
      ownerEmail: (r.owner_email as string) ?? null,
      projectId: (r.project_id as string) ?? null,
      projectName: (r.project_name as string) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
    }));

    return { projects, databases };
  });

  app.get("/api/admin/device", async () => {
    const device = loadDeviceHealth();
    const users = await loadUserElectricityShares(
      device.power.electricity.avgWatts || device.power.watts || 0,
      device.power.electricity,
    );
    return { device, users };
  });
}
