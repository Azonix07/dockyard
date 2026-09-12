import { Octokit } from "@octokit/rest";
import type { RepoAnalysis, ServiceRole } from "@laptop-paas/shared";
import { parseRepo } from "./github.js";

type GhFile = { path: string; type: string };

async function listTreePaths(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<string[]> {
  try {
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${ref}`,
    });
    const sha = refData.object.sha;
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: sha,
      recursive: "true",
    });
    return (data.tree as GhFile[])
      .filter((t) => t.type === "blob" && t.path)
      .map((t) => t.path);
  } catch {
    return [];
  }
}

async function readFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return null;
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function pickDockerfile(paths: string[], role: ServiceRole): string | null {
  const dockerfiles = paths.filter(
    (p) => /(^|\/)Dockerfile$/i.test(p) || /(^|\/)Dockerfile\.[^/]+$/i.test(p),
  );
  if (dockerfiles.length === 0) return null;
  const prefer =
    role === "api"
      ? [/apps\/api\/Dockerfile/i, /api\/Dockerfile/i, /backend\/Dockerfile/i, /^Dockerfile$/i]
      : role === "web"
        ? [/apps\/web\/Dockerfile/i, /frontend\/Dockerfile/i, /web\/Dockerfile/i, /^Dockerfile$/i]
        : role === "worker"
          ? [/apps\/worker\/Dockerfile/i, /worker\/Dockerfile/i, /^Dockerfile$/i]
          : [/^Dockerfile$/i, /apps\/api\/Dockerfile/i, /apps\/web\/Dockerfile/i];
  for (const re of prefer) {
    const hit = dockerfiles.find((p) => re.test(p));
    if (hit) return hit;
  }
  return dockerfiles[0] ?? null;
}

function parseExpose(dockerfile: string): number | null {
  const m = dockerfile.match(/^\s*EXPOSE\s+(\d+)/im);
  return m ? Number(m[1]) : null;
}

function detectFromPackageJson(pkgRaw: string | null): {
  framework: string | null;
  role: ServiceRole;
  port: number;
  startCommand: string | null;
} {
  if (!pkgRaw) {
    return { framework: null, role: "full", port: 3000, startCommand: null };
  }
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    return { framework: null, role: "full", port: 3000, startCommand: null };
  }
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  const scripts = pkg.scripts ?? {};
  const startCommand =
    scripts.start ??
    (scripts["start:prod"] ? `npm run start:prod` : null) ??
    null;

  if (deps.next) {
    return {
      framework: "Next.js",
      role: "web",
      port: 3000,
      startCommand: startCommand ?? "npm run start",
    };
  }
  if (deps["@nestjs/core"] || deps.nest) {
    return {
      framework: "NestJS",
      role: "api",
      port: 3000,
      startCommand: startCommand ?? "node dist/main.js",
    };
  }
  if (deps.fastify || deps["@fastify/cors"]) {
    return {
      framework: "Fastify",
      role: "api",
      port: 8080,
      startCommand: startCommand ?? "npm run start",
    };
  }
  if (deps.express) {
    return {
      framework: "Express",
      role: "api",
      port: 3000,
      startCommand: startCommand ?? "npm run start",
    };
  }
  if (deps.django || deps.flask || deps.fastapi) {
    return {
      framework: deps.fastapi ? "FastAPI" : deps.flask ? "Flask" : "Django",
      role: "api",
      port: 8000,
      startCommand,
    };
  }
  if (scripts.start || scripts.build) {
    return {
      framework: "Node.js",
      role: "full",
      port: 3000,
      startCommand: startCommand ?? "npm run start",
    };
  }
  return { framework: null, role: "full", port: 3000, startCommand };
}

function parseProcfile(raw: string | null): string | null {
  if (!raw) return null;
  const web = raw.split("\n").find((l) => l.trim().startsWith("web:"));
  if (!web) return null;
  return web.replace(/^web:\s*/, "").trim() || null;
}

export async function analyzeRepository(
  octokit: Octokit,
  repoUrl: string,
  branch: string,
  preferredRole?: ServiceRole | null,
): Promise<RepoAnalysis> {
  const parsed = parseRepo(repoUrl);
  if (!parsed) {
    throw new Error("Only GitHub repositories can be analyzed");
  }
  const { owner, repo } = parsed;
  const paths = await listTreePaths(octokit, owner, repo, branch);
  const notes: string[] = [];
  const detectedFiles: string[] = [];

  const interesting = [
    "package.json",
    "Dockerfile",
    "Procfile",
    "docker-compose.yml",
    "compose.yaml",
    "requirements.txt",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
  ];
  for (const f of interesting) {
    if (paths.some((p) => p === f || p.endsWith(`/${f}`))) detectedFiles.push(f);
  }

  const pkgPath =
    paths.find((p) => p === "package.json") ??
    paths.find((p) => p === "apps/api/package.json") ??
    paths.find((p) => p === "apps/web/package.json") ??
    null;
  const pkgRaw = pkgPath
    ? await readFile(octokit, owner, repo, pkgPath, branch)
    : null;
  if (pkgPath) detectedFiles.push(pkgPath);

  const detected = detectFromPackageJson(pkgRaw);
  const role = preferredRole && preferredRole !== "full" ? preferredRole : detected.role;

  const dockerfilePath = pickDockerfile(paths, role);
  let port = detected.port;
  let buildContext = ".";
  let hasDockerfile = Boolean(dockerfilePath);
  let finalDockerfile = dockerfilePath ?? "Dockerfile";

  if (dockerfilePath) {
    const df = await readFile(octokit, owner, repo, dockerfilePath, branch);
    const exposed = df ? parseExpose(df) : null;
    if (exposed) port = exposed;
    const dir = dockerfilePath.includes("/")
      ? dockerfilePath.replace(/\/[^/]+$/, "")
      : ".";
    buildContext = dir === "" ? "." : dir;
    // docker build -f is relative to the build context directory
    const prefix = buildContext === "." ? "" : `${buildContext}/`;
    finalDockerfile = dockerfilePath.startsWith(prefix)
      ? dockerfilePath.slice(prefix.length)
      : dockerfilePath;
    notes.push(`Found Dockerfile at ${dockerfilePath}`);
  }

  const proc = await readFile(octokit, owner, repo, "Procfile", branch);
  const procCmd = parseProcfile(proc);
  const startCommand = detected.startCommand ?? procCmd;

  // Role-specific path nudges when no Dockerfile
  if (!dockerfilePath && role === "api") {
    if (paths.includes("apps/api/package.json")) {
      buildContext = "apps/api";
      notes.push("No Dockerfile — will generate a Node API image from apps/api");
    } else {
      notes.push("No Dockerfile — will generate a Node API image from repo root");
    }
  } else if (!dockerfilePath && role === "web") {
    if (paths.includes("apps/web/package.json")) {
      buildContext = "apps/web";
      notes.push("No Dockerfile — will generate a Node web image from apps/web");
    } else {
      notes.push("No Dockerfile — will generate a Node web image from repo root");
    }
  } else if (!dockerfilePath) {
    notes.push("No Dockerfile found — Runbase will generate one for Node deploys");
  }

  if (detected.framework) {
    notes.push(`Detected ${detected.framework} → hosting as ${role}`);
  }
  if (role === "api") {
    notes.push("Backend self-host: PORT is injected; link a database for DATABASE_URL");
  }

  const willGenerateDockerfile = !hasDockerfile && Boolean(startCommand || pkgRaw);
  if (willGenerateDockerfile) {
    finalDockerfile = ".dockyard/Dockerfile";
  }

  const suggestedEnv: Record<string, string> = {
    NODE_ENV: "production",
  };
  if (role === "api" || role === "full") {
    suggestedEnv.HOST = "0.0.0.0";
  }

  return {
    framework: detected.framework,
    serviceRole: role,
    port,
    dockerfilePath: finalDockerfile,
    buildContext,
    startCommand,
    hasDockerfile,
    willGenerateDockerfile,
    notes,
    suggestedEnv,
    detectedFiles: [...new Set(detectedFiles)],
  };
}
