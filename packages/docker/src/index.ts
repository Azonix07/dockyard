import Dockerode from "dockerode";
import tar from "tar-fs";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ignore from "ignore";

export type DockerClientOptions = {
  socketPath?: string;
  host?: string;
};

/** Resolve dockerode options from DOCKER_HOST / explicit opts. */
export function createDocker(opts: DockerClientOptions = {}): Dockerode {
  if (opts.host) {
    return new Dockerode({ host: opts.host });
  }

  const raw = opts.socketPath ?? process.env.DOCKER_HOST ?? "";
  if (!raw || raw === "/var/run/docker.sock" || raw.startsWith("/")) {
    const socketPath =
      !raw || raw === ""
        ? "/var/run/docker.sock"
        : raw.replace(/^unix:\/\//, "");
    return new Dockerode({ socketPath });
  }

  if (raw.startsWith("unix://")) {
    return new Dockerode({ socketPath: raw.replace(/^unix:\/\//, "") });
  }

  if (raw.startsWith("tcp://") || raw.startsWith("http://") || raw.startsWith("https://")) {
    const u = new URL(raw.replace(/^tcp:\/\//, "http://"));
    return new Dockerode({
      host: u.hostname,
      port: Number(u.port || 2375),
      protocol: u.protocol.replace(":", "") as "http" | "https",
    });
  }

  return new Dockerode({ socketPath: raw });
}

export type RunContainerSpec = {
  name: string;
  image: string;
  env: Record<string, string>;
  network: string;
  extraNetworks?: string[];
  port: number;
  memoryLimitBytes: number;
  cpuNanoCpus: number;
  labels?: Record<string, string>;
  cmd?: string[];
  volumes?: Array<{ name: string; containerPath: string }>;
  /** If false, do not remove an existing container with the same name first. */
  replaceExisting?: boolean;
};

function envList(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

export async function ensureNetwork(docker: Dockerode, name: string): Promise<void> {
  try {
    await docker.getNetwork(name).inspect();
  } catch {
    try {
      await docker.createNetwork({ Name: name, CheckDuplicate: true, Driver: "bridge" });
    } catch (err) {
      // Race: another process created it
      try {
        await docker.getNetwork(name).inspect();
      } catch {
        throw err;
      }
    }
  }
}

export async function ensureVolume(docker: Dockerode, name: string): Promise<void> {
  try {
    await docker.getVolume(name).inspect();
  } catch {
    await docker.createVolume({ Name: name });
  }
}

export async function removeContainerIfExists(
  docker: Dockerode,
  name: string,
): Promise<void> {
  try {
    const c = docker.getContainer(name);
    await c.inspect();
    try {
      await c.stop({ t: 10 });
    } catch {
      /* already stopped */
    }
    await c.remove({ force: true });
  } catch {
    /* missing */
  }
}

export async function containerExists(
  docker: Dockerode,
  name: string,
): Promise<boolean> {
  try {
    await docker.getContainer(name).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function pullImage(
  docker: Dockerode,
  image: string,
  onLog?: (line: string) => void,
): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
      (event: { status?: string; progress?: string; error?: string }) => {
        if (event.error) {
          onLog?.(event.error);
          return;
        }
        const line = [event.status, event.progress].filter(Boolean).join(" ").trim();
        if (line) onLog?.(line);
      },
    );
  });
}

function loadDockerignore(contextDir: string) {
  const ig = ignore();
  ig.add([".git", "node_modules", ".next", "dist", ".env", ".env.*"]);
  const dockerignore = join(contextDir, ".dockerignore");
  if (existsSync(dockerignore)) {
    ig.add(readFileSync(dockerignore, "utf8"));
  }
  return ig;
}

export async function buildImage(
  docker: Dockerode,
  contextDir: string,
  dockerfilePath: string,
  tags: string[],
  onLog: (line: string) => void,
): Promise<void> {
  if (!tags[0]) throw new Error("At least one image tag is required");

  const ig = loadDockerignore(contextDir);
  const pack = tar.pack(contextDir, {
    ignore: (name: string) => {
      const rel = relative(contextDir, name);
      if (!rel || rel === ".") return false;
      return ig.ignores(rel);
    },
  }) as unknown as NodeJS.ReadableStream;

  let buildFailed: string | null = null;
  const stream = (await docker.buildImage(pack, {
    dockerfile: dockerfilePath,
    t: tags[0],
  } as Dockerode.ImageBuildOptions)) as NodeJS.ReadableStream;

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream as Parameters<Dockerode["modem"]["followProgress"]>[0],
      (err: Error | null) => {
        if (err) reject(err);
        else if (buildFailed) reject(new Error(buildFailed));
        else resolve();
      },
      (event: {
        stream?: string;
        error?: string;
        errorDetail?: { message?: string };
        status?: string;
        progress?: string;
      }) => {
        if (event.error || event.errorDetail?.message) {
          buildFailed = event.error ?? event.errorDetail?.message ?? "build failed";
          onLog(buildFailed);
          return;
        }
        const line = [event.stream, event.status, event.progress]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (line) onLog(line);
      },
    );
  });

  if (!(await imageExists(docker, tags[0]))) {
    throw new Error(`Build finished but image ${tags[0]} was not created`);
  }

  for (const tag of tags.slice(1)) {
    try {
      await tagImage(docker, tags[0], tag);
    } catch (err) {
      onLog(
        `Warning: failed to tag ${tag}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export async function runContainer(
  docker: Dockerode,
  spec: RunContainerSpec,
): Promise<string> {
  if (spec.replaceExisting !== false) {
    await removeContainerIfExists(docker, spec.name);
  }

  const binds =
    spec.volumes?.map((v) => `${v.name}:${v.containerPath}`) ?? undefined;

  const container = await docker.createContainer({
    name: spec.name,
    Image: spec.image,
    Env: envList(spec.env),
    Cmd: spec.cmd,
    Labels: {
      "laptop-paas.managed": "true",
      ...spec.labels,
    },
    HostConfig: {
      NetworkMode: spec.network,
      Memory: spec.memoryLimitBytes,
      NanoCpus: spec.cpuNanoCpus,
      RestartPolicy: { Name: "unless-stopped" },
      Binds: binds,
    },
    ExposedPorts: {
      [`${spec.port}/tcp`]: {},
    },
  });

  await container.start();

  for (const netName of spec.extraNetworks ?? []) {
    try {
      await docker.getNetwork(netName).connect({ Container: container.id });
    } catch {
      /* already attached */
    }
  }

  return container.id;
}

export async function stopContainer(docker: Dockerode, idOrName: string): Promise<void> {
  const c = docker.getContainer(idOrName);
  try {
    await c.stop({ t: 10 });
  } catch {
    /* ignore */
  }
}

export async function startContainer(docker: Dockerode, idOrName: string): Promise<void> {
  const c = docker.getContainer(idOrName);
  await c.start();
}

export async function renameContainer(
  docker: Dockerode,
  idOrName: string,
  newName: string,
): Promise<void> {
  await docker.getContainer(idOrName).rename({ name: newName });
}

export async function containerLogs(
  docker: Dockerode,
  idOrName: string,
  tail = 200,
): Promise<string> {
  const c = docker.getContainer(idOrName);
  const buf = await c.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  });
  return demuxDockerLogs(buf);
}

export function demuxDockerLogs(buf: Buffer | string): string {
  if (typeof buf === "string") return buf;
  if (buf.length === 0) return "";
  if (buf[0] > 2 || buf.length < 8) {
    return buf.toString("utf8");
  }
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buf.length) break;
    parts.push(buf.subarray(start, end).toString("utf8"));
    offset = end;
  }
  return parts.join("") || buf.toString("utf8");
}

export async function writeCaddyfile(
  path: string,
  routes: Array<{ hostname: string; name: string; upstream: string }>,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const hostBlocks = routes.map(
    (r) => `http://${r.hostname} {
  reverse_proxy ${r.upstream}
}
`,
  );
  const pathHandlers = routes
    .map(
      (r) => `  @${r.name.replace(/-/g, "_")} path /p/${r.name} /p/${r.name}/*
  handle @${r.name.replace(/-/g, "_")} {
    uri strip_prefix /p/${r.name}
    reverse_proxy ${r.upstream}
  }`,
    )
    .join("\n");
  const content =
    `# Generated by laptop-paas — do not edit by hand\n` +
    `{\n  auto_https off\n  admin 0.0.0.0:2019\n}\n\n` +
    hostBlocks.join("\n") +
    `\n:80 {\n` +
    (pathHandlers
      ? `${pathHandlers}\n  respond "Dockyard proxy — use /p/<project>/ or Host: <project>.<PUBLIC_HOST>" 200\n`
      : `  respond "Dockyard proxy ready" 200\n`) +
    `}\n`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content, "utf8");
}

/** Ask Caddy to reload config (more reliable than --watch across volumes). */
export async function reloadCaddyFromFile(
  caddyfilePath: string,
  adminUrl = process.env.CADDY_ADMIN_URL ?? "http://caddy:2019",
): Promise<void> {
  try {
    const body = readFileSync(caddyfilePath, "utf8");
    const res = await fetch(`${adminUrl}/load`, {
      method: "POST",
      headers: {
        "Content-Type": "text/caddyfile",
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`Caddy reload failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.warn(
      "Caddy reload skipped:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function pruneDanglingImages(docker: Dockerode): Promise<void> {
  try {
    await docker.pruneImages({ dangling: true });
  } catch {
    /* ignore */
  }
}

export async function removeVolumeIfExists(
  docker: Dockerode,
  name: string,
): Promise<void> {
  try {
    await docker.getVolume(name).remove();
  } catch {
    /* ignore */
  }
}

export async function tagImage(
  docker: Dockerode,
  source: string,
  target: string,
): Promise<void> {
  const [repo, tag] = splitRepoTag(target);
  const img = docker.getImage(source);
  await img.tag({ repo, tag });
}

function splitRepoTag(ref: string): [string, string] {
  const idx = ref.lastIndexOf(":");
  if (idx <= 0) return [ref, "latest"];
  return [ref.slice(0, idx), ref.slice(idx + 1)];
}

export async function imageExists(docker: Dockerode, ref: string): Promise<boolean> {
  try {
    await docker.getImage(ref).inspect();
    return true;
  } catch {
    return false;
  }
}

export type ContainerResourceStats = {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
};

/** One-shot Docker stats sample (Railway/Render-style resource metrics). */
export async function containerStats(
  docker: Dockerode,
  idOrName: string,
): Promise<ContainerResourceStats> {
  const stats = (await docker.getContainer(idOrName).stats({ stream: false })) as {
    cpu_stats?: {
      cpu_usage?: { total_usage?: number };
      system_cpu_usage?: number;
      online_cpus?: number;
    };
    precpu_stats?: {
      cpu_usage?: { total_usage?: number };
      system_cpu_usage?: number;
    };
    memory_stats?: { usage?: number; limit?: number };
    networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
    blkio_stats?: {
      io_service_bytes_recursive?: Array<{ op?: string; value?: number }>;
    };
  };

  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage ?? 0) -
    (stats.precpu_stats?.system_cpu_usage ?? 0);
  const online = stats.cpu_stats?.online_cpus ?? 1;
  const cpuPercent =
    systemDelta > 0 && cpuDelta > 0
      ? (cpuDelta / systemDelta) * online * 100
      : 0;

  const memoryUsedBytes = stats.memory_stats?.usage ?? 0;
  const memoryLimitBytes = stats.memory_stats?.limit ?? 0;
  const memoryPercent =
    memoryLimitBytes > 0 ? (memoryUsedBytes / memoryLimitBytes) * 100 : 0;

  let netRxBytes = 0;
  let netTxBytes = 0;
  for (const n of Object.values(stats.networks ?? {})) {
    netRxBytes += n.rx_bytes ?? 0;
    netTxBytes += n.tx_bytes ?? 0;
  }

  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  for (const row of stats.blkio_stats?.io_service_bytes_recursive ?? []) {
    const op = (row.op ?? "").toLowerCase();
    if (op === "read") blockReadBytes += row.value ?? 0;
    if (op === "write") blockWriteBytes += row.value ?? 0;
  }

  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryUsedBytes,
    memoryLimitBytes,
    memoryPercent: Math.round(memoryPercent * 100) / 100,
    netRxBytes,
    netTxBytes,
    blockReadBytes,
    blockWriteBytes,
  };
}
