"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  DATABASE_PRESETS,
  formatBytes,
  type Deploy,
  type ManagedDatabase,
  type Project,
  type RepoAnalysis,
  type ResourceMetrics,
  type ServiceRole,
  type VercelProject,
  type VercelStatus,
} from "@laptop-paas/shared";
import { AppShell, Meter, StatusBadge } from "@/components/AppShell";
import { useRequireAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

type Tab = "overview" | "metrics" | "deployments" | "variables" | "settings";

type EnvRow = {
  id: string;
  key: string;
  value: string;
  revealed: boolean;
  fromDatabase?: boolean;
};

const DB_ENV_KEYS = new Set([
  "DATABASE_URL",
  "REDIS_URL",
  "MONGO_URL",
  "MONGODB_URI",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
]);

function envToRows(env: Record<string, string>): EnvRow[] {
  const entries = Object.entries(env);
  if (entries.length === 0) {
    return [{ id: crypto.randomUUID(), key: "", value: "", revealed: false }];
  }
  return entries.map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value,
    revealed: false,
    fromDatabase: DB_ENV_KEYS.has(key),
  }));
}

function rowsToEnv(rows: EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    env[key] = row.value;
  }
  return env;
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const ROLE_HELP: Record<ServiceRole, string> = {
  web: "Frontend / full-stack web app (Next.js, etc.)",
  api: "Backend API only — Runbase injects PORT and DB URLs",
  worker: "Background worker (no public HTTP required)",
  full: "Single service — auto-detect from the repo",
};

export default function ProjectPage() {
  const { user, loading } = useRequireAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const tabQ = q.get("tab");
    if (
      tabQ === "overview" ||
      tabQ === "metrics" ||
      tabQ === "deployments" ||
      tabQ === "variables" ||
      tabQ === "settings"
    ) {
      setTab(tabQ);
    }
    if (q.get("vercel") === "connected") {
      setTab("variables");
    }
    if (q.get("vercel") === "error") {
      setTab("variables");
      setError(
        `Vercel connect failed: ${q.get("reason") || "unknown error"}`,
      );
    }
  }, []);

  const [project, setProject] = useState<Project | null>(null);
  const [deploys, setDeploys] = useState<Deploy[]>([]);
  const [logs, setLogs] = useState("");
  const [metrics, setMetrics] = useState<ResourceMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [port, setPort] = useState("3000");
  const [dockerfilePath, setDockerfilePath] = useState("Dockerfile");
  const [buildContext, setBuildContext] = useState(".");
  const [memoryMb, setMemoryMb] = useState("512");
  const [cpu, setCpu] = useState("1");
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [serviceRole, setServiceRole] = useState<ServiceRole>("full");
  const [startCommand, setStartCommand] = useState("");

  const [envRows, setEnvRows] = useState<EnvRow[]>([
    { id: "empty", key: "", value: "", revealed: false },
  ]);
  const [rawMode, setRawMode] = useState(false);
  const [envText, setEnvText] = useState("");
  const [showValues, setShowValues] = useState(false);

  const [databases, setDatabases] = useState<ManagedDatabase[]>([]);
  const [selectedDbId, setSelectedDbId] = useState("");
  const [linkingDb, setLinkingDb] = useState(false);

  const [vercelStatus, setVercelStatus] = useState<VercelStatus | null>(null);
  const [vercelProjects, setVercelProjects] = useState<VercelProject[]>([]);
  const [selectedVercelId, setSelectedVercelId] = useState("");
  const [vercelToken, setVercelToken] = useState("");
  const [vercelEnvKey, setVercelEnvKey] = useState("NEXT_PUBLIC_API_URL");
  const [backendUrl, setBackendUrl] = useState("");
  const [linkingVercel, setLinkingVercel] = useState(false);
  const [showVercelToken, setShowVercelToken] = useState(false);

  const [analysis, setAnalysis] = useState<RepoAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const refresh = useCallback(async (opts?: { hydrateForms?: boolean }) => {
    const hydrateForms = opts?.hydrateForms ?? false;
    try {
      const [p, d, l] = await Promise.all([
        api<{ project: Project }>(`/api/projects/${id}`),
        api<{ deploys: Deploy[] }>(`/api/projects/${id}/deploys`),
        api<{ logs: string }>(`/api/projects/${id}/logs`),
      ]);
      setProject(p.project);
      setDeploys(d.deploys);
      setLogs(l.logs ?? "");
      setError(null);
      // Don't clobber in-progress Settings/Variables edits on the 4s poll
      if (hydrateForms) {
        setRepoUrl(p.project.repoUrl);
        setBranch(p.project.branch);
        setPort(String(p.project.port));
        setDockerfilePath(p.project.dockerfilePath);
        setBuildContext(p.project.buildContext);
        setMemoryMb(String(Math.round(p.project.memoryLimitBytes / 1024 / 1024)));
        setCpu(String(p.project.cpuNanoCpus / 1_000_000_000));
        setAutoDeploy(p.project.autoDeploy);
        setServiceRole(p.project.serviceRole || "full");
        setStartCommand(p.project.startCommand ?? "");
        setEnvRows(envToRows(p.project.env));
        setEnvText(envToText(p.project.env));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    if (!user) return;
    void refresh({ hydrateForms: true });
    const t = setInterval(() => void refresh({ hydrateForms: false }), 4000);
    return () => clearInterval(t);
  }, [user, refresh]);

  useEffect(() => {
    if (!user || tab !== "metrics") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api<{ metrics: ResourceMetrics }>(
          `/api/projects/${id}/metrics`,
        );
        if (!cancelled) setMetrics(res.metrics);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [user, id, tab]);

  useEffect(() => {
    if (!user || tab !== "variables") return;
    void api<{ databases: ManagedDatabase[] }>("/api/databases")
      .then((res) => {
        setDatabases(res.databases);
        const linked = res.databases.find((d) => d.projectId === id);
        if (linked) setSelectedDbId(linked.id);
      })
      .catch(() => {
        /* ignore */
      });

    void (async () => {
      try {
        const [status, urlInfo] = await Promise.all([
          api<VercelStatus>("/api/vercel/status"),
          api<{ backendUrl: string }>(`/api/projects/${id}/backend-url`),
        ]);
        setVercelStatus(status);
        setBackendUrl((prev) => prev || urlInfo.backendUrl);
        if (status.connected) {
          const listed = await api<{ projects: VercelProject[] }>(
            "/api/vercel/projects",
          );
          setVercelProjects(listed.projects);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [user, tab, id]);

  const linkedDatabases = useMemo(
    () => databases.filter((d) => d.projectId === id),
    [databases, id],
  );
  const availableDatabases = useMemo(
    () =>
      databases.filter(
        (d) => !d.projectId || d.projectId === id,
      ),
    [databases, id],
  );

  const currentEnv = useMemo(
    () => (rawMode ? parseEnv(envText) : rowsToEnv(envRows)),
    [rawMode, envText, envRows],
  );

  async function refreshVercelProjects() {
    const listed = await api<{ projects: VercelProject[] }>(
      "/api/vercel/projects",
    );
    setVercelProjects(listed.projects);
  }

  async function connectVercelToken() {
    if (!vercelToken.trim()) {
      setError("Paste a Vercel token first");
      return;
    }
    setLinkingVercel(true);
    setError(null);
    try {
      const res = await api<{ connected: boolean; username: string }>(
        "/api/vercel/token",
        {
          method: "POST",
          body: JSON.stringify({ token: vercelToken.trim() }),
        },
      );
      setVercelToken("");
      setShowVercelToken(false);
      setVercelStatus({
        configured: vercelStatus?.configured ?? false,
        connected: true,
        username: res.username,
        teamId: null,
      });
      await refreshVercelProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingVercel(false);
    }
  }

  async function connectVercelOAuth() {
    setLinkingVercel(true);
    setError(null);
    try {
      const res = await api<{ url: string }>(
        `/api/vercel/connect?returnTo=${encodeURIComponent(`/project/${id}?tab=variables`)}`,
      );
      window.location.href = res.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLinkingVercel(false);
    }
  }

  async function disconnectVercelAccount() {
    setLinkingVercel(true);
    setError(null);
    try {
      await api("/api/vercel/disconnect", { method: "DELETE" });
      setVercelStatus({
        configured: vercelStatus?.configured ?? false,
        connected: false,
        username: null,
        teamId: null,
      });
      setVercelProjects([]);
      setSelectedVercelId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingVercel(false);
    }
  }

  async function linkVercelFrontend() {
    if (!selectedVercelId) {
      setError("Choose a Vercel project to connect");
      return;
    }
    setLinkingVercel(true);
    setError(null);
    try {
      const res = await api<{
        project: Project;
        backendUrl: string;
        redeploy: { ok: boolean; error?: string };
      }>(`/api/projects/${id}/vercel/link`, {
        method: "POST",
        body: JSON.stringify({
          vercelProjectId: selectedVercelId,
          envKey: vercelEnvKey.trim() || "NEXT_PUBLIC_API_URL",
          backendUrl: backendUrl.trim() || undefined,
          redeploy: true,
        }),
      });
      setProject(res.project);
      if (!res.redeploy.ok && res.redeploy.error) {
        setError(
          `Connected — env set on Vercel. Redeploy manually if needed (${res.redeploy.error})`,
        );
      }
      await refresh({ hydrateForms: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingVercel(false);
    }
  }

  async function unlinkVercelFrontend() {
    setLinkingVercel(true);
    setError(null);
    try {
      const res = await api<{ project: Project }>(
        `/api/projects/${id}/vercel/link`,
        { method: "DELETE" },
      );
      setProject(res.project);
      setSelectedVercelId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingVercel(false);
    }
  }

  async function connectDatabase() {
    if (!selectedDbId) {
      setError("Choose a database to connect");
      return;
    }
    setLinkingDb(true);
    setError(null);
    try {
      await api(`/api/databases/${selectedDbId}/link`, {
        method: "POST",
        body: JSON.stringify({ projectId: id }),
      });
      const [d] = await Promise.all([
        api<{ databases: ManagedDatabase[] }>("/api/databases"),
        refresh({ hydrateForms: true }),
      ]);
      setDatabases(d.databases);
      setTab("deployments");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingDb(false);
    }
  }

  async function disconnectDatabase(dbId: string) {
    setLinkingDb(true);
    setError(null);
    try {
      await api(`/api/databases/${dbId}/link`, {
        method: "POST",
        body: JSON.stringify({ projectId: null }),
      });
      const d = await api<{ databases: ManagedDatabase[] }>("/api/databases");
      setDatabases(d.databases);
      await refresh({ hydrateForms: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingDb(false);
    }
  }

  function toggleRowReveal(idx: number) {
    setEnvRows((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, revealed: !r.revealed } : r)),
    );
  }

  function setAllRevealed(revealed: boolean) {
    setShowValues(revealed);
    setEnvRows((rows) => rows.map((r) => ({ ...r, revealed })));
  }

  function toggleRawMode() {
    if (rawMode) {
      setEnvRows(envToRows(parseEnv(envText)));
      setRawMode(false);
    } else {
      setEnvText(envToText(rowsToEnv(envRows)));
      setRawMode(true);
    }
  }

  async function deploy(redeploy = false) {
    setBusy(true);
    try {
      await api(`/api/projects/${id}/deploy`, {
        method: "POST",
        body: JSON.stringify({
          triggeredBy: redeploy ? "redeploy" : "manual",
        }),
      });
      await refresh({ hydrateForms: false });
      setTab("deployments");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveVariables() {
    setBusy(true);
    try {
      await api(`/api/projects/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ env: currentEnv }),
      });
      await refresh({ hydrateForms: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    setBusy(true);
    try {
      await api(`/api/projects/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          repoUrl,
          branch,
          port: Number(port),
          dockerfilePath,
          buildContext,
          memoryLimitBytes: Math.round(Number(memoryMb) * 1024 * 1024),
          cpuNanoCpus: Math.round(Number(cpu) * 1_000_000_000),
          autoDeploy,
          serviceRole,
          startCommand: startCommand.trim() || null,
        }),
      });
      await refresh({ hydrateForms: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runAnalyze(apply: boolean) {
    setAnalyzing(true);
    setError(null);
    try {
      const res = await api<{ analysis: RepoAnalysis; project?: Project }>(
        `/api/projects/${id}/analyze`,
        {
          method: "POST",
          body: JSON.stringify({ apply, serviceRole }),
        },
      );
      setAnalysis(res.analysis);
      if (apply && res.project) {
        await refresh({ hydrateForms: true });
        setPort(String(res.analysis.port));
        setDockerfilePath(res.analysis.dockerfilePath);
        setBuildContext(res.analysis.buildContext);
        setServiceRole(res.analysis.serviceRole);
        setStartCommand(res.analysis.startCommand ?? "");
        setEnvRows(envToRows(res.project.env));
        setEnvText(envToText(res.project.env));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  if (loading || !user) {
    return <div className="auth-wrap muted">Loading…</div>;
  }

  const publicPath =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}/p/${project?.name ?? ""}/`
      : `/p/${project?.name ?? ""}/`;

  return (
    <AppShell
      title={project?.name ?? "Project"}
      actions={
        <div className="row">
          <Link href="/dashboard" className="btn secondary">
            All projects
          </Link>
          <button
            className="btn"
            type="button"
            disabled={busy || !project?.repoUrl}
            onClick={() => void deploy()}
          >
            Deploy
          </button>
        </div>
      }
    >
      {error ? <p className="error">{error}</p> : null}

      <div className="tabs-row">
        {(
          [
            ["overview", "Overview"],
            ["metrics", "Metrics"],
            ["deployments", "Deployments"],
            ["variables", "Variables"],
            ["settings", "Settings"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab-btn ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && project ? (
        <div className="grid-2">
          <section className="panel">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>Service</h2>
              <StatusBadge status={project.status} />
            </div>
            <p className="muted mono" style={{ fontSize: "0.8rem" }}>
              Role: {project.serviceRole || "full"}
              <br />
              Public path: {publicPath}
              <br />
              Hostname: {project.hostname}
              <br />
              Source: {project.repoUrl || "Empty — attach a repo in Settings"}
              {project.vercelProjectName ? (
                <>
                  <br />
                  Vercel:{" "}
                  <a
                    href={project.vercelProjectUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {project.vercelProjectName}
                  </a>
                </>
              ) : null}
            </p>
            <div className="row">
              <button
                className="btn secondary"
                type="button"
                onClick={() =>
                  void api(`/api/projects/${id}/restart`, { method: "POST" }).then(() =>
                    refresh({ hydrateForms: false }),
                  )
                }
              >
                Restart
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() =>
                  void api(`/api/projects/${id}/stop`, { method: "POST" }).then(() =>
                    refresh({ hydrateForms: false }),
                  )
                }
              >
                Stop
              </button>
              <button
                className="btn secondary"
                type="button"
                disabled={!project.previousImageTag}
                onClick={() => void deploy(true)}
              >
                Redeploy previous
              </button>
              <button
                className="btn danger"
                type="button"
                onClick={() => {
                  if (!confirm("Delete this project?")) return;
                  void api(`/api/projects/${id}`, { method: "DELETE" }).then(() =>
                    router.replace("/dashboard"),
                  );
                }}
              >
                Delete
              </button>
            </div>
          </section>
          <section className="panel">
            <h2>Runtime logs</h2>
            <pre className="logs">{logs || "No container logs yet"}</pre>
          </section>
        </div>
      ) : null}

      {tab === "metrics" ? (
        <div className="grid-3">
          <div className="metric-card">
            <div className="label">CPU</div>
            <div className="value">
              {metrics?.available ? `${metrics.cpuPercent?.toFixed(1)}%` : "—"}
            </div>
            <Meter value={metrics?.cpuPercent ?? 0} />
          </div>
          <div className="metric-card">
            <div className="label">Memory</div>
            <div className="value">
              {metrics?.available
                ? `${formatBytes(metrics.memoryUsedBytes ?? 0)}`
                : "—"}
            </div>
            <Meter value={metrics?.memoryPercent ?? 0} />
            <div className="sub">
              Limit {formatBytes(project?.memoryLimitBytes ?? 0)}
            </div>
          </div>
          <div className="metric-card">
            <div className="label">Network</div>
            <div className="value" style={{ fontSize: "1.1rem" }}>
              {metrics?.available
                ? `${formatBytes(metrics.netRxBytes ?? 0)} in`
                : "—"}
            </div>
            <div className="sub">
              {metrics?.available
                ? `${formatBytes(metrics.netTxBytes ?? 0)} out`
                : "Start the service to see live Docker stats"}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "deployments" ? (
        <section className="panel">
          <h2>Deployments</h2>
          <div className="list">
            {deploys.length === 0 ? (
              <p className="muted">No deploys yet</p>
            ) : (
              deploys.map((d) => (
                <div
                  key={d.id}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: 6,
                    padding: 12,
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <StatusBadge status={d.status} />
                    <span className="muted mono" style={{ fontSize: "0.75rem" }}>
                      {d.triggeredBy}
                    </span>
                  </div>
                  <div
                    className="muted mono"
                    style={{ fontSize: "0.75rem", marginTop: 6 }}
                  >
                    {d.commitSha?.slice(0, 12) ?? "—"} ·{" "}
                    {new Date(d.createdAt).toLocaleString()}
                  </div>
                  {d.error ? <p className="error">{d.error}</p> : null}
                  {d.log ? (
                    <pre className="logs" style={{ marginTop: 8, maxHeight: 140 }}>
                      {d.log.slice(-2500)}
                    </pre>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}

      {tab === "variables" ? (
        <div style={{ maxWidth: 860, display: "flex", flexDirection: "column", gap: 16 }}>
          <section className="panel db-connect-panel">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <h2 style={{ margin: 0 }}>Connect database</h2>
                <p className="muted" style={{ margin: "6px 0 0" }}>
                  Pick a Runbase database to inject connection variables into
                  this backend and redeploy.
                </p>
              </div>
              <Link href="/databases" className="btn secondary">
                Manage databases
              </Link>
            </div>

            {linkedDatabases.length > 0 ? (
              <div className="linked-dbs">
                {linkedDatabases.map((db) => (
                  <div key={db.id} className="linked-db-row">
                    <div>
                      <strong>{db.name}</strong>
                      <span className="muted">
                        {" "}
                        · {DATABASE_PRESETS[db.kind]?.label ?? db.kind} ·{" "}
                        {DATABASE_PRESETS[db.kind]?.envKey ?? "URL"}
                      </span>
                      <StatusBadge status={db.status} />
                    </div>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={linkingDb}
                      onClick={() => void disconnectDatabase(db.id)}
                    >
                      Disconnect
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="row" style={{ alignItems: "flex-end" }}>
              <label className="field" style={{ flex: 1 }}>
                Database
                <select
                  value={selectedDbId}
                  onChange={(e) => setSelectedDbId(e.target.value)}
                >
                  <option value="">Select a database…</option>
                  {availableDatabases.map((db) => (
                    <option key={db.id} value={db.id}>
                      {db.name} ({DATABASE_PRESETS[db.kind]?.label ?? db.kind})
                      {db.projectId === id ? " — connected" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn"
                type="button"
                disabled={linkingDb || !selectedDbId}
                onClick={() => void connectDatabase()}
              >
                {linkingDb ? "Connecting…" : "Connect"}
              </button>
            </div>
            {availableDatabases.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No databases yet. Create one under Databases, then connect it
                here.
              </p>
            ) : null}
          </section>

          <section className="panel db-connect-panel">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <h2 style={{ margin: 0 }}>Connect Vercel frontend</h2>
                <p className="muted" style={{ margin: "6px 0 0" }}>
                  Bind your Vercel account once. Runbase keeps it linked, then
                  you pick which frontend project talks to this backend.
                </p>
              </div>
            </div>

            {project?.vercelProjectId ? (
              <div className="linked-dbs">
                <div className="linked-db-row">
                  <div>
                    <strong>{project.vercelProjectName}</strong>
                    <span className="muted">
                      {" "}
                      · {project.vercelEnvKey ?? "NEXT_PUBLIC_API_URL"}
                    </span>
                    {project.vercelProjectUrl ? (
                      <div className="muted mono" style={{ fontSize: "0.75rem" }}>
                        <a href={project.vercelProjectUrl} target="_blank" rel="noreferrer">
                          {project.vercelProjectUrl}
                        </a>
                      </div>
                    ) : null}
                  </div>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={linkingVercel}
                    onClick={() => void unlinkVercelFrontend()}
                  >
                    Disconnect project
                  </button>
                </div>
              </div>
            ) : null}

            {!vercelStatus?.connected ? (
              <div className="list">
                {vercelStatus?.configured ? (
                  <>
                    <button
                      className="btn"
                      type="button"
                      disabled={linkingVercel}
                      onClick={() => void connectVercelOAuth()}
                    >
                      {linkingVercel
                        ? "Opening Vercel…"
                        : "Connect Vercel account"}
                    </button>
                    <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
                      Signs in with Vercel and keeps the account linked on this
                      Runbase login.
                    </p>
                    <details>
                      <summary className="muted" style={{ cursor: "pointer" }}>
                        Or bind with an access token
                      </summary>
                      <div className="list" style={{ marginTop: 10 }}>
                        <label className="field">
                          Vercel access token
                          <input
                            type={showVercelToken ? "text" : "password"}
                            value={vercelToken}
                            onChange={(e) => setVercelToken(e.target.value)}
                            placeholder="Account token (saved once)"
                            autoComplete="off"
                          />
                        </label>
                        <div className="row">
                          <button
                            className="btn ghost"
                            type="button"
                            onClick={() => setShowVercelToken((v) => !v)}
                          >
                            {showVercelToken ? "Hide" : "Show"}
                          </button>
                          <button
                            className="btn secondary"
                            type="button"
                            disabled={linkingVercel || !vercelToken.trim()}
                            onClick={() => void connectVercelToken()}
                          >
                            {linkingVercel ? "Binding…" : "Bind account"}
                          </button>
                          <a
                            className="btn ghost"
                            href="https://vercel.com/account/tokens"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Create token
                          </a>
                        </div>
                      </div>
                    </details>
                  </>
                ) : (
                  <>
                    <p className="muted" style={{ margin: 0 }}>
                      Connect once — your Vercel account stays bound until you
                      unlink it. Create a token at vercel.com → Account → Tokens
                      (full account), then bind below.
                    </p>
                    <label className="field">
                      Authorize Runbase
                      <input
                        type={showVercelToken ? "text" : "password"}
                        value={vercelToken}
                        onChange={(e) => setVercelToken(e.target.value)}
                        placeholder="Paste access token to bind account"
                        autoComplete="off"
                      />
                    </label>
                    <div className="row">
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={() => setShowVercelToken((v) => !v)}
                      >
                        {showVercelToken ? "Hide" : "Show"}
                      </button>
                      <button
                        className="btn"
                        type="button"
                        disabled={linkingVercel || !vercelToken.trim()}
                        onClick={() => void connectVercelToken()}
                      >
                        {linkingVercel
                          ? "Binding…"
                          : "Connect Vercel account"}
                      </button>
                      <a
                        className="btn secondary"
                        href="https://vercel.com/account/tokens"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Get token
                      </a>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="list">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span>
                    Vercel account bound as{" "}
                    <strong className="mono">{vercelStatus.username}</strong>
                  </span>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={linkingVercel}
                    onClick={() => void disconnectVercelAccount()}
                  >
                    Unlink account
                  </button>
                </div>

                <label className="field">
                  Vercel project
                  <select
                    value={selectedVercelId}
                    onChange={(e) => setSelectedVercelId(e.target.value)}
                  >
                    <option value="">Select frontend project…</option>
                    {vercelProjects.map((vp) => (
                      <option key={vp.id} value={vp.id}>
                        {vp.name}
                        {vp.framework ? ` (${vp.framework})` : ""}
                        {vp.link?.repo ? ` — ${vp.link.repo}` : ""}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="row" style={{ alignItems: "flex-end" }}>
                  <label className="field" style={{ flex: 1 }}>
                    Env key on Vercel
                    <input
                      value={vercelEnvKey}
                      onChange={(e) => setVercelEnvKey(e.target.value)}
                      placeholder="NEXT_PUBLIC_API_URL"
                    />
                  </label>
                </div>

                <label className="field">
                  Backend URL (injected)
                  <input
                    value={backendUrl}
                    onChange={(e) => setBackendUrl(e.target.value)}
                    placeholder="https://…/p/your-api"
                  />
                </label>

                <button
                  className="btn"
                  type="button"
                  disabled={linkingVercel || !selectedVercelId}
                  onClick={() => void linkVercelFrontend()}
                >
                  {linkingVercel
                    ? "Linking…"
                    : "Connect frontend → this backend"}
                </button>
              </div>
            )}
          </section>

          <section
            className="panel"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <h2 style={{ margin: 0 }}>Variables</h2>
                <p className="muted" style={{ margin: "6px 0 0" }}>
                  Edit keys and values. Use the eye icon to show or hide each
                  secret.
                </p>
              </div>
              <div className="row">
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => setAllRevealed(!showValues)}
                >
                  {showValues ? "Hide all" : "Show all"}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={toggleRawMode}
                >
                  {rawMode ? "Table editor" : "Raw editor"}
                </button>
              </div>
            </div>

            {rawMode ? (
              <label className="field">
                Raw KEY=value
                <textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  rows={12}
                />
              </label>
            ) : (
              <div className="var-table">
                <div className="var-head var-head-4">
                  <span>Variable</span>
                  <span>Value</span>
                  <span />
                  <span />
                </div>
                {envRows.map((row, idx) => (
                  <div className="var-row var-row-4" key={row.id}>
                    <div className="var-key-wrap">
                      <input
                        className="var-key"
                        placeholder="KEY"
                        value={row.key}
                        onChange={(e) => {
                          const next = [...envRows];
                          const key = e.target.value.toUpperCase();
                          next[idx] = {
                            ...row,
                            key,
                            fromDatabase: DB_ENV_KEYS.has(key),
                          };
                          setEnvRows(next);
                        }}
                      />
                      {row.fromDatabase ? (
                        <span className="var-db-badge">DB</span>
                      ) : null}
                    </div>
                    <input
                      className="var-val"
                      placeholder="value"
                      type={row.revealed || showValues ? "text" : "password"}
                      value={row.value}
                      onChange={(e) => {
                        const next = [...envRows];
                        next[idx] = { ...row, value: e.target.value };
                        setEnvRows(next);
                      }}
                      autoComplete="off"
                    />
                    <button
                      className="btn ghost var-icon-btn"
                      type="button"
                      aria-label={row.revealed ? "Hide value" : "Show value"}
                      onClick={() => toggleRowReveal(idx)}
                    >
                      {row.revealed || showValues ? "Hide" : "View"}
                    </button>
                    <button
                      className="btn ghost var-icon-btn"
                      type="button"
                      aria-label="Remove variable"
                      onClick={() => {
                        const next = envRows.filter((r) => r.id !== row.id);
                        setEnvRows(
                          next.length
                            ? next
                            : [
                                {
                                  id: crypto.randomUUID(),
                                  key: "",
                                  value: "",
                                  revealed: false,
                                },
                              ],
                        );
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() =>
                    setEnvRows((rows) => [
                      ...rows,
                      {
                        id: crypto.randomUUID(),
                        key: "",
                        value: "",
                        revealed: true,
                      },
                    ])
                  }
                >
                  + Add variable
                </button>
              </div>
            )}

            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => void saveVariables()}
            >
              {busy ? "Saving…" : "Save variables"}
            </button>
          </section>
        </div>
      ) : null}

      {tab === "settings" ? (
        <section
          className="panel"
          style={{ maxWidth: 820, display: "flex", flexDirection: "column", gap: 14 }}
        >
          <h2 style={{ margin: 0 }}>Service settings</h2>

          <div className="analyze-box">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>What to host</strong>
                <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.88rem" }}>
                  {ROLE_HELP[serviceRole]}
                </p>
              </div>
              <button
                className="btn"
                type="button"
                disabled={analyzing || !repoUrl}
                onClick={() => void runAnalyze(true)}
              >
                {analyzing ? "Analyzing…" : "Analyze & apply"}
              </button>
            </div>
            <div className="role-grid">
              {(["full", "api", "web", "worker"] as ServiceRole[]).map((role) => (
                <button
                  key={role}
                  type="button"
                  className={`role-card${serviceRole === role ? " selected" : ""}`}
                  disabled={busy}
                  onClick={() => {
                    setServiceRole(role);
                    void (async () => {
                      try {
                        await api(`/api/projects/${id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ serviceRole: role }),
                        });
                        setProject((prev) =>
                          prev ? { ...prev, serviceRole: role } : prev,
                        );
                      } catch (err) {
                        setError(
                          err instanceof Error ? err.message : String(err),
                        );
                      }
                    })();
                  }}
                >
                  <strong>{role === "api" ? "Backend / API" : role}</strong>
                  <span className="muted">{ROLE_HELP[role]}</span>
                </button>
              ))}
            </div>
            {analysis ? (
              <div className="analyze-result">
                <p style={{ margin: 0 }}>
                  <strong>{analysis.framework ?? "Unknown stack"}</strong>
                  {" · "}
                  port {analysis.port}
                  {analysis.willGenerateDockerfile
                    ? " · will generate Dockerfile"
                    : analysis.hasDockerfile
                      ? ` · ${analysis.dockerfilePath}`
                      : ""}
                </p>
                <ul className="muted" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {analysis.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
                <button
                  className="btn secondary"
                  type="button"
                  style={{ marginTop: 10 }}
                  disabled={analyzing}
                  onClick={() => void runAnalyze(false)}
                >
                  Re-scan without applying
                </button>
              </div>
            ) : (
              <p className="muted" style={{ marginBottom: 0, fontSize: "0.88rem" }}>
                Analyze reads the GitHub repo (Dockerfile, package.json, Procfile)
                and configures port, build paths, and start command — especially
                useful for backend APIs.
              </p>
            )}
          </div>

          <label className="field">
            Repo URL
            <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
          </label>
          <div className="row">
            <label className="field">
              Branch
              <input value={branch} onChange={(e) => setBranch(e.target.value)} />
            </label>
            <label className="field">
              Port
              <input value={port} onChange={(e) => setPort(e.target.value)} />
            </label>
          </div>
          <label className="field">
            Start command{" "}
            <span className="muted">(used when generating a Dockerfile)</span>
            <input
              value={startCommand}
              onChange={(e) => setStartCommand(e.target.value)}
              placeholder="npm run start"
            />
          </label>
          <div className="row">
            <label className="field">
              Dockerfile
              <input
                value={dockerfilePath}
                onChange={(e) => setDockerfilePath(e.target.value)}
              />
            </label>
            <label className="field">
              Build context
              <input
                value={buildContext}
                onChange={(e) => setBuildContext(e.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <label className="field">
              Memory (MB)
              <input value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} />
            </label>
            <label className="field">
              CPU cores
              <input value={cpu} onChange={(e) => setCpu(e.target.value)} />
            </label>
          </div>
          <label className="row" style={{ color: "var(--muted)" }}>
            <input
              type="checkbox"
              checked={autoDeploy}
              onChange={(e) => setAutoDeploy(e.target.checked)}
            />
            Auto-deploy on GitHub push
          </label>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void saveSettings()}
          >
            {busy ? "Saving…" : "Save settings"}
          </button>
        </section>
      ) : null}
    </AppShell>
  );
}
