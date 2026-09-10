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

export const DatabaseKind = z.enum(["postgres", "redis"]);
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
    description: "For side projects and learning on your own laptop.",
    features: [
      "Up to 5 projects",
      "512 MB RAM per service",
      "1 shared vCPU",
      "Postgres & Redis",
      "GitHub auto-deploy",
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
    description: "Higher limits for serious apps on your cafe host.",
    features: [
      "Up to 25 projects",
      "2 GB RAM per service",
      "2 shared vCPU",
      "Priority deploy queue",
      "Everything in Hobby",
    ],
    maxProjects: 25,
    maxDatabases: 25,
    defaultMemoryBytes: 2147483648,
    defaultCpuNano: 2_000_000_000,
  },
} as const;

export type Plan = (typeof PLANS)[PlanId];

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
  repoUrl: z
    .string()
    .url()
    .or(z.literal(""))
    .default(""),
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

export function slugHostname(projectName: string, publicHost: string): string {
  return `${projectName}.${publicHost}`;
}
