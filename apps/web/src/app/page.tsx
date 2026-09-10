"use client";

import { useCallback, useEffect, useState } from "react";
import type { Deploy, ManagedDatabase, Project } from "@laptop-paas/shared";
import {
  api,
  getApiUrl,
  getToken,
  setApiUrl,
  setToken,
} from "@/lib/api";

type Tab = "projects" | "databases";

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

export default function HomePage() {
  const [tab, setTab] = useState<Tab>("projects");
  const [adminToken, setAdminToken] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [databases, setDatabases] = useState<ManagedDatabase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deploys, setDeploys] = useState<Deploy[]>([]);
  const [logs, setLogs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [port, setPort] = useState("3000");
  const [dockerfilePath, setDockerfilePath] = useState("Dockerfile");
  const [buildContext, setBuildContext] = useState(".");
  const [envText, setEnvText] = useState("");
  const [memoryMb, setMemoryMb] = useState("512");
  const [cpu, setCpu] = useState("1");
  const [autoDeploy, setAutoDeploy] = useState(true);

  const [dbName, setDbName] = useState("");
  const [dbKind, setDbKind] = useState<"postgres" | "redis">("postgres");
  const [dbProjectId, setDbProjectId] = useState("");

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([
        api<{ projects: Project[] }>("/api/projects"),
        api<{ databases: ManagedDatabase[] }>("/api/databases"),
      ]);
      setProjects(p.projects);
      setDatabases(d.databases);
      setError(null);
      setAuthed(true);
    } catch (err) {
      setAuthed(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const t = getToken();
    setApiBase(getApiUrl());
    if (t) {
      setAdminToken(t);
      void refresh();
    }
  }, [refresh]);

  useEffect(() => {
    if (!selectedId || !authed) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [d, l] = await Promise.all([
          api<{ deploys: Deploy[] }>(`/api/projects/${selectedId}/deploys`),
          api<{ logs: string }>(`/api/projects/${selectedId}/logs`),
        ]);
        if (!cancelled) {
          setDeploys(d.deploys);
          setLogs(l.logs ?? "");
        }
      } catch {
        /* ignore poll errors */
      }
    };
    void tick();
    const id = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedId, authed]);

  useEffect(() => {
    if (!authed) return;
    const id = setInterval(() => void refresh(), 4000);
    return () => clearInterval(id);
  }, [authed, refresh]);

  useEffect(() => {
    if (!selected || editing) return;
    setRepoUrl(selected.repoUrl);
    setBranch(selected.branch);
    setPort(String(selected.port));
    setDockerfilePath(selected.dockerfilePath);
    setBuildContext(selected.buildContext);
    setEnvText(envToText(selected.env));
    setMemoryMb(String(Math.round(selected.memoryLimitBytes / 1024 / 1024)));
    setCpu(String(selected.cpuNanoCpus / 1_000_000_000));
    setAutoDeploy(selected.autoDeploy);
  }, [selected, editing]);

  async function saveToken() {
    setApiUrl(apiBase.trim() || getApiUrl());
    setToken(adminToken.trim());
    await refresh();
  }

  function resetCreateForm() {
    setName("");
    setRepoUrl("");
    setBranch("main");
    setPort("3000");
    setDockerfilePath("Dockerfile");
    setBuildContext(".");
    setEnvText("");
    setMemoryMb("512");
    setCpu("1");
    setAutoDeploy(true);
    setEditing(false);
  }

  async function createProject() {
    setBusy(true);
    setError(null);
    try {
      const { project } = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
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
      resetCreateForm();
      setSelectedId(project.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveProject() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${selectedId}`, {
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
      setEditing(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deploy(projectId: string, redeploy = false) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/deploy`, {
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

  async function stop(projectId: string) {
    await api(`/api/projects/${projectId}/stop`, { method: "POST" });
    await refresh();
  }

  async function restart(projectId: string) {
    await api(`/api/projects/${projectId}/restart`, { method: "POST" });
    await refresh();
  }

  async function removeProject(projectId: string) {
    if (!confirm("Delete this project and destroy its container?")) return;
    await api(`/api/projects/${projectId}`, { method: "DELETE" });
    if (selectedId === projectId) setSelectedId(null);
    await refresh();
  }

  async function createDatabase() {
    setBusy(true);
    try {
      const res = await api<{ redeployQueued?: boolean }>("/api/databases", {
        method: "POST",
        body: JSON.stringify({
          name: dbName,
          kind: dbKind,
          projectId: dbProjectId || undefined,
        }),
      });
      setDbName("");
      if (res.redeployQueued) {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeDatabase(id: string) {
    if (!confirm("Delete this database and its volume?")) return;
    await api(`/api/databases/${id}`, { method: "DELETE" });
    await refresh();
  }

  if (!authed) {
    return (
      <main className="shell">
        <div className="brand">
          <h1>Dockyard</h1>
          <span>self-hosted PaaS</span>
        </div>
        <p className="lead">
          Sign in with your admin token. From another Tailscale device, set the API
          URL to your laptop&apos;s MagicDNS host on port 8080.
        </p>
        <div className="panel" style={{ maxWidth: 480 }}>
          <label>
            API URL
            <input
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              placeholder="http://abhinand:8180"
            />
          </label>
          <label style={{ marginTop: 10 }}>
            Admin token
            <input
              type="password"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              placeholder="ADMIN_TOKEN from .env"
            />
          </label>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => void saveToken()}>
              Enter
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="brand">
        <h1>Dockyard</h1>
        <span>self-hosted PaaS</span>
      </div>
      <p className="lead">
        Push to GitHub and Dockyard builds the latest commit on this machine.
        Prefer path URLs over Tailscale:{" "}
        <code style={{ fontFamily: "var(--mono)" }}>http://&lt;host&gt;/p/&lt;project&gt;/</code>
      </p>

      <div className="tabs">
        <button
          className={`tab ${tab === "projects" ? "active" : ""}`}
          onClick={() => setTab("projects")}
        >
          Projects
        </button>
        <button
          className={`tab ${tab === "databases" ? "active" : ""}`}
          onClick={() => setTab("databases")}
        >
          Databases
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {tab === "projects" ? (
        <div className="grid two">
          <section className="panel">
            <h2 style={{ marginTop: 0 }}>
              {editing && selected ? `Edit ${selected.name}` : "New project"}
            </h2>
            {!editing ? (
              <label>
                Name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="api"
                />
              </label>
            ) : null}
            <div className="row" style={{ marginTop: 10 }}>
              <label>
                Branch
                <input value={branch} onChange={(e) => setBranch(e.target.value)} />
              </label>
              <label>
                Port
                <input value={port} onChange={(e) => setPort(e.target.value)} />
              </label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label>
                GitHub repo URL
                <input
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/you/app.git"
                />
              </label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label>
                Dockerfile
                <input
                  value={dockerfilePath}
                  onChange={(e) => setDockerfilePath(e.target.value)}
                />
              </label>
              <label>
                Build context
                <input
                  value={buildContext}
                  onChange={(e) => setBuildContext(e.target.value)}
                />
              </label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label>
                Memory (MB)
                <input
                  value={memoryMb}
                  onChange={(e) => setMemoryMb(e.target.value)}
                />
              </label>
              <label>
                CPU cores
                <input value={cpu} onChange={(e) => setCpu(e.target.value)} />
              </label>
            </div>
            <label style={{ marginTop: 10 }}>
              Env (KEY=value per line)
              <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} />
            </label>
            <label
              style={{
                marginTop: 10,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              }}
            >
              <input
                type="checkbox"
                checked={autoDeploy}
                onChange={(e) => setAutoDeploy(e.target.checked)}
              />
              Auto-deploy on GitHub push
            </label>
            <div className="row" style={{ marginTop: 14 }}>
              {editing ? (
                <>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void saveProject()}
                  >
                    Save changes
                  </button>
                  <button
                    className="btn secondary"
                    onClick={() => {
                      setEditing(false);
                      resetCreateForm();
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="btn"
                  disabled={busy || !name || !repoUrl}
                  onClick={() => void createProject()}
                >
                  Create project
                </button>
              )}
            </div>

            <h2 style={{ marginTop: 28 }}>Your projects</h2>
            <div className="list">
              {projects.length === 0 ? (
                <div className="empty">No projects yet</div>
              ) : (
                projects.map((p) => (
                  <div
                    key={p.id}
                    className="card"
                    style={{
                      outline:
                        selectedId === p.id ? "1px solid var(--accent)" : undefined,
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      setSelectedId(p.id);
                      setEditing(false);
                    }}
                  >
                    <div
                      className="row"
                      style={{ justifyContent: "space-between" }}
                    >
                      <h3>{p.name}</h3>
                      <span className={`badge ${p.status}`}>{p.status}</span>
                    </div>
                    <div className="meta">/p/{p.name}/ · {p.hostname}</div>
                    <div className="meta">
                      {p.repoUrl} · autoDeploy={String(p.autoDeploy)}
                    </div>
                    <div className="row" style={{ marginTop: 10 }}>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void deploy(p.id);
                        }}
                      >
                        Deploy
                      </button>
                      <button
                        className="btn secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedId(p.id);
                          setEditing(true);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="btn secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          void restart(p.id);
                        }}
                      >
                        Restart
                      </button>
                      <button
                        className="btn secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          void stop(p.id);
                        }}
                      >
                        Stop
                      </button>
                      <button
                        className="btn secondary"
                        disabled={!p.previousImageTag}
                        onClick={(e) => {
                          e.stopPropagation();
                          void deploy(p.id, true);
                        }}
                      >
                        Redeploy prev
                      </button>
                      <button
                        className="btn danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeProject(p.id);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <h2 style={{ marginTop: 0 }}>
              {selected ? selected.name : "Select a project"}
            </h2>
            {selected ? (
              <>
                <p className="meta">
                  Path: /p/{selected.name}/ · Host: {selected.hostname}
                  <br />
                  Image: {selected.imageTag ?? "none"} · Prev:{" "}
                  {selected.previousImageTag ?? "none"}
                </p>
                <h3>Deploys</h3>
                <div className="list">
                  {deploys.length === 0 ? (
                    <div className="empty">No deploys yet</div>
                  ) : (
                    deploys.slice(0, 10).map((d) => (
                      <div key={d.id} className="card">
                        <div
                          className="row"
                          style={{ justifyContent: "space-between" }}
                        >
                          <span className={`badge ${d.status}`}>{d.status}</span>
                          <span className="meta">{d.triggeredBy}</span>
                        </div>
                        <div className="meta">
                          {d.commitSha?.slice(0, 12) ?? "—"} · {d.createdAt}
                        </div>
                        {d.error ? <div className="error">{d.error}</div> : null}
                        {d.log ? (
                          <pre
                            className="logs"
                            style={{ marginTop: 8, maxHeight: 140 }}
                          >
                            {d.log.slice(-3000)}
                          </pre>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
                <h3 style={{ marginTop: 18 }}>Runtime logs</h3>
                <pre className="logs">{logs || "No container logs yet"}</pre>
              </>
            ) : (
              <div className="empty">Choose a project to see deploys and logs</div>
            )}
          </section>
        </div>
      ) : (
        <div className="grid two">
          <section className="panel">
            <h2 style={{ marginTop: 0 }}>Provision database</h2>
            <p className="meta">
              Linking to a project injects DATABASE_URL / REDIS_URL and queues a
              redeploy so the app picks up the new env.
            </p>
            <div className="row">
              <label>
                Name
                <input value={dbName} onChange={(e) => setDbName(e.target.value)} />
              </label>
              <label>
                Kind
                <select
                  value={dbKind}
                  onChange={(e) =>
                    setDbKind(e.target.value as "postgres" | "redis")
                  }
                >
                  <option value="postgres">Postgres</option>
                  <option value="redis">Redis</option>
                </select>
              </label>
            </div>
            <label style={{ marginTop: 10 }}>
              Link to project
              <select
                value={dbProjectId}
                onChange={(e) => setDbProjectId(e.target.value)}
              >
                <option value="">None</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="row" style={{ marginTop: 14 }}>
              <button
                className="btn"
                disabled={busy || !dbName}
                onClick={() => void createDatabase()}
              >
                Create database
              </button>
            </div>
          </section>
          <section className="panel">
            <h2 style={{ marginTop: 0 }}>Databases</h2>
            <div className="list">
              {databases.length === 0 ? (
                <div className="empty">No databases yet</div>
              ) : (
                databases.map((db) => (
                  <div key={db.id} className="card">
                    <div
                      className="row"
                      style={{ justifyContent: "space-between" }}
                    >
                      <h3>
                        {db.name} <span className="meta">({db.kind})</span>
                      </h3>
                      <span className={`badge ${db.status}`}>{db.status}</span>
                    </div>
                    <div className="meta">{db.connectionUrl}</div>
                    <div className="meta">
                      project: {db.projectId ?? "unlinked"}
                    </div>
                    <div className="row" style={{ marginTop: 10 }}>
                      <button
                        className="btn danger"
                        onClick={() => void removeDatabase(db.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
