import { z } from "zod";

export const DeployStatus = z.enum([
  "queued",
  "building",
  "deploying",
  "live",
  "failed",
  "rolled_back",
]);
export type DeployStatus = z.infer<typeof DeployStatus>;

export const ProjectStatus = z.enum([
  "idle",
  "deploying",
  "running",
  "stopped",
  "error",
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const DatabaseKind = z.enum([
  "postgres",
  "redis",
  "mysql",
  "mariadb",
  "mongodb",
  "minio",
]);
export type DatabaseKind = z.infer<typeof DatabaseKind>;

export const JobType = z.enum([
  "deploy",
  "stop",
  "restart",
  "provision_database",
  "update_proxy",
]);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const PlanId = z.enum(["hobby", "pro"]);
export type PlanId = z.infer<typeof PlanId>;

export const PLANS = {
  hobby: {
    id: "hobby" as const,
    name: "Hobby",
    priceLabel: "$0",
    period: "forever",
    description: "Side projects on your own host.",
    features: [
      "Up to 5 services",
      "5 managed datastores",
      "512 MB default RAM",
      "GitHub auto-deploy",
      "Usage & metrics",
    ],
    maxProjects: 5,
    maxDatabases: 5,
    defaultMemoryBytes: 536870912,
    defaultCpuNano: 1_000_000_000,
  },
  pro: {
    id: "pro" as const,
    name: "Pro",
    priceLabel: "$0",
    period: "self-hosted",
    description: "Higher limits for production on this machine.",
    features: [
      "Up to 25 services",
      "25 managed datastores",
      "2 GB default RAM",
      "All database engines",
      "Priority deploy capacity",
    ],
    maxProjects: 25,
    maxDatabases: 25,
    defaultMemoryBytes: 2147483648,
    defaultCpuNano: 2_000_000_000,
  },
} as const;

export type Plan = (typeof PLANS)[PlanId];

export type DatabasePreset = {
  kind: DatabaseKind;
  label: string;
  blurb: string;
  engine: string;
  defaultVersion: string;
  versions: string[];
  port: number;
  volumePath: string;
  defaultMemoryMb: number;
  defaultCpu: number;
  envKey: string;
  category: "relational" | "cache" | "document" | "object";
};

/** Preselected datastore configs (Railway/Render-style one-click engines). */
export const DATABASE_PRESETS: Record<DatabaseKind, DatabasePreset> = {
  postgres: {
    kind: "postgres",
    label: "PostgreSQL",
    blurb: "Relational default — apps, ORMs, analytics.",
    engine: "PostgreSQL",
    defaultVersion: "16",
    versions: ["16", "15", "14"],
    port: 5432,
    volumePath: "/var/lib/postgresql/data",
    defaultMemoryMb: 512,
    defaultCpu: 0.5,
    envKey: "DATABASE_URL",
    category: "relational",
  },
  mysql: {
    kind: "mysql",
    label: "MySQL",
    blurb: "Classic relational engine for LAMP and ORMs.",
    engine: "MySQL",
    defaultVersion: "8.4",
    versions: ["8.4", "8.0"],
    port: 3306,
    volumePath: "/var/lib/mysql",
    defaultMemoryMb: 512,
    defaultCpu: 0.5,
    envKey: "DATABASE_URL",
    category: "relational",
  },
  mariadb: {
    kind: "mariadb",
    label: "MariaDB",
    blurb: "MySQL-compatible relational store.",
    engine: "MariaDB",
    defaultVersion: "11.4",
    versions: ["11.4", "10.11"],
    port: 3306,
    volumePath: "/var/lib/mysql",
    defaultMemoryMb: 512,
    defaultCpu: 0.5,
    envKey: "DATABASE_URL",
    category: "relational",
  },
  redis: {
    kind: "redis",
    label: "Redis",
    blurb: "In-memory cache, queues, and sessions.",
    engine: "Redis",
    defaultVersion: "7",
    versions: ["7", "6"],
    port: 6379,
    volumePath: "/data",
    defaultMemoryMb: 256,
    defaultCpu: 0.25,
    envKey: "REDIS_URL",
    category: "cache",
  },
  mongodb: {
    kind: "mongodb",
    label: "MongoDB",
    blurb: "Document store for flexible JSON data.",
    engine: "MongoDB",
    defaultVersion: "7",
    versions: ["7", "6"],
    port: 27017,
    volumePath: "/data/db",
    defaultMemoryMb: 512,
    defaultCpu: 0.5,
    envKey: "MONGO_URL",
    category: "document",
  },
  minio: {
    kind: "minio",
    label: "MinIO (S3)",
    blurb: "S3-compatible object storage for files and backups.",
    engine: "MinIO",
    defaultVersion: "latest",
    versions: ["latest"],
    port: 9000,
    volumePath: "/data",
    defaultMemoryMb: 512,
    defaultCpu: 0.5,
    envKey: "S3_ENDPOINT",
    category: "object",
  },
};

export function databaseImage(kind: DatabaseKind, version: string): string {
  switch (kind) {
    case "postgres":
      return `postgres:${version}-alpine`;
    case "mysql":
      return `mysql:${version}`;
    case "mariadb":
      return `mariadb:${version}`;
    case "redis":
      return `redis:${version}-alpine`;
    case "mongodb":
      return `mongo:${version}`;
    case "minio":
      return "minio/minio:latest";
    default:
      return `postgres:16-alpine`;
  }
}

export function buildDatabaseConnectionUrl(opts: {
  kind: DatabaseKind;
  name: string;
  password: string;
  version?: string;
}): { connectionUrl: string; injectEnv: Record<string, string> } {
  const host = `paas-db-${opts.name}`;
  const preset = DATABASE_PRESETS[opts.kind];
  const password = opts.password;

  switch (opts.kind) {
    case "postgres": {
      const url = `postgres://paas:${password}@${host}:5432/paas`;
      return { connectionUrl: url, injectEnv: { DATABASE_URL: url } };
    }
    case "mysql":
    case "mariadb": {
      const url = `mysql://paas:${password}@${host}:3306/paas`;
      return { connectionUrl: url, injectEnv: { DATABASE_URL: url } };
    }
    case "redis": {
      const url = `redis://:${password}@${host}:6379`;
      return { connectionUrl: url, injectEnv: { REDIS_URL: url } };
    }
    case "mongodb": {
      const url = `mongodb://paas:${password}@${host}:27017/paas?authSource=admin`;
      return { connectionUrl: url, injectEnv: { MONGO_URL: url, MONGODB_URI: url } };
    }
    case "minio": {
      const endpoint = `http://${host}:9000`;
      return {
        connectionUrl: endpoint,
        injectEnv: {
          S3_ENDPOINT: endpoint,
          S3_ACCESS_KEY: "paas",
          S3_SECRET_KEY: password,
          MINIO_ROOT_USER: "paas",
          MINIO_ROOT_PASSWORD: password,
        },
      };
    }
    default:
      return {
        connectionUrl: `postgres://paas:${password}@${host}:${preset.port}/paas`,
        injectEnv: {},
      };
  }
}

export const SignupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(80),
});
export type SignupInput = z.infer<typeof SignupSchema>;

export const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const SelectPlanSchema = z.object({
  plan: PlanId,
});
export type SelectPlanInput = z.infer<typeof SelectPlanSchema>;

export const CreateProjectSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "lowercase letters, numbers, hyphens"),
  repoUrl: z.string().url().or(z.literal("")).default(""),
  branch: z.string().min(1).default("main"),
  dockerfilePath: z.string().min(1).default("Dockerfile"),
  buildContext: z.string().min(1).default("."),
  port: z.number().int().min(1).max(65535).default(3000),
  env: z.record(z.string()).default({}),
  memoryLimitBytes: z.number().int().positive().optional(),
  cpuNanoCpus: z.number().int().positive().optional(),
  autoDeploy: z.boolean().default(true),
  deployNow: z.boolean().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = CreateProjectSchema.partial().omit({
  name: true,
  deployNow: true,
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

export const CreateDatabaseSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  kind: DatabaseKind,
  projectId: z.string().uuid().optional(),
  version: z.string().min(1).optional(),
  memoryMb: z.number().int().positive().max(8192).optional(),
  cpu: z.number().positive().max(8).optional(),
});
export type CreateDatabaseInput = z.infer<typeof CreateDatabaseSchema>;

export const TriggerDeploySchema = z.object({
  commitSha: z.string().optional(),
  triggeredBy: z.enum(["manual", "webhook", "redeploy"]).default("manual"),
});
export type TriggerDeployInput = z.infer<typeof TriggerDeploySchema>;

export type User = {
  id: string;
  email: string;
  name: string;
  plan: PlanId;
  onboardingCompleted: boolean;
  createdAt: string;
};

export type Project = {
  id: string;
  ownerId: string | null;
  name: string;
  repoUrl: string;
  branch: string;
  dockerfilePath: string;
  buildContext: string;
  port: number;
  env: Record<string, string>;
  status: ProjectStatus;
  containerId: string | null;
  imageTag: string | null;
  previousImageTag: string | null;
  hostname: string;
  memoryLimitBytes: number;
  cpuNanoCpus: number;
  autoDeploy: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Deploy = {
  id: string;
  projectId: string;
  commitSha: string | null;
  status: DeployStatus;
  triggeredBy: string;
  imageTag: string | null;
  log: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ManagedDatabase = {
  id: string;
  ownerId: string | null;
  name: string;
  kind: DatabaseKind;
  projectId: string | null;
  containerId: string | null;
  volumeName: string;
  connectionUrl: string;
  status: "provisioning" | "running" | "stopped" | "error";
  config: {
    version?: string;
    memoryMb?: number;
    cpu?: number;
    image?: string;
  };
  createdAt: string;
};

export type Job = {
  id: string;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResourceMetrics = {
  available: boolean;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  sampledAt: string;
};

export type UsageSummary = {
  plan: Plan;
  projectsUsed: number;
  projectsLimit: number;
  databasesUsed: number;
  databasesLimit: number;
  reservedMemoryBytes: number;
  reservedCpuNano: number;
  runningServices: number;
  deploysLast24h: number;
  failedDeploysLast24h: number;
  recentDeploys: Array<{
    id: string;
    projectName: string;
    status: DeployStatus;
    triggeredBy: string;
    createdAt: string;
  }>;
};

export function slugHostname(projectName: string, publicHost: string): string {
  return `${projectName}.${publicHost}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
