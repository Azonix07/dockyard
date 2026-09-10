"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  formatBytes,
  type Deploy,
  type Project,
  type ResourceMetrics,
} from "@laptop-paas/shared";
import { AppShell, Meter, StatusBadge } from "@/components/AppShell";
import { useRequireAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

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

type Tab = "overview" | "metrics" | "deployments" | "variables" | "settings";

export default function ProjectPage() {
  const { user, loading } = useRequireAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [tab, setTab] = useState<Tab>("overview");

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
  const [envText, setEnvText] = useState("");
  const [memoryMb, setMemoryMb] = useState("512");
  const [cpu, setCpu] = useState("1");
  const [autoDeploy, setAutoDeploy] = useState(true);

  const refresh = useCallback(async () => {
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
      setRepoUrl(p.project.repoUrl);
      setBranch(p.project.branch);
      setPort(String(p.project.port));
      setDockerfilePath(p.project.dockerfilePath);
      setBuildContext(p.project.buildContext);
      setEnvText(envToText(p.project.env));
      setMemoryMb(String(Math.round(p.project.memoryLimitBytes / 1024 / 1024)));
      setCpu(String(p.project.cpuNanoCpus / 1_000_000_000));
      setAutoDeploy(p.project.autoDeploy);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
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

  async function deploy(redeploy = false) {
    setBusy(true);
    try {
      await api(`/api/projects/${id}/deploy`, {
        method: "POST",
        body: JSON.stringify({
          triggeredBy: redeploy ? "redeploy" : "manual",
        }),
      });
      await refresh();
      setTab("deployments");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
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
          env: parseEnv(envText),
          memoryLimitBytes: Math.round(Number(memoryMb) * 1024 * 1024),
          cpuNanoCpus: Math.round(Number(cpu) * 1_000_000_000),
          autoDeploy,
        }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
              Public path: {publicPath}
              <br />
              Hostname: {project.hostname}
              <br />
              Source: {project.repoUrl || "Empty — attach a repo in Settings"}
            </p>
            <div className="row">
              <button
                className="btn secondary"
                type="button"
                onClick={() =>
                  void api(`/api/projects/${id}/restart`, { method: "POST" }).then(refresh)
                }
              >
                Restart
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() =>
                  void api(`/api/projects/${id}/stop`, { method: "POST" }).then(refresh)
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
                  <div className="muted mono" style={{ fontSize: "0.75rem", marginTop: 6 }}>
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
        <section className="panel" style={{ maxWidth: 720 }}>
          <h2>Variables</h2>
          <p className="muted">
            KEY=value per line. Linked databases inject connection URLs automatically.
          </p>
          <label className="field">
            Raw editor
            <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} />
          </label>
          <button className="btn" type="button" disabled={busy} onClick={() => void save()}>
            Save variables
          </button>
        </section>
      ) : null}

      {tab === "settings" ? (
        <section
          className="panel"
          style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 12 }}
        >
          <h2>Service settings</h2>
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
          <button className="btn" type="button" disabled={busy} onClick={() => void save()}>
            Save settings
          </button>
        </section>
      ) : null}
    </AppShell>
  );
}
