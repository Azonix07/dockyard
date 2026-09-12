import Dockerode from "dockerode";
import tar from "tar-fs";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
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

let sharedDocker: Dockerode | null = null;

/**
 * Process-wide Docker client. Dockerode keeps an HTTP agent per instance, so
 * creating one per request (the API used to) means a new unix socket handshake
 * on every metrics/log call. Reuse one and keep the sockets alive.
 */
export function getDocker(): Dockerode {
  if (!sharedDocker) sharedDocker = createDocker();
  return sharedDocker;
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
  const dfNorm = dockerfilePath.replace(/^\.\//, "");
  const pack = tar.pack(contextDir, {
    ignore: (name: string) => {
      const rel = relative(contextDir, name).replace(/\\/g, "/");
      if (!rel || rel === ".") return false;
      // Dockerfile (and its parent dirs) must stay in the build context.
      if (rel === dfNorm || dfNorm.startsWith(`${rel}/`)) return false;
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
      PidsLimit: 512,
      SecurityOpt: ["no-new-privileges:true"],
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

export async function stopContainer(
  docker: Dockerode,
  idOrName: string,
  timeoutSec = 10,
): Promise<void> {
  const c = docker.getContainer(idOrName);
  try {
    await c.stop({ t: timeoutSec });
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

export type ProxyRoute = {
  hostname: string;
  name: string;
  /** host:port reachable from the Caddy container, e.g. paas-app-foo:3000 */
  upstream: string;
};

export type CaddyfileOptions = {
  /** Platform API upstream, exposed at /api/* on the proxy port. */
  apiUpstream?: string | null;
  /** Dashboard upstream, used as the catch-all on the proxy port. */
  webUpstream?: string | null;
  /**
   * How long Caddy holds a request while an upstream is unreachable
   * (container restarting / redeploying) before giving up.
   */
  tryDurationSec?: number;
};

function matcherName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Shared reverse_proxy body.
 *
 * The important parts for a laptop host:
 *  - `lb_try_duration` + `lb_try_interval` make Caddy *hold* a request while the
 *    container is restarting instead of instantly answering 502.
 *  - `fail_duration 0` keeps passive health checking off. With a single upstream,
 *    ejecting it on one error guarantees 502s for everything that follows.
 *  - `request_buffers` lets Caddy replay POST/PUT bodies during those retries.
 *  - keepalive settings stop us paying a TCP handshake per request.
 */
function proxyBody(upstream: string, tryDurationSec: number, indent: string): string {
  const i = indent;
  return [
    `${i}reverse_proxy ${upstream} {`,
    `${i}  lb_try_duration ${tryDurationSec}s`,
    `${i}  lb_try_interval 250ms`,
    `${i}  fail_duration 0`,
    `${i}  request_buffers 512KB`,
    `${i}  transport http {`,
    `${i}    dial_timeout 5s`,
    `${i}    response_header_timeout 120s`,
    `${i}    keepalive 2m`,
    `${i}    keepalive_idle_conns 64`,
    `${i}    keepalive_idle_conns_per_host 32`,
    `${i}  }`,
    `${i}  header_up X-Real-IP {remote_host}`,
    `${i}  header_up X-Forwarded-Host {host}`,
    `${i}}`,
  ].join("\n");
}

/**
 * Turn a gateway failure into a 503 with `Retry-After` instead of a bare 502,
 * and make it CORS-readable so browser clients see the real status rather than
 * an opaque network error.
 *
 * The body is deliberately plain text: `{` starts a placeholder in a Caddyfile,
 * so a JSON body would be fragile. The machine-readable parts live in headers.
 */
function errorHandler(indent: string): string {
  const i = indent;
  return [
    `${i}handle_errors {`,
    `${i}  header Content-Type "text/plain; charset=utf-8"`,
    `${i}  header Cache-Control "no-store"`,
    `${i}  header Retry-After "3"`,
    `${i}  header Access-Control-Allow-Origin "*"`,
    `${i}  header Access-Control-Expose-Headers "Retry-After, X-Runbase-Error, X-Runbase-Upstream-Status"`,
    `${i}  header X-Runbase-Error "backend_unavailable"`,
    `${i}  header X-Runbase-Upstream-Status "{err.status_code}"`,
    `${i}  respond "Runbase: this service is starting or restarting. Retry in a moment." 503`,
    `${i}}`,
  ].join("\n");
}

/** Render the dynamic Caddyfile. Pure function so it is easy to diff/test. */
export function renderCaddyfile(
  routes: ProxyRoute[],
  opts: CaddyfileOptions = {},
): string {
  const tryFor = opts.tryDurationSec ?? 25;
  const lines: string[] = [];

  lines.push("# Generated by Runbase — do not edit by hand");
  lines.push("{");
  lines.push("  auto_https off");
  lines.push("  admin 0.0.0.0:2019");
  lines.push("  persist_config off");
  lines.push("  servers {");
  lines.push("    timeouts {");
  lines.push("      read_body 0");
  lines.push("      read_header 20s");
  lines.push("      idle 10m");
  lines.push("    }");
  lines.push("  }");
  lines.push("}");
  lines.push("");

  // Hostname-based routes (project.PUBLIC_HOST)
  for (const r of routes) {
    lines.push(`http://${r.hostname} {`);
    lines.push("  encode zstd gzip");
    lines.push(proxyBody(r.upstream, tryFor, "  "));
    lines.push(errorHandler("  "));
    lines.push("}");
    lines.push("");
  }

  // Single front door on :80 — path routes, platform API, dashboard fallback.
  lines.push(":80 {");
  lines.push("  encode zstd gzip");
  lines.push("");
  lines.push("  # Proxy liveness — never touches an upstream.");
  lines.push("  handle /__runbase/health {");
  lines.push('    header Content-Type "text/plain; charset=utf-8"');
  lines.push('    header Cache-Control "no-store"');
  lines.push(`    header X-Runbase-Routes "${routes.length}"`);
  lines.push(
    `    respond "ok proxy=caddy routes=${routes.length}" 200`,
  );
  lines.push("  }");
  lines.push("");

  for (const r of routes) {
    const m = matcherName(r.name);
    lines.push(`  @${m} path /p/${r.name} /p/${r.name}/*`);
    lines.push(`  handle @${m} {`);
    lines.push(`    redir /p/${r.name} /p/${r.name}/ 308`);
    lines.push(`    uri strip_prefix /p/${r.name}`);
    lines.push(proxyBody(r.upstream, tryFor, "    "));
    lines.push("  }");
    lines.push("");
  }

  if (opts.apiUpstream) {
    lines.push("  handle /api/* {");
    lines.push(proxyBody(opts.apiUpstream, tryFor, "    "));
    lines.push("  }");
    lines.push("");
  }

  if (opts.webUpstream) {
    lines.push("  handle {");
    lines.push(proxyBody(opts.webUpstream, tryFor, "    "));
    lines.push("  }");
  } else {
    lines.push("  handle {");
    lines.push(
      routes.length
        ? '    respond "Runbase proxy — use /p/<project>/ or Host: <project>.<PUBLIC_HOST>" 200'
        : '    respond "Runbase proxy ready" 200',
    );
    lines.push("  }");
  }

  lines.push("");
  lines.push(errorHandler("  "));
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

/**
 * Write the Caddyfile only when it actually changed.
 * Returns true when the file was rewritten (so callers can skip a reload —
 * every reload briefly drops in-flight connections).
 */
export async function writeCaddyfile(
  path: string,
  routes: ProxyRoute[],
  opts: CaddyfileOptions = {},
): Promise<boolean> {
  mkdirSync(dirname(path), { recursive: true });
  const content = renderCaddyfile(routes, opts);
  try {
    if (readFileSync(path, "utf8") === content) return false;
  } catch {
    /* missing or unreadable — write it */
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content, "utf8");
  return true;
}

/**
 * Ask Caddy to reload config through the admin API (more reliable than --watch
 * across a Docker volume). Retries — right after `compose up` the admin
 * endpoint can take a second to bind.
 */
export async function reloadCaddyFromFile(
  caddyfilePath: string,
  adminUrl = process.env.CADDY_ADMIN_URL ?? "http://caddy:2019",
  attempts = 5,
): Promise<boolean> {
  let lastError = "";
  for (let i = 0; i < attempts; i += 1) {
    try {
      const body = readFileSync(caddyfilePath, "utf8");
      const res = await fetch(`${adminUrl}/load`, {
        method: "POST",
        headers: { "Content-Type": "text/caddyfile" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      lastError = `${res.status} ${await res.text().catch(() => "")}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  console.warn(`Caddy reload failed after ${attempts} attempts: ${lastError}`);
  return false;
}

/** True when Caddy's admin API answers — used by the reconciler. */
export async function caddyAdminReachable(
  adminUrl = process.env.CADDY_ADMIN_URL ?? "http://caddy:2019",
): Promise<boolean> {
  try {
    const res = await fetch(`${adminUrl}/config/`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
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

type NetworkMap = Record<string, { IPAddress?: string } | undefined>;

function pickIp(
  networks: NetworkMap,
  preferredNetwork?: string,
  strict = false,
): string | null {
  if (preferredNetwork) {
    const ip = networks[preferredNetwork]?.IPAddress;
    if (ip) return ip;
    // The prober lives on the preferred network; an address on some other
    // network would not be routable from here, so do not fall back to one.
    if (strict) return null;
  }
  for (const n of Object.values(networks)) {
    if (n?.IPAddress) return n.IPAddress;
  }
  return null;
}

/** Resolve a container's IP on a given network (or any attached network). */
export async function containerIp(
  docker: Dockerode,
  idOrName: string,
  preferredNetwork?: string,
  strict = false,
): Promise<string | null> {
  const info = await docker.getContainer(idOrName).inspect();
  return pickIp(
    (info.NetworkSettings?.Networks ?? {}) as NetworkMap,
    preferredNetwork,
    strict,
  );
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

export type ReadinessResult = {
  ready: boolean;
  /** "listening" | "exited" | "timeout" | "no-ip" */
  reason: string;
  waitedMs: number;
};

/**
 * Wait until a container is actually accepting TCP connections on its port.
 *
 * A container being "Running" says nothing about whether the process inside has
 * bound its port yet — cutting traffic over on that signal alone is the main
 * reason a fresh deploy answers 502 for its first few seconds.
 */
export async function waitForContainerReady(
  docker: Dockerode,
  idOrName: string,
  port: number,
  opts: {
    timeoutMs?: number;
    network?: string;
    intervalMs?: number;
    /** Extra time a listening-but-not-yet-healthy container gets. */
    healthGraceMs?: number;
    onLog?: (line: string) => void;
  } = {},
): Promise<ReadinessResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 400;
  const healthGraceMs = opts.healthGraceMs ?? 30_000;
  const started = Date.now();
  let announced = false;
  let sawIp = false;
  let listeningSince: number | null = null;

  while (Date.now() - started < timeoutMs) {
    let info;
    try {
      info = await docker.getContainer(idOrName).inspect();
    } catch {
      return { ready: false, reason: "exited", waitedMs: Date.now() - started };
    }
    if (!info.State?.Running) {
      return { ready: false, reason: "exited", waitedMs: Date.now() - started };
    }

    const health = info.State?.Health?.Status;
    const ip = pickIp(
      (info.NetworkSettings?.Networks ?? {}) as NetworkMap,
      opts.network,
      true,
    );
    if (ip) {
      sawIp = true;
      if (!announced) {
        opts.onLog?.(`Waiting for ${ip}:${port} to accept connections…`);
        announced = true;
      }
      if (await tcpProbe(ip, port, 1500)) {
        if (!health || health === "healthy" || health === "none") {
          return {
            ready: true,
            reason: "listening",
            waitedMs: Date.now() - started,
          };
        }
        // The image declares its own HEALTHCHECK and it has not passed yet.
        // Give it a grace period, then cut over anyway rather than failing a
        // deploy that would previously have gone live — a listening port is
        // still a working backend far more often than not.
        if (listeningSince === null) listeningSince = Date.now();
        if (Date.now() - listeningSince >= healthGraceMs) {
          opts.onLog?.(
            `Port is open but the image HEALTHCHECK reports "${health}" — cutting over anyway`,
          );
          return {
            ready: true,
            reason: `listening-health-${health}`,
            waitedMs: Date.now() - started,
          };
        }
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return {
    ready: false,
    reason: sawIp ? "timeout" : "no-network",
    waitedMs: Date.now() - started,
  };
}

/** Containers this platform manages, with their running state. */
export async function listManagedContainers(
  docker: Dockerode,
): Promise<Array<{ id: string; name: string; state: string; status: string }>> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: ["laptop-paas.managed=true"] },
  });
  return list.map((c) => ({
    id: c.Id,
    name: (c.Names?.[0] ?? "").replace(/^\//, ""),
    state: c.State,
    status: c.Status,
  }));
}

/** Start a container if it exists but is stopped. Returns its id, or null. */
export async function startIfStopped(
  docker: Dockerode,
  name: string,
): Promise<string | null> {
  try {
    const c = docker.getContainer(name);
    const info = await c.inspect();
    if (info.State?.Running) return info.Id;
    await c.start();
    return info.Id;
  } catch {
    return null;
  }
}
