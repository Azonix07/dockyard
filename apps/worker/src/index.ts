import "dotenv/config";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, relative, isAbsolute, resolve, sep } from "node:path";
import pg from "pg";
import { simpleGit } from "simple-git";
import {
  buildImage,
  containerExists,
  containerLogs,
  createDocker,
  ensureNetwork,
  ensureVolume,
  imageExists,
  pruneDanglingImages,
  pullImage,
  reloadCaddyFromFile,
  removeContainerIfExists,
  removeVolumeIfExists,
  renameContainer,
  runContainer,
  startContainer,
  stopContainer,
  waitForContainerReady,
  writeCaddyfile,
} from "@laptop-paas/docker";
import { generatedNodeDockerfile } from "@laptop-paas/shared";
import { createAppAuth } from "@octokit/auth-app";
import { openSecret } from "./secret-box.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const config = {
  dataDir: process.env.DATA_DIR ?? "/var/lib/laptop-paas",
  publicHost: process.env.PUBLIC_HOST ?? "localhost",
  caddyfilePath:
    process.env.CADDYFILE_PATH ?? "/etc/caddy/dynamic/Caddyfile",
  caddyAdminUrl: process.env.CADDY_ADMIN_URL ?? "http://caddy:2019",
  prune: process.env.DOCKER_PRUNE_AFTER_DEPLOY !== "false",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  githubAppId: process.env.GITHUB_APP_ID ?? "",
  githubAppPrivateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(
    /\\n/g,
    "\n",
  ),
  githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID ?? "",
  pollMs: Number(process.env.WORKER_POLL_MS ?? 2500),
  /** How long a fresh container gets to bind its port before we call it failed. */
  readinessTimeoutMs: Number(process.env.DEPLOY_READINESS_TIMEOUT_MS ?? 90_000),
  /** Self-heal sweep interval. 0 disables it. */
  reconcileMs: Number(process.env.WORKER_RECONCILE_MS ?? 20_000),
  /** Platform upstreams published through the proxy port. */
  apiUpstream: process.env.PROXY_API_UPSTREAM ?? "api:8080",
  webUpstream: process.env.PROXY_WEB_UPSTREAM ?? "web:3000",
  /** How long Caddy holds a request while an upstream is restarting. */
  proxyTryDurationSec: Number(process.env.PROXY_TRY_DURATION_SEC ?? 25),
};

const docker = createDocker();

type ProjectRow = {
  id: string;
  owner_id: string | null;
  name: string;
  repo_url: string;
  branch: string;
  dockerfile_path: string;
  build_context: string;
  port: number;
  env: Record<string, string>;
  container_id: string | null;
  image_tag: string | null;
  previous_image_tag: string | null;
  hostname: string;
  memory_limit_bytes: string | number;
  cpu_nano_cpus: string | number;
  status: string;
  service_role?: string | null;
  start_command?: string | null;
};

type JobRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
};

async function getCloneToken(ownerId?: string | null): Promise<string | null> {
  const keyMaterial =
    process.env.TOKEN_ENCRYPTION_KEY || process.env.ADMIN_TOKEN || "";

  if (ownerId) {
    const { rows } = await pool.query(
      `SELECT github_access_token FROM users WHERE id = $1`,
      [ownerId],
    );
    const stored = rows[0]?.github_access_token as string | undefined;
    if (stored) {
      try {
        return openSecret(stored, keyMaterial);
      } catch {
        return stored.startsWith("enc:v1:") ? null : stored;
      }
    }
  }

  // Host-level credentials only — never borrow another tenant's OAuth token
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

function assertInsideRepo(workDir: string, candidate: string): string {
  const root = resolve(workDir);
  const resolved = resolve(candidate);
  const prefix = root.endsWith("/") || root.endsWith("\\") ? root : root + sep;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error("buildContext/dockerfilePath escapes the project repository");
  }
  return resolved;
}

function resolveDockerBuildPaths(
  workDir: string,
  buildContext: string,
  dockerfilePath: string,
): { contextPath: string; dockerfileRel: string } {
  if (
    (buildContext || "").split(/[/\\]/).includes("..") ||
    (dockerfilePath || "").split(/[/\\]/).includes("..")
  ) {
    throw new Error("buildContext/dockerfilePath must not contain '..'");
  }

  const contextPath = assertInsideRepo(
    workDir,
    join(workDir, buildContext || "."),
  );
  const df = (dockerfilePath || "Dockerfile").replace(/^\.\//, "");

  // 1) Path relative to build context (e.g. context=backend, file=Dockerfile)
  if (existsSync(join(contextPath, df))) {
    assertInsideRepo(workDir, join(contextPath, df));
    return { contextPath, dockerfileRel: df };
  }

  // 2) Path relative to repo root (e.g. backend/Dockerfile with context=backend)
  const fromRoot = assertInsideRepo(workDir, join(workDir, df));
  if (existsSync(fromRoot)) {
    const rel = relative(contextPath, fromRoot).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      return { contextPath, dockerfileRel: rel };
    }
    // Dockerfile outside chosen context but inside repo — build from repo root
    return { contextPath: resolve(workDir), dockerfileRel: df };
  }

  // 3) Strip matching context prefix (backend/Dockerfile → Dockerfile)
  const ctx = (buildContext || ".").replace(/^\.\//, "").replace(/\/$/, "");
  if (ctx && ctx !== "." && df.startsWith(`${ctx}/`)) {
    const stripped = df.slice(ctx.length + 1);
    if (stripped && existsSync(join(contextPath, stripped))) {
      assertInsideRepo(workDir, join(contextPath, stripped));
      return { contextPath, dockerfileRel: stripped };
    }
  }

  return { contextPath, dockerfileRel: df };
}

function authCloneUrl(repoUrl: string, token: string | null): string {
  if (!token) return repoUrl;
  const u = new URL(repoUrl.replace(/\.git$/, "") + ".git");
  u.username = "x-access-token";
  u.password = token;
  return u.toString();
}

const MAX_DEPLOY_LOG_CHARS = 400_000;

async function appendDeployLog(deployId: string, chunk: string) {
  if (!chunk) return;
  await pool.query(
    `UPDATE deploys SET log = CASE
       WHEN length(log) + length($2::text) > $3
       THEN right(log || $2::text, $3)
       ELSE log || $2::text
     END
     WHERE id = $1`,
    [deployId, chunk, MAX_DEPLOY_LOG_CHARS],
  );
}

/**
 * Docker emits a build line every few milliseconds. Writing each one as its own
 * UPDATE meant thousands of round trips per deploy, each rewriting a TEXT column
 * that keeps growing — quadratic write amplification that slowed deploys down
 * and kept Postgres busy. Batch them instead: same live-tail feel, ~100x fewer
 * queries.
 */
class DeployLogger {
  private buffer: string[] = [];
  private pending = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly deployId: string,
    private readonly flushMs = 400,
    private readonly maxChars = 16_000,
  ) {}

  write(line: string): void {
    const chunk = line.endsWith("\n") ? line : `${line}\n`;
    this.buffer.push(chunk);
    this.pending += chunk.length;
    if (this.pending >= this.maxChars) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer.length) return this.flushing;
    const chunk = this.buffer.join("");
    this.buffer = [];
    this.pending = 0;
    this.flushing = this.flushing
      .then(() => appendDeployLog(this.deployId, chunk))
      .catch((err) => {
        console.warn("deploy log flush failed:", err);
      });
    return this.flushing;
  }
}

async function setDeployStatus(
  deployId: string,
  status: string,
  extra: { error?: string; imageTag?: string; finished?: boolean } = {},
) {
  await pool.query(
    `UPDATE deploys SET
      status = $2,
      error = COALESCE($3, error),
      image_tag = COALESCE($4, image_tag),
      finished_at = CASE WHEN $5 THEN NOW() ELSE finished_at END
    WHERE id = $1`,
    [
      deployId,
      status,
      extra.error ?? null,
      extra.imageTag ?? null,
      extra.finished ?? false,
    ],
  );
}

async function attachProxyNetwork(containerId: string) {
  try {
    await docker.getNetwork("laptop-paas").connect({ Container: containerId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already|exists/i.test(message)) {
      console.warn("attachProxyNetwork:", message);
    }
  }
}

/**
 * Routes are kept for every project that has ever produced an image and has not
 * been explicitly stopped — including ones mid-deploy.
 *
 * The old query selected `status = 'running'` only, so any proxy refresh that
 * happened while a project was `deploying` silently deleted that project's
 * route from the Caddyfile. Callers then fell through to the catch-all and got
 * a 200 with a plain-text body instead of their backend. That is the main
 * "my backend disappeared" failure.
 */
async function desiredRoutes(): Promise<
  Array<{ hostname: string; name: string; upstream: string }>
> {
  const { rows } = await pool.query<{
    hostname: string;
    name: string;
    port: number;
  }>(
    `SELECT hostname, name, port FROM projects
      WHERE status <> 'stopped'
        AND image_tag IS NOT NULL
      ORDER BY name ASC`,
  );
  return rows.map((r) => ({
    hostname: r.hostname,
    name: r.name,
    upstream: `paas-app-${r.name}:${r.port}`,
  }));
}

let proxyNeedsReload = false;
let proxyRefreshInFlight: Promise<void> | null = null;

async function doRefreshProxy(force: boolean): Promise<void> {
  // Never throw: a deploy that is already live must not be marked failed
  // because the proxy was briefly unreachable. The reconciler retries.
  try {
    const routes = await desiredRoutes();
    const changed = await writeCaddyfile(config.caddyfilePath, routes, {
      apiUpstream: config.apiUpstream || null,
      webUpstream: config.webUpstream || null,
      tryDurationSec: config.proxyTryDurationSec,
    });

    if (!changed && !force && !proxyNeedsReload) return;

    const ok = await reloadCaddyFromFile(
      config.caddyfilePath,
      config.caddyAdminUrl,
    );
    proxyNeedsReload = !ok;
    if (ok) {
      console.log(`Proxy updated with ${routes.length} route(s)`);
    } else {
      console.warn(
        `Proxy file written with ${routes.length} route(s) but Caddy reload failed; will retry`,
      );
    }
  } catch (err) {
    proxyNeedsReload = true;
    console.warn(
      "Proxy refresh failed; the reconciler will retry:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Collapses concurrent calls — every reload briefly drops in-flight conns. */
async function refreshProxy(opts: { force?: boolean } = {}): Promise<void> {
  if (proxyRefreshInFlight) {
    await proxyRefreshInFlight;
    if (!opts.force) return;
  }
  const run = doRefreshProxy(Boolean(opts.force)).finally(() => {
    proxyRefreshInFlight = null;
  });
  proxyRefreshInFlight = run;
  await run;
}

function appSpec(project: ProjectRow, image: string) {
  const network = `paas-net-${project.name}`;
  return {
    name: `paas-app-${project.name}`,
    image,
    env: { ...(project.env ?? {}), PORT: String(project.port) },
    network,
    extraNetworks: ["laptop-paas"],
    port: Number(project.port),
    memoryLimitBytes: Number(project.memory_limit_bytes),
    cpuNanoCpus: Number(project.cpu_nano_cpus),
    labels: {
      "laptop-paas.project": project.name,
      "laptop-paas.hostname": project.hostname,
    },
  };
}

async function startAppBlueGreen(
  project: ProjectRow,
  image: string,
  onLog: (line: string) => Promise<void>,
): Promise<string> {
  const network = `paas-net-${project.name}`;
  await ensureNetwork(docker, network);
  await ensureNetwork(docker, "laptop-paas");

  const finalName = `paas-app-${project.name}`;
  const nextName = `${finalName}-next`;
  const oldName = `${finalName}-old`;
  await removeContainerIfExists(docker, nextName);

  await onLog(`Starting candidate container ${nextName}`);
  const nextId = await runContainer(docker, {
    ...appSpec(project, image),
    name: nextName,
  });
  await attachProxyNetwork(nextId);

  // Wait for the process inside to actually accept TCP on its port. A container
  // can be "Running" for several seconds before it binds — cutting over on the
  // Running flag alone is why fresh deploys used to answer 502 at first.
  const readiness = await waitForContainerReady(
    docker,
    nextId,
    Number(project.port),
    {
      timeoutMs: config.readinessTimeoutMs,
      network: "laptop-paas",
      onLog: (line) => {
        void onLog(line);
      },
    },
  );

  if (!readiness.ready) {
    const logs = await containerLogs(docker, nextId, 200).catch(() => "");
    if (logs) await onLog(logs);
    await removeContainerIfExists(docker, nextName);
    const seconds = Math.round(readiness.waitedMs / 1000);
    throw new Error(
      readiness.reason === "exited"
        ? "Candidate container exited during startup"
        : readiness.reason === "no-network"
          ? `Candidate never joined the proxy network within ${seconds}s — check that Docker's "laptop-paas" network is healthy.`
          : `Candidate never listened on port ${project.port} within ${seconds}s. Make sure the app binds 0.0.0.0:$PORT (not 127.0.0.1) and that PORT matches the project setting.`,
    );
  }
  await onLog(
    `Candidate healthy on port ${project.port} after ${(
      readiness.waitedMs / 1000
    ).toFixed(1)}s`,
  );

  // Cut over with the smallest possible DNS gap: rename the old container out
  // of the way and the candidate in, back to back, and only stop the old one
  // afterwards. Stopping first (the previous behaviour) left a window where the
  // name `paas-app-<project>` resolved to nothing and Caddy answered 502.
  await removeContainerIfExists(docker, oldName);
  const hadOld = await containerExists(docker, finalName);
  if (hadOld) {
    try {
      await renameContainer(docker, finalName, oldName);
    } catch {
      await removeContainerIfExists(docker, finalName);
    }
  }
  await renameContainer(docker, nextName, finalName);
  const final = await docker.getContainer(finalName).inspect();

  if (hadOld) {
    await onLog("Draining previous container");
    try {
      await stopContainer(docker, oldName, 5);
    } catch {
      /* already gone */
    }
    await removeContainerIfExists(docker, oldName);
  }

  return final.Id;
}

async function syncRepo(
  project: ProjectRow,
  commitSha: string | null,
  onLog: (line: string) => Promise<void>,
): Promise<string> {
  const workDir = join(config.dataDir, "repos", project.name);
  mkdirSync(join(config.dataDir, "repos"), { recursive: true });

  try {
    const u = new URL(project.repo_url);
    if (
      u.protocol !== "https:" &&
      u.protocol !== "http:"
    ) {
      throw new Error("Only HTTP(S) GitHub repository URLs are allowed");
    }
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") {
      throw new Error("Only github.com repository URLs are allowed");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("github.com")) throw err;
    throw new Error("Invalid repository URL");
  }

  const token = await getCloneToken(project.owner_id);
  if (!token) {
    throw new Error(
      "No GitHub credentials for clone. Connect GitHub in Runbase (or set GITHUB_TOKEN / App installation on the host).",
    );
  }
  const cloneUrl = authCloneUrl(project.repo_url, token);
  await onLog(`Fetching ${project.repo_url} @ ${commitSha ?? project.branch}`);

  let isRepo = false;
  try {
    isRepo = await simpleGit(workDir).checkIsRepo();
  } catch {
    isRepo = false;
  }
  if (!isRepo) {
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    await simpleGit().clone(cloneUrl, workDir, ["--depth", "50"]);
  }

  const repo = simpleGit(workDir);
  await repo.remote(["set-url", "origin", cloneUrl]);
  await repo.fetch(["origin", "--tags", "--prune"]);

  if (commitSha) {
    try {
      await repo.checkout(commitSha, ["--force"]);
    } catch {
      await onLog(`Deepening fetch for ${commitSha}`);
      await repo.fetch(["origin", commitSha, "--depth", "200"]);
      try {
        await repo.checkout(commitSha, ["--force"]);
      } catch {
        await repo.fetch(["--unshallow"]).catch(() => undefined);
        await repo.fetch(["origin"]);
        await repo.checkout(commitSha, ["--force"]);
      }
    }
  } else {
    await repo.fetch("origin", project.branch);
    await repo.checkout(["-B", project.branch, `origin/${project.branch}`]);
  }

  return (await repo.revparse(["HEAD"])).trim();
}

async function handleDeploy(job: JobRow) {
  const projectId = String(job.payload.projectId);
  const deployId = String(job.payload.deployId);
  const commitSha = (job.payload.commitSha as string | null) ?? null;
  const redeploy = Boolean(job.payload.redeploy);

  const { rows } = await pool.query<ProjectRow>(
    `SELECT * FROM projects WHERE id = $1`,
    [projectId],
  );
  const project = rows[0];
  if (!project) throw new Error("Project not found");

  const network = `paas-net-${project.name}`;
  await ensureNetwork(docker, network);
  await ensureNetwork(docker, "laptop-paas");

  const logger = new DeployLogger(deployId);
  const log = async (line: string): Promise<void> => {
    logger.write(line);
  };

  try {
    await setDeployStatus(deployId, "building");
    await log(`Starting deploy for ${project.name}`);

    let imageTag = project.image_tag;
    const shortSha = commitSha ? commitSha.slice(0, 12) : `manual-${Date.now()}`;
    const newTag = `paas/${project.name}:${shortSha}`;

    if (redeploy) {
      if (!project.previous_image_tag) {
        throw new Error("No previous image to redeploy");
      }
      await log(`Redeploying previous image ${project.previous_image_tag}`);
      if (!(await imageExists(docker, project.previous_image_tag))) {
        throw new Error(`Previous image missing: ${project.previous_image_tag}`);
      }
      imageTag = project.previous_image_tag;
    } else {
      const head = await syncRepo(project, commitSha, log);
      await pool.query(`UPDATE deploys SET commit_sha = $2 WHERE id = $1`, [
        deployId,
        head,
      ]);
      await log(`Building image ${newTag}`);

      const workDir = join(config.dataDir, "repos", project.name);
      let { contextPath, dockerfileRel: dockerfilePath } = resolveDockerBuildPaths(
        workDir,
        project.build_context || ".",
        project.dockerfile_path || "Dockerfile",
      );
      const absDockerfile = join(contextPath, dockerfilePath);
      const needsGenerated =
        !existsSync(absDockerfile) ||
        dockerfilePath === ".dockyard/Dockerfile";
      if (needsGenerated) {
        // Always write + build the same path (avoid writing Dockerfile then
        // asking Docker for .dockyard/Dockerfile).
        dockerfilePath = ".dockyard/Dockerfile";
        const outPath = join(contextPath, dockerfilePath);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(
          outPath,
          generatedNodeDockerfile({
            port: project.port,
            startCommand: project.start_command ?? null,
          }),
          "utf8",
        );
        await log(
          `Generated ${dockerfilePath} for ${project.service_role || "full"} service`,
        );
      } else {
        await log(
          `Using Dockerfile ${dockerfilePath} (context ${project.build_context || "."})`,
        );
      }
      await buildImage(
        docker,
        contextPath,
        dockerfilePath,
        [newTag, `paas/${project.name}:latest`],
        (line) => {
          void log(line);
        },
      );
      imageTag = newTag;
    }

    await setDeployStatus(deployId, "deploying", { imageTag: imageTag! });
    await log("Starting container (blue/green)");

    const { rows: dbs } = await pool.query<{ name: string }>(
      `SELECT name FROM databases WHERE project_id = $1 AND status = 'running'`,
      [projectId],
    );
    for (const db of dbs) {
      try {
        await docker.getNetwork(network).connect({ Container: `paas-db-${db.name}` });
      } catch {
        /* already connected */
      }
    }

    const previousImage = project.image_tag;
    let containerId: string;
    try {
      containerId = await startAppBlueGreen(project, imageTag!, log);
    } catch (err) {
      if (previousImage && previousImage !== imageTag) {
        await log(`Start failed; rolling back to ${previousImage}`);
        containerId = await startAppBlueGreen(project, previousImage, log);
        await pool.query(
          `UPDATE projects SET container_id = $2, status = 'running', updated_at = NOW() WHERE id = $1`,
          [projectId, containerId],
        );
        await logger.flush();
        await setDeployStatus(deployId, "rolled_back", {
          error: err instanceof Error ? err.message : String(err),
          finished: true,
        });
        await refreshProxy();
        return;
      }
      throw err;
    }

    // On successful redeploy of previous, swap previous/current tags
    if (redeploy && project.image_tag) {
      await pool.query(
        `UPDATE projects SET
          container_id = $2,
          previous_image_tag = image_tag,
          image_tag = $3,
          status = 'running',
          updated_at = NOW()
        WHERE id = $1`,
        [projectId, containerId, imageTag],
      );
    } else {
      await pool.query(
        `UPDATE projects SET
          container_id = $2,
          previous_image_tag = CASE
            WHEN image_tag IS NOT NULL AND image_tag <> $3 THEN image_tag
            ELSE previous_image_tag
          END,
          image_tag = $3,
          status = 'running',
          updated_at = NOW()
        WHERE id = $1`,
        [projectId, containerId, imageTag],
      );
    }

    await logger.flush();
    await setDeployStatus(deployId, "live", {
      imageTag: imageTag ?? undefined,
      finished: true,
    });
    await log(
      `Live — http://${project.hostname} or http://<host>/p/${project.name}/`,
    );
    await logger.flush();
    await refreshProxy();
    if (config.prune) await pruneDanglingImages(docker);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(`ERROR: ${message}`);
    await logger.flush();
    await setDeployStatus(deployId, "failed", { error: message, finished: true });
    await pool.query(
      `UPDATE projects SET status = 'error', updated_at = NOW() WHERE id = $1`,
      [projectId],
    );
    throw err;
  }
}

async function handleStop(job: JobRow) {
  // Destructive remove (delete project / delete database)
  if (job.payload.destroy) {
    const name = String(job.payload.containerName ?? "");
    if (name) await removeContainerIfExists(docker, name);
    if (job.payload.volumeName) {
      await removeVolumeIfExists(docker, String(job.payload.volumeName));
    }
    await refreshProxy();
    return;
  }

  if (job.payload.containerName && !job.payload.projectId) {
    await removeContainerIfExists(docker, String(job.payload.containerName));
    return;
  }

  const projectId = String(job.payload.projectId);
  const { rows } = await pool.query<ProjectRow>(
    `SELECT * FROM projects WHERE id = $1`,
    [projectId],
  );
  const project = rows[0];
  if (!project) {
    if (job.payload.containerName) {
      await removeContainerIfExists(docker, String(job.payload.containerName));
      await refreshProxy();
    }
    return;
  }

  const name = `paas-app-${project.name}`;
  // Soft stop — keep container so restart works
  await stopContainer(docker, name);
  await pool.query(
    `UPDATE projects SET status = 'stopped', updated_at = NOW() WHERE id = $1`,
    [projectId],
  );
  await refreshProxy();
}

async function handleRestart(job: JobRow) {
  const projectId = String(job.payload.projectId);
  const { rows } = await pool.query<ProjectRow>(
    `SELECT * FROM projects WHERE id = $1`,
    [projectId],
  );
  const project = rows[0];
  if (!project) return;

  const name = `paas-app-${project.name}`;
  // Always recreate so updated env vars (e.g. MYSQL*) take effect.
  // A plain docker start keeps the old container env forever.
  if (await containerExists(docker, name)) {
    try {
      await stopContainer(docker, name);
    } catch {
      /* */
    }
    await removeContainerIfExists(docker, name);
  }

  if (!project.image_tag) {
    throw new Error("Nothing to restart — deploy the project first");
  }

  await ensureNetwork(docker, `paas-net-${project.name}`);
  await ensureNetwork(docker, "laptop-paas");
  const id = await runContainer(docker, appSpec(project, project.image_tag));
  await attachProxyNetwork(id);
  await pool.query(
    `UPDATE projects SET status = 'running', container_id = $2, updated_at = NOW() WHERE id = $1`,
    [projectId, id],
  );

  await refreshProxy();
}

async function handleProvisionDatabase(job: JobRow) {
  const databaseId = String(job.payload.databaseId);
  const password = String(job.payload.password ?? "");
  const relinkOnly = Boolean(job.payload.relinkOnly);
  const { rows } = await pool.query<{
    id: string;
    name: string;
    kind: string;
    project_id: string | null;
    volume_name: string;
    connection_url: string;
    status: string;
    config: {
      version?: string;
      memoryMb?: number;
      cpu?: number;
      image?: string;
      volumePath?: string;
      port?: number;
    } | null;
  }>(`SELECT * FROM databases WHERE id = $1`, [databaseId]);
  const db = rows[0];
  if (!db) throw new Error("Database not found");

  let network = `paas-net-db-${db.name}`;
  if (db.project_id) {
    const { rows: prows } = await pool.query<{ name: string }>(
      `SELECT name FROM projects WHERE id = $1`,
      [db.project_id],
    );
    if (prows[0]) network = `paas-net-${prows[0].name}`;
  }
  await ensureNetwork(docker, network);

  const containerName = `paas-db-${db.name}`;

  if (relinkOnly) {
    try {
      await docker.getNetwork(network).connect({ Container: containerName });
    } catch {
      /* already on network or missing */
    }
    return;
  }

  await ensureVolume(docker, db.volume_name);
  await removeContainerIfExists(docker, containerName);

  const cfg = db.config ?? {};
  const kind = db.kind;
  const version = cfg.version ?? "16";
  const memoryLimitBytes = Math.round((cfg.memoryMb ?? 512) * 1024 * 1024);
  const cpuNanoCpus = Math.round((cfg.cpu ?? 0.5) * 1_000_000_000);
  const image =
    cfg.image ??
    ({
      postgres: `postgres:${version}-alpine`,
      mysql: `mysql:${version}`,
      mariadb: `mariadb:${version}`,
      redis: `redis:${version}-alpine`,
      mongodb: `mongo:${version}`,
      minio: "minio/minio:latest",
    } as Record<string, string>)[kind] ??
    `postgres:${version}-alpine`;

  await pullImage(docker, image, (l) => console.log(`[pull ${kind}]`, l));

  const volumePath =
    cfg.volumePath ??
    ({
      postgres: "/var/lib/postgresql/data",
      mysql: "/var/lib/mysql",
      mariadb: "/var/lib/mysql",
      redis: "/data",
      mongodb: "/data/db",
      minio: "/data",
    } as Record<string, string>)[kind] ??
    "/data";

  const port =
    cfg.port ??
    ({
      postgres: 5432,
      mysql: 3306,
      mariadb: 3306,
      redis: 6379,
      mongodb: 27017,
      minio: 9000,
    } as Record<string, number>)[kind] ??
    5432;

  let env: Record<string, string> = {};
  let cmd: string[] | undefined;

  if (kind === "postgres") {
    env = {
      POSTGRES_USER: "paas",
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: "paas",
    };
  } else if (kind === "mysql" || kind === "mariadb") {
    env = {
      MYSQL_ROOT_PASSWORD: password,
      MYSQL_DATABASE: "paas",
      MYSQL_USER: "paas",
      MYSQL_PASSWORD: password,
    };
  } else if (kind === "redis") {
    cmd = ["redis-server", "--requirepass", password];
  } else if (kind === "mongodb") {
    env = {
      MONGO_INITDB_ROOT_USERNAME: "paas",
      MONGO_INITDB_ROOT_PASSWORD: password,
      MONGO_INITDB_DATABASE: "paas",
    };
  } else if (kind === "minio") {
    env = {
      MINIO_ROOT_USER: "paas",
      MINIO_ROOT_PASSWORD: password,
    };
    cmd = ["server", "/data", "--console-address", ":9001"];
  }

  await runContainer(docker, {
    name: containerName,
    image,
    env,
    network,
    port,
    memoryLimitBytes,
    cpuNanoCpus,
    volumes: [{ name: db.volume_name, containerPath: volumePath }],
    cmd,
    labels: { "laptop-paas.db": db.name, "laptop-paas.kind": kind },
  });

  const info = await docker.getContainer(containerName).inspect();
  await pool.query(
    `UPDATE databases SET container_id = $2, status = 'running' WHERE id = $1`,
    [databaseId, info.Id],
  );
}

/* ------------------------------------------------------------------ *
 * Reconciler
 *
 * The desired state lives in Postgres; Docker is the actual state. After a
 * Windows reboot, a Docker Desktop restart, a WSL shutdown or an OOM kill those
 * two drift and nothing used to notice until someone clicked Deploy. This sweep
 * pulls them back together and re-publishes the proxy config.
 * ------------------------------------------------------------------ */

/**
 * The sweep and the job runner both mutate containers, so they take turns:
 * `reconcile()` bails out while a job is running, and the job loop waits for an
 * in-flight sweep before it starts.
 */
let reconcilePromise: Promise<void> | null = null;
let jobInFlight = false;

async function reconcileProject(project: ProjectRow): Promise<boolean> {
  const name = `paas-app-${project.name}`;
  let healed = false;

  type Inspected = Awaited<
    ReturnType<ReturnType<typeof docker.getContainer>["inspect"]>
  >;
  let info: Inspected | null = null;
  try {
    info = await docker.getContainer(name).inspect();
  } catch {
    info = null;
  }

  if (!info) {
    if (!project.image_tag) return false;
    if (!(await imageExists(docker, project.image_tag))) {
      console.warn(
        `[reconcile] ${name} is missing and image ${project.image_tag} is gone — needs a redeploy`,
      );
      await pool.query(
        `UPDATE projects SET status = 'error', updated_at = NOW() WHERE id = $1`,
        [project.id],
      );
      return true;
    }
    console.warn(`[reconcile] recreating missing container ${name}`);
    await ensureNetwork(docker, `paas-net-${project.name}`);
    await ensureNetwork(docker, "laptop-paas");
    const id = await runContainer(docker, appSpec(project, project.image_tag));
    await attachProxyNetwork(id);
    await pool.query(
      `UPDATE projects SET container_id = $2, updated_at = NOW() WHERE id = $1`,
      [project.id, id],
    );
    return true;
  }

  if (!info.State?.Running) {
    console.warn(`[reconcile] starting stopped container ${name}`);
    try {
      await startContainer(docker, name);
      healed = true;
    } catch (err) {
      console.warn(`[reconcile] could not start ${name}:`, err);
    }
  }

  // Docker recreates user networks on restart; a container can come back up
  // detached from the proxy network, which looks exactly like a dead backend.
  if (!info.NetworkSettings?.Networks?.["laptop-paas"]) {
    console.warn(`[reconcile] reattaching ${name} to the proxy network`);
    await ensureNetwork(docker, "laptop-paas");
    await attachProxyNetwork(info.Id);
    healed = true;
  }

  // Keep container_id honest so logs/metrics do not read a dead container.
  if (project.container_id !== info.Id) {
    await pool.query(
      `UPDATE projects SET container_id = $2 WHERE id = $1`,
      [project.id, info.Id],
    );
  }

  return healed;
}

async function reconcileDatabases(): Promise<boolean> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM databases WHERE status = 'running'`,
  );
  let healed = false;
  for (const db of rows) {
    const name = `paas-db-${db.name}`;
    try {
      const info = await docker.getContainer(name).inspect();
      if (!info.State?.Running) {
        console.warn(`[reconcile] starting stopped database ${name}`);
        await startContainer(docker, name);
        healed = true;
      }
    } catch {
      console.warn(
        `[reconcile] database container ${name} is missing — marking it stopped`,
      );
      await pool.query(
        `UPDATE databases SET status = 'stopped' WHERE id = $1`,
        [db.id],
      );
      healed = true;
    }
  }
  return healed;
}

async function runReconcileSweep(): Promise<void> {
  try {
    const { rows } = await pool.query<ProjectRow>(
      `SELECT * FROM projects
        WHERE status = 'running' AND image_tag IS NOT NULL`,
    );
    let healed = false;
    for (const project of rows) {
      try {
        if (await reconcileProject(project)) healed = true;
      } catch (err) {
        console.warn(`[reconcile] ${project.name} failed:`, err);
      }
    }
    if (await reconcileDatabases()) healed = true;

    // Always re-assert the proxy: cheap when nothing changed (the file is only
    // rewritten on a real diff) and it repairs a Caddy that lost its config.
    await refreshProxy({ force: healed || proxyNeedsReload });
  } catch (err) {
    console.warn("[reconcile] sweep failed:", err);
  }
}

function reconcile(): void {
  if (reconcilePromise || jobInFlight) return;
  reconcilePromise = runReconcileSweep().finally(() => {
    reconcilePromise = null;
  });
}


async function processJob(job: JobRow) {
  switch (job.type) {
    case "deploy":
      await handleDeploy(job);
      break;
    case "stop":
      await handleStop(job);
      break;
    case "restart":
      await handleRestart(job);
      break;
    case "provision_database":
      await handleProvisionDatabase(job);
      break;
    case "update_proxy":
      await refreshProxy({ force: true });
      break;
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

async function claimNextJob(): Promise<JobRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<JobRow>(
      `SELECT id, type, payload, attempts FROM jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (!rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
      [rows[0].id],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Jobs left `running` by a crash or a container restart would otherwise sit in
 * the queue forever and leave their project stuck on "deploying".
 */
async function requeueStaleJobs(): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET status = 'queued', updated_at = NOW()
      WHERE status = 'running'
        AND attempts < 3
        AND updated_at < NOW() - INTERVAL '30 minutes'`,
  );
  if (rowCount) console.log(`Requeued ${rowCount} stale job(s)`);

  const { rowCount: failed } = await pool.query(
    `UPDATE jobs SET status = 'failed',
            last_error = COALESCE(last_error, 'Abandoned after repeated attempts'),
            updated_at = NOW()
      WHERE status = 'running'
        AND attempts >= 3
        AND updated_at < NOW() - INTERVAL '30 minutes'`,
  );
  if (failed) console.warn(`Marked ${failed} abandoned job(s) failed`);

  // Deploy rows orphaned the same way
  await pool.query(
    `UPDATE deploys SET status = 'failed',
            error = COALESCE(error, 'Interrupted — the worker restarted mid-deploy'),
            finished_at = NOW()
      WHERE status IN ('queued', 'building', 'deploying')
        AND created_at < NOW() - INTERVAL '30 minutes'`,
  );
}

async function pruneOldJobs() {
  await pool.query(
    `DELETE FROM jobs WHERE status IN ('succeeded', 'failed') AND updated_at < NOW() - INTERVAL '7 days'`,
  );
}

/* ------------------------------------------------------------------ *
 * Job wake-ups
 *
 * The API issues `NOTIFY runbase_jobs` after enqueuing, so a deploy starts the
 * moment it is requested instead of on the next poll tick. Polling stays as the
 * fallback path, so losing the listener only costs latency, never correctness.
 * ------------------------------------------------------------------ */

let wake: (() => void) | null = null;

function waitForJobSignal(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      wake = null;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    wake = finish;
  });
}

function startJobListener(): void {
  let reconnectTimer: NodeJS.Timeout | null = null;

  const scheduleReconnect = () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
    reconnectTimer.unref?.();
  };

  const connect = () => {
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      keepAlive: true,
    });
    client.on("notification", () => wake?.());
    client.on("error", (err) => {
      console.warn("[listen] connection error:", err.message);
      client.end().catch(() => undefined);
      scheduleReconnect();
    });
    client.on("end", scheduleReconnect);

    client
      .connect()
      .then(() => client.query("LISTEN runbase_jobs"))
      .then(() => console.log("Listening for job notifications"))
      .catch((err) => {
        console.warn("[listen] could not subscribe:", err.message);
        scheduleReconnect();
      });
  };

  connect();
}

async function loop() {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(join(config.dataDir, "repos"), { recursive: true });
  console.log("Worker started");
  await requeueStaleJobs().catch((err) =>
    console.warn("Stale job sweep failed", err),
  );
  startJobListener();
  await refreshProxy({ force: true }).catch((err) =>
    console.warn("Initial proxy refresh failed", err),
  );

  if (config.reconcileMs > 0) {
    setInterval(reconcile, config.reconcileMs).unref?.();
    console.log(`Reconciler sweeping every ${config.reconcileMs}ms`);
  }

  let ticks = 0;
  for (;;) {
    if (stopping && !jobInFlight) break;
    try {
      const job = await claimNextJob();
      if (!job) {
        await waitForJobSignal(config.pollMs);
        ticks += 1;
        if (ticks % 200 === 0) {
          await pruneOldJobs().catch(() => undefined);
          await requeueStaleJobs().catch(() => undefined);
        }
        continue;
      }
      if (reconcilePromise) await reconcilePromise;
      console.log(`Running job ${job.id} (${job.type})`);
      jobInFlight = true;
      try {
        await processJob(job);
        await pool.query(
          `UPDATE jobs SET status = 'succeeded', updated_at = NOW() WHERE id = $1`,
          [job.id],
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Job ${job.id} failed:`, message);
        await pool.query(
          `UPDATE jobs SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
          [job.id, message],
        );
      } finally {
        jobInFlight = false;
      }
    } catch (err) {
      console.error("Worker loop error", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/**
 * Compose sends SIGTERM on `down`/restart. Finish the job in flight — killing a
 * worker mid-deploy leaves a half-renamed container and a project stuck on
 * "deploying".
 */
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log(`${signal} received — finishing the current job, then exiting`);
    wake?.();
    // Hard cap so we never outlive the compose stop_grace_period.
    setTimeout(() => process.exit(0), 25_000).unref?.();
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection:", reason);
});

loop()
  .then(() => {
    console.log("Worker stopped");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Worker crashed:", err);
    process.exit(1);
  });
