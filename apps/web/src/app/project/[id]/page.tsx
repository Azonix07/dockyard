"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Deploy, Project } from "@laptop-paas/shared";
import { AppShell, StatusBadge } from "@/components/AppShell";
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

export default function ProjectPage() {
  const { user, loading } = useRequireAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [project, setProject] = useState<Project | null>(null);
  const [deploys, setDeploys] = useState<Deploy[]>([]);
  const [logs, setLogs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [port, setPort] = useState("3000");
  const [dockerfilePath, setDockerfilePath] = useState("Dockerfile");
  const [buildContext, setBuildContext] = useState(".");
  const [envText, setEnvText] = useState("");
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
      if (!editing) {
        setRepoUrl(p.project.repoUrl);
        setBranch(p.project.branch);
        setPort(String(p.project.port));
        setDockerfilePath(p.project.dockerfilePath);
        setBuildContext(p.project.buildContext);
        setEnvText(envToText(p.project.env));
        setAutoDeploy(p.project.autoDeploy);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id, editing]);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [user, refresh]);

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
          autoDeploy,
        }),
      });
      setEditing(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this project and destroy its container?")) return;
    await api(`/api/projects/${id}`, { method: "DELETE" });
    router.replace("/dashboard");
  }

  if (loading || !user) {
    return <div className="auth-wrap muted">Loading…</div>;
  }

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

      <div className="grid-2">
        <section className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Canvas</h2>
            {project ? <StatusBadge status={project.status} /> : null}
          </div>
          {project ? (
            <>
              <p className="muted mono" style={{ marginTop: 12 }}>
                Path /p/{project.name}/ · {project.hostname}
                <br />
                Image {project.imageTag ?? "none"}
              </p>
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => void api(`/api/projects/${id}/restart`, { method: "POST" }).then(refresh)}
                >
                  Restart
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => void api(`/api/projects/${id}/stop`, { method: "POST" }).then(refresh)}
                >
                  Stop
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={!project.previousImageTag}
                  onClick={() => void deploy(true)}
                >
                  Redeploy prev
                </button>
                <button className="btn danger" type="button" onClick={() => void remove()}>
                  Delete
                </button>
              </div>

              <h2 style={{ marginTop: 24 }}>Settings</h2>
              {!editing ? (
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => setEditing(true)}
                >
                  Edit service
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
                      Context
                      <input
                        value={buildContext}
                        onChange={(e) => setBuildContext(e.target.value)}
                      />
                    </label>
                  </div>
                  <label className="field">
                    Variables
                    <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} />
                  </label>
                  <label className="row" style={{ color: "var(--muted)" }}>
                    <input
                      type="checkbox"
                      checked={autoDeploy}
                      onChange={(e) => setAutoDeploy(e.target.checked)}
                    />
                    Auto-deploy on GitHub push
                  </label>
                  <div className="row">
                    <button className="btn" type="button" disabled={busy} onClick={() => void save()}>
                      Save
                    </button>
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => setEditing(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="muted">Loading project…</p>
          )}
        </section>

        <section className="panel">
          <h2>Deployments</h2>
          <div className="list">
            {deploys.length === 0 ? (
              <p className="muted">No deploys yet</p>
            ) : (
              deploys.slice(0, 12).map((d) => (
                <div
                  key={d.id}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: 12,
                    padding: 12,
                    background: "var(--bg-elevated)",
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <StatusBadge status={d.status} />
                    <span className="muted mono" style={{ fontSize: "0.78rem" }}>
                      {d.triggeredBy}
                    </span>
                  </div>
                  <div className="muted mono" style={{ fontSize: "0.78rem", marginTop: 6 }}>
                    {d.commitSha?.slice(0, 12) ?? "—"} · {new Date(d.createdAt).toLocaleString()}
                  </div>
                  {d.error ? <p className="error">{d.error}</p> : null}
                  {d.log ? (
                    <pre className="logs" style={{ marginTop: 8, maxHeight: 120 }}>
                      {d.log.slice(-2500)}
                    </pre>
                  ) : null}
                </div>
              ))
            )}
          </div>
          <h2 style={{ marginTop: 20 }}>Runtime logs</h2>
          <pre className="logs">{logs || "No container logs yet"}</pre>
        </section>
      </div>
    </AppShell>
  );
}
