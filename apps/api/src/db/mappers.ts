import type {
  Deploy,
  DeployStatus,
  Job,
  JobStatus,
  JobType,
  ManagedDatabase,
  Project,
  ProjectStatus,
  ServiceRole,
} from "@laptop-paas/shared";

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
  status: ProjectStatus;
  container_id: string | null;
  image_tag: string | null;
  previous_image_tag: string | null;
  hostname: string;
  memory_limit_bytes: string | number;
  cpu_nano_cpus: string | number;
  auto_deploy: boolean;
  service_role?: string | null;
  start_command?: string | null;
  vercel_project_id?: string | null;
  vercel_project_name?: string | null;
  vercel_project_url?: string | null;
  vercel_env_key?: string | null;
  vercel_linked_at?: Date | null;
  created_at: Date;
  updated_at: Date;
};

type DeployRow = {
  id: string;
  project_id: string;
  commit_sha: string | null;
  status: DeployStatus;
  triggered_by: string;
  image_tag: string | null;
  log: string;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
};

type DbRow = {
  id: string;
  owner_id: string | null;
  name: string;
  kind: ManagedDatabase["kind"];
  project_id: string | null;
  container_id: string | null;
  volume_name: string;
  connection_url: string;
  status: ManagedDatabase["status"];
  config?: ManagedDatabase["config"] | null;
  created_at: Date;
};

type JobRow = {
  id: string;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

export function mapProject(row: ProjectRow | Record<string, unknown>): Project {
  const r = row as ProjectRow;
  return {
    id: r.id,
    ownerId: r.owner_id ?? null,
    name: r.name,
    repoUrl: r.repo_url ?? "",
    branch: r.branch,
    dockerfilePath: r.dockerfile_path,
    buildContext: r.build_context,
    port: r.port,
    env: r.env ?? {},
    status: r.status,
    containerId: r.container_id,
    imageTag: r.image_tag,
    previousImageTag: r.previous_image_tag,
    hostname: r.hostname,
    memoryLimitBytes: Number(r.memory_limit_bytes),
    cpuNanoCpus: Number(r.cpu_nano_cpus),
    autoDeploy: r.auto_deploy,
    serviceRole: (r.service_role as ServiceRole) || "full",
    startCommand: r.start_command ?? null,
    vercelProjectId: r.vercel_project_id ?? null,
    vercelProjectName: r.vercel_project_name ?? null,
    vercelProjectUrl: r.vercel_project_url ?? null,
    vercelEnvKey: r.vercel_env_key ?? null,
    vercelLinkedAt: r.vercel_linked_at
      ? r.vercel_linked_at.toISOString()
      : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export function mapDeploy(row: DeployRow | Record<string, unknown>): Deploy {
  const r = row as DeployRow;
  return {
    id: r.id,
    projectId: r.project_id,
    commitSha: r.commit_sha,
    status: r.status,
    triggeredBy: r.triggered_by,
    imageTag: r.image_tag,
    log: r.log,
    error: r.error,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

export function mapDatabase(row: DbRow | Record<string, unknown>): ManagedDatabase {
  const r = row as DbRow;
  return {
    id: r.id,
    ownerId: r.owner_id ?? null,
    name: r.name,
    kind: r.kind,
    projectId: r.project_id,
    containerId: r.container_id,
    volumeName: r.volume_name,
    connectionUrl: r.connection_url,
    status: r.status,
    config: r.config ?? {},
    createdAt: r.created_at.toISOString(),
  };
}

export function mapJob(row: JobRow | Record<string, unknown>): Job {
  const r = row as JobRow;
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    payload: r.payload ?? {},
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
