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

export const CreateProjectSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "lowercase letters, numbers, hyphens"),
  repoUrl: z.string().url(),
  branch: z.string().min(1).default("main"),
  dockerfilePath: z.string().min(1).default("Dockerfile"),
  buildContext: z.string().min(1).default("."),
  port: z.number().int().min(1).max(65535).default(3000),
  env: z.record(z.string()).default({}),
  memoryLimitBytes: z.number().int().positive().optional(),
  cpuNanoCpus: z.number().int().positive().optional(),
  autoDeploy: z.boolean().default(true),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = CreateProjectSchema.partial().omit({
  name: true,
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

export type Project = {
  id: string;
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
