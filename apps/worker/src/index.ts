import "dotenv/config";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
  writeCaddyfile,
} from "@laptop-paas/docker";
import { createAppAuth } from "@octokit/auth-app";

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
  pollMs: Number(process.env.WORKER_POLL_MS ?? 1500),
};

const docker = createDocker();

type ProjectRow = {
  id: string;
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
};

type JobRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
};

async function getCloneToken(): Promise<string | null> {
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

function authCloneUrl(repoUrl: string, token: string | null): string {
  if (!token) return repoUrl;
  const u = new URL(repoUrl.replace(/\.git$/, "") + ".git");
  u.username = "x-access-token";
  u.password = token;
  return u.toString();
}

async function appendDeployLog(deployId: string, line: string) {
  await pool.query(`UPDATE deploys SET log = log || $2 WHERE id = $1`, [
    deployId,
    line.endsWith("\n") ? line : `${line}\n`,
  ]);
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

async function refreshProxy() {
  const { rows } = await pool.query<{
    hostname: string;
    name: string;
    port: number;
  }>(
    `SELECT hostname, name, port FROM projects
     WHERE status = 'running' AND container_id IS NOT NULL`,
  );
  const routes = rows.map((r) => ({
    hostname: r.hostname,
    name: r.name,
    upstream: `paas-app-${r.name}:${r.port}`,
  }));
  await writeCaddyfile(config.caddyfilePath, routes);
  await reloadCaddyFromFile(config.caddyfilePath, config.caddyAdminUrl);
  console.log(`Proxy updated with ${routes.length} route(s)`);
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
  const nextName = `paas-app-${project.name}-next`;
  await removeContainerIfExists(docker, nextName);

  await onLog(`Starting candidate container ${nextName}`);
  const nextId = await runContainer(docker, {
    ...appSpec(project, image),
    name: nextName,
  });
  await attachProxyNetwork(nextId);

  await new Promise((r) => setTimeout(r, 2000));
  const inspect = await docker.getContainer(nextId).inspect();
  if (!inspect.State.Running) {
    const logs = await containerLogs(docker, nextId, 100);
    await onLog(logs);
    await removeContainerIfExists(docker, nextName);
    throw new Error("Candidate container exited after start");
  }

  // Swap: stop old, rename next → final
  const oldExists = await containerExists(docker, finalName);
  if (oldExists) {
    await onLog("Cutting over from previous container");
    try {
      await stopContainer(docker, finalName);
    } catch {
      /* */
    }
    await removeContainerIfExists(docker, `${finalName}-old`);
    try {
      await renameContainer(docker, finalName, `${finalName}-old`);
    } catch {
      await removeContainerIfExists(docker, finalName);
    }
  }

  await renameContainer(docker, nextName, finalName);
  const final = await docker.getContainer(finalName).inspect();
  await removeContainerIfExists(docker, `${finalName}-old`);
  return final.Id;
}

async function syncRepo(
  project: ProjectRow,
  commitSha: string | null,
  onLog: (line: string) => Promise<void>,
): Promise<string> {
  const workDir = join(config.dataDir, "repos", project.name);
  mkdirSync(join(config.dataDir, "repos"), { recursive: true });

  const token = await getCloneToken();
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

  const log = (line: string) => appendDeployLog(deployId, line);

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
      const contextPath = join(workDir, project.build_context);
      await buildImage(
        docker,
        contextPath,
        project.dockerfile_path,
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

    await setDeployStatus(deployId, "live", {
      imageTag: imageTag ?? undefined,
      finished: true,
    });
    await log(
      `Live — http://${project.hostname} or http://<host>/p/${project.name}/`,
    );
    await refreshProxy();
    if (config.prune) await pruneDanglingImages(docker);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(`ERROR: ${message}`);
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
  const exists = await containerExists(docker, name);

  if (exists) {
    try {
      await stopContainer(docker, name);
    } catch {
      /* */
    }
    await startContainer(docker, name);
    const info = await docker.getContainer(name).inspect();
    await pool.query(
      `UPDATE projects SET status = 'running', container_id = $2, updated_at = NOW() WHERE id = $1`,
      [projectId, info.Id],
    );
  } else if (project.image_tag) {
    // Recreate from last image
    await ensureNetwork(docker, `paas-net-${project.name}`);
    await ensureNetwork(docker, "laptop-paas");
    const id = await runContainer(docker, appSpec(project, project.image_tag));
    await attachProxyNetwork(id);
    await pool.query(
      `UPDATE projects SET status = 'running', container_id = $2, updated_at = NOW() WHERE id = $1`,
      [projectId, id],
    );
  } else {
    throw new Error("Nothing to restart — deploy the project first");
  }

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
      await refreshProxy();
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

async function pruneOldJobs() {
  await pool.query(
    `DELETE FROM jobs WHERE status IN ('succeeded', 'failed') AND updated_at < NOW() - INTERVAL '7 days'`,
  );
}

async function loop() {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(join(config.dataDir, "repos"), { recursive: true });
  console.log("Worker started");
  await refreshProxy().catch((err) =>
    console.warn("Initial proxy refresh failed", err),
  );

  let ticks = 0;
  for (;;) {
    try {
      const job = await claimNextJob();
      if (!job) {
        await new Promise((r) => setTimeout(r, config.pollMs));
        ticks += 1;
        if (ticks % 200 === 0) await pruneOldJobs().catch(() => undefined);
        continue;
      }
      console.log(`Running job ${job.id} (${job.type})`);
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
      }
    } catch (err) {
      console.error("Worker loop error", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

loop();
