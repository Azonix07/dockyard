"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DATABASE_PRESETS,
  type DatabaseKind,
  type DatabasePreset,
  type ManagedDatabase,
  type Project,
  type ResourceMetrics,
} from "@laptop-paas/shared";
import { AppShell, Meter, StatusBadge } from "@/components/AppShell";
import { useRequireAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

export default function DatabasesPage() {
  const { user, loading } = useRequireAuth();
  const [databases, setDatabases] = useState<ManagedDatabase[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [presets, setPresets] = useState<DatabasePreset[]>(
    Object.values(DATABASE_PRESETS),
  );
  const [kind, setKind] = useState<DatabaseKind>("postgres");
  const [name, setName] = useState("");
  const [version, setVersion] = useState(DATABASE_PRESETS.postgres.defaultVersion);
  const [memoryMb, setMemoryMb] = useState(String(DATABASE_PRESETS.postgres.defaultMemoryMb));
  const [cpu, setCpu] = useState(String(DATABASE_PRESETS.postgres.defaultCpu));
  const [projectId, setProjectId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ResourceMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preset = useMemo(() => DATABASE_PRESETS[kind], [kind]);

  const refresh = useCallback(async () => {
    try {
      const [d, p, pr] = await Promise.all([
        api<{ databases: ManagedDatabase[] }>("/api/databases"),
        api<{ projects: Project[] }>("/api/projects"),
        api<{ presets: DatabasePreset[] }>("/api/database-presets").catch(() => ({
          presets: Object.values(DATABASE_PRESETS),
        })),
      ]);
      setDatabases(d.databases);
      setProjects(p.projects);
      setPresets(pr.presets);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
  }, [user, refresh]);

  useEffect(() => {
    setVersion(preset.defaultVersion);
    setMemoryMb(String(preset.defaultMemoryMb));
    setCpu(String(preset.defaultCpu));
  }, [preset]);

  useEffect(() => {
    if (!selectedId) {
      setMetrics(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api<{ metrics: ResourceMetrics }>(
          `/api/databases/${selectedId}/metrics`,
        );
        if (!cancelled) setMetrics(res.metrics);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedId]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/databases", {
        method: "POST",
        body: JSON.stringify({
          name,
          kind,
          version,
          memoryMb: Number(memoryMb),
          cpu: Number(cpu),
          projectId: projectId || undefined,
        }),
      });
      setName("");
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

  return (
    <AppShell title="Databases">
      {error ? <p className="error">{error}</p> : null}
      <div className="grid-2">
        <form
          className="panel"
          onSubmit={(e) => void onCreate(e)}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <h2>New datastore</h2>
          <p className="muted" style={{ margin: 0 }}>
            Pick an engine — version, RAM, and CPU are prefilled from production-ready presets.
          </p>
          <div className="preset-grid">
            {presets.map((p) => (
              <button
                key={p.kind}
                type="button"
                className={`preset-card ${kind === p.kind ? "selected" : ""}`}
                onClick={() => setKind(p.kind)}
              >
                <div className="engine">{p.category}</div>
                <h4>{p.label}</h4>
                <p>{p.blurb}</p>
              </button>
            ))}
          </div>
          <label className="field">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              required
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
              placeholder={`${kind}-main`}
            />
          </label>
          <div className="row">
            <label className="field">
              Version
              <select value={version} onChange={(e) => setVersion(e.target.value)}>
                {preset.versions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Memory (MB)
              <input value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} />
            </label>
            <label className="field">
              CPU
              <input value={cpu} onChange={(e) => setCpu(e.target.value)} />
            </label>
          </div>
          <label className="field">
            Link to project
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <p className="muted mono" style={{ fontSize: "0.75rem", margin: 0 }}>
            Injects {preset.envKey} · port {preset.port} · image preset {preset.engine} {version}
          </p>
          <button className="btn" type="submit" disabled={busy || !name}>
            Provision {preset.label}
          </button>
        </form>

        <section className="panel">
          <h2>Your datastores</h2>
          <div className="list">
            {databases.length === 0 ? (
              <p className="muted">No databases yet</p>
            ) : (
              databases.map((db) => (
                <button
                  key={db.id}
                  type="button"
                  onClick={() => setSelectedId(db.id)}
                  style={{
                    textAlign: "left",
                    border: `1px solid ${selectedId === db.id ? "var(--accent)" : "var(--line)"}`,
                    borderRadius: 6,
                    padding: 12,
                    background: "var(--bg)",
                    color: "inherit",
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>
                      {db.name}{" "}
                      <span className="muted">
                        ({DATABASE_PRESETS[db.kind]?.label ?? db.kind})
                      </span>
                    </strong>
                    <StatusBadge status={db.status} />
                  </div>
                  <div className="muted mono" style={{ fontSize: "0.72rem", marginTop: 6 }}>
                    {db.config?.image ?? db.kind} · {db.connectionUrl}
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="btn danger"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!confirm("Delete this database and its volume?")) return;
                        void api(`/api/databases/${db.id}`, { method: "DELETE" }).then(
                          refresh,
                        );
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </button>
              ))
            )}
          </div>

          {selectedId && metrics ? (
            <div style={{ marginTop: 16 }}>
              <h2>Live metrics</h2>
              {metrics.available ? (
                <div className="grid-2">
                  <div className="metric-card">
                    <div className="label">CPU</div>
                    <div className="value">{metrics.cpuPercent?.toFixed(1)}%</div>
                    <Meter value={metrics.cpuPercent ?? 0} />
                  </div>
                  <div className="metric-card">
                    <div className="label">Memory</div>
                    <div className="value">{metrics.memoryPercent?.toFixed(1)}%</div>
                    <Meter value={metrics.memoryPercent ?? 0} />
                  </div>
                </div>
              ) : (
                <p className="muted">Container offline or stats unavailable</p>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
