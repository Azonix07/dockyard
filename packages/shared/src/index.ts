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

/** Hard caps per plan (create/update cannot exceed these). */
export function planResourceCaps(planId: PlanId): {
  maxMemoryBytes: number;
  maxCpuNano: number;
} {
  const plan = PLANS[planId];
  if (planId === "pro") {
    return {
      maxMemoryBytes: 4 * 1024 ** 3,
      maxCpuNano: 4_000_000_000,
    };
  }
  return {
    maxMemoryBytes: plan.defaultMemoryBytes,
    maxCpuNano: plan.defaultCpuNano,
  };
}

export function clampResourcesToPlan(
  planId: PlanId,
  memory?: number,
  cpu?: number,
): { memory: number; cpu: number } {
  const plan = PLANS[planId];
  const caps = planResourceCaps(planId);
  const memoryOut = Math.min(
    Math.max(memory ?? plan.defaultMemoryBytes, 64 * 1024 * 1024),
    caps.maxMemoryBytes,
  );
  const cpuOut = Math.min(
    Math.max(cpu ?? plan.defaultCpuNano, 100_000_000),
    caps.maxCpuNano,
  );
  return { memory: memoryOut, cpu: cpuOut };
}

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

export const ServiceRole = z.enum(["web", "api", "worker", "full"]);
export type ServiceRole = z.infer<typeof ServiceRole>;

export const SafeRelPath = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (p) =>
      !p.includes("\0") &&
      !p.split(/[/\\]/).some((seg) => seg === "..") &&
      !p.startsWith("/") &&
      !/^[a-zA-Z]:/.test(p),
    "Path must be relative and must not contain '..'",
  );

export const GitHubRepoUrl = z
  .string()
  .max(512)
  .refine((v) => {
    if (!v) return true;
    try {
      const u = new URL(v);
      return (
        (u.protocol === "https:" || u.protocol === "http:") &&
        (u.hostname === "github.com" || u.hostname === "www.github.com")
      );
    } catch {
      return false;
    }
  }, "Only github.com repository URLs are allowed");

export const CreateProjectSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "lowercase letters, numbers, hyphens"),
  repoUrl: GitHubRepoUrl.or(z.literal("")).default(""),
  branch: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\s]+$/, "invalid branch")
    .default("main"),
  dockerfilePath: SafeRelPath.default("Dockerfile"),
  buildContext: SafeRelPath.default("."),
  port: z.number().int().min(1).max(65535).default(3000),
  env: z.record(z.string().max(8192)).default({}),
  memoryLimitBytes: z.number().int().positive().max(16 * 1024 ** 3).optional(),
  cpuNanoCpus: z.number().int().positive().max(8_000_000_000).optional(),
  autoDeploy: z.boolean().default(true),
  deployNow: z.boolean().optional(),
  serviceRole: ServiceRole.default("full"),
  startCommand: z.string().max(512).nullable().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = CreateProjectSchema.partial().omit({
  name: true,
  deployNow: true,
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

export type RepoAnalysis = {
  framework: string | null;
  serviceRole: ServiceRole;
  port: number;
  dockerfilePath: string;
  buildContext: string;
  startCommand: string | null;
  hasDockerfile: boolean;
  willGenerateDockerfile: boolean;
  notes: string[];
  suggestedEnv: Record<string, string>;
  detectedFiles: string[];
};

/** Dockerfile written into the clone when the repo has none. */
export function generatedNodeDockerfile(opts: {
  port: number;
  startCommand: string | null;
}): string {
  const cmd = opts.startCommand?.trim() || "npm run start";
  const cmdJson = JSON.stringify(["sh", "-c", cmd]);
  return `# Generated by Runbase — Node production image
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${opts.port}
ENV HOST=0.0.0.0
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then npm i -g pnpm && pnpm i --frozen-lockfile || pnpm i; \\
  elif [ -f yarn.lock ]; then yarn install --frozen-lockfile || yarn install; \\
  elif [ -f package-lock.json ]; then npm ci || npm install; \\
  else npm install; fi
COPY . .
RUN npm run build --if-present
EXPOSE ${opts.port}
CMD ${cmdJson}
`;
}

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

export type GitHubRepo = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  description: string | null;
  updatedAt: string | null;
};

export type GitHubStatus = {
  configured: boolean;
  connected: boolean;
  login: string | null;
  canListViaHostToken: boolean;
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
  serviceRole: ServiceRole;
  startCommand: string | null;
  vercelProjectId: string | null;
  vercelProjectName: string | null;
  vercelProjectUrl: string | null;
  vercelEnvKey: string | null;
  vercelLinkedAt: string | null;
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

/** Platform-wide snapshot for the super-admin console. */
export type AdminHostInfo = {
  available: boolean;
  name: string | null;
  dockerVersion: string | null;
  ncpu: number | null;
  memTotalBytes: number | null;
  containers: number | null;
  containersRunning: number | null;
  containersPaused: number | null;
  containersStopped: number | null;
  images: number | null;
  driver: string | null;
  operatingSystem: string | null;
  architecture: string | null;
  paasContainers: number | null;
};

export type DeviceHealthStatus = "healthy" | "warning" | "critical" | "unknown";

export type ElectricityPeriod = {
  kwh: number;
  energyInr: number;
  fixedInr: number;
  surchargeInr: number;
  totalInr: number;
  effectiveRateInrPerKwh: number;
};

export type KeralaElectricityEstimate = {
  tariffId: string;
  tariffLabel: string;
  authority: string;
  effectiveFrom: string;
  effectiveTo: string;
  avgWatts: number;
  measuredHours: number | null;
  extrapolated: boolean;
  summerSurchargeApplied: boolean;
  slabRateInrPerKwh: number;
  connectedLoadKw: number;
  phase: "single" | "three";
  daily: ElectricityPeriod;
  weekly: ElectricityPeriod;
  monthly: ElectricityPeriod;
  notes: string[];
  sourceNote: string;
  /** Raw sample windows used for avg watts */
  kwhLast1h: number | null;
  kwhLast24h: number | null;
  avgWattsLast1h: number | null;
  avgWattsLast24h: number | null;
};

export type UserElectricityShare = {
  userId: string | null;
  email: string;
  name: string;
  plan: PlanId | null;
  projectCount: number;
  databaseCount: number;
  reservedMemoryBytes: number;
  sharePercent: number;
  avgWatts: number;
  dailyKwh: number;
  weeklyKwh: number;
  monthlyKwh: number;
  dailyInr: number;
  weeklyInr: number;
  monthlyInr: number;
};

export type DeviceHealth = {
  available: boolean;
  sampledAt: string | null;
  staleSeconds: number | null;
  status: DeviceHealthStatus;
  score: number;
  issues: string[];
  device: {
    model: string | null;
    cpu: string | null;
    cores: number | null;
    logicalProcessors: number | null;
    ramBytes: number | null;
  } | null;
  temperatures: {
    thermalZoneC: number | null;
    gpuC: number | null;
    cpuLoadPct: number | null;
  };
  memory: {
    usedBytes: number | null;
    totalBytes: number | null;
    usedPercent: number | null;
    committedPercent: number | null;
  };
  power: {
    onAc: boolean | null;
    charging: boolean | null;
    discharging: boolean | null;
    batteryPercent: number | null;
    watts: number | null;
    source: string | null;
    electricity: KeralaElectricityEstimate;
  };
  gpu: {
    name: string | null;
    tempC: number | null;
    powerWatts: number | null;
    utilizationPct: number | null;
    memoryUsedMiB: number | null;
    memoryTotalMiB: number | null;
  } | null;
  disks: Array<{
    name: string;
    mediaType: string;
    health: string;
    status: string;
    sizeBytes: number;
  }>;
  diskTimePercent: number | null;
  clocks: {
    currentMhz: number | null;
    maxMhz: number | null;
  };
};

export type AdminOverview = {
  generatedAt: string;
  accounts: {
    total: number;
    hobby: number;
    pro: number;
    withGithub: number;
    newLast7d: number;
  };
  fleet: {
    projects: number;
    running: number;
    failed: number;
    deploying: number;
    idle: number;
    stopped: number;
    databases: number;
    databasesRunning: number;
    reservedMemoryBytes: number;
    reservedCpuNano: number;
  };
  activity: {
    deploysLast24h: number;
    failedDeploysLast24h: number;
    deploysLast7d: number;
    jobsQueued: number;
    jobsRunning: number;
    jobsFailed: number;
  };
  host: AdminHostInfo;
  recentDeploys: Array<{
    id: string;
    projectName: string;
    ownerEmail: string | null;
    status: DeployStatus;
    triggeredBy: string;
    createdAt: string;
    error: string | null;
  }>;
  recentAccounts: Array<{
    id: string;
    email: string;
    name: string;
    plan: PlanId;
    createdAt: string;
  }>;
};

export type AdminAccount = {
  id: string;
  email: string;
  name: string;
  plan: PlanId;
  onboardingCompleted: boolean;
  createdAt: string;
  githubLogin: string | null;
  projectCount: number;
  databaseCount: number;
  runningProjects: number;
  lastDeployAt: string | null;
};

export type AdminProjectRow = {
  id: string;
  name: string;
  status: ProjectStatus;
  hostname: string;
  repoUrl: string;
  ownerId: string | null;
  ownerEmail: string | null;
  memoryLimitBytes: number;
  cpuNanoCpus: number;
  updatedAt: string;
};

export type AdminDatabaseRow = {
  id: string;
  name: string;
  kind: DatabaseKind;
  status: string;
  ownerId: string | null;
  ownerEmail: string | null;
  projectId: string | null;
  projectName: string | null;
  createdAt: string;
};

export const UpdateAdminAccountSchema = z.object({
  plan: PlanId.optional(),
  onboardingCompleted: z.boolean().optional(),
});
export type UpdateAdminAccountInput = z.infer<typeof UpdateAdminAccountSchema>;

export type VercelStatus = {
  configured: boolean;
  connected: boolean;
  username: string | null;
  teamId: string | null;
};

export type VercelProject = {
  id: string;
  name: string;
  framework: string | null;
  accountId: string | null;
  updatedAt: number | null;
  link?: { type?: string; repo?: string } | null;
};

export const LinkVercelProjectSchema = z.object({
  vercelProjectId: z.string().min(1),
  envKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default("NEXT_PUBLIC_API_URL"),
  backendUrl: z.string().url().optional(),
  redeploy: z.boolean().default(true),
});
export type LinkVercelProjectInput = z.infer<typeof LinkVercelProjectSchema>;

export function slugHostname(projectName: string, publicHost: string): string {
  return `${projectName}.${publicHost}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
