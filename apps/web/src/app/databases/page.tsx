"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ManagedDatabase, Project } from "@laptop-paas/shared";
import { AppShell, StatusBadge } from "@/components/AppShell";
import { useRequireAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

export default function DatabasesPage() {
  const { user, loading } = useRequireAuth();
  const [databases, setDatabases] = useState<ManagedDatabase[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"postgres" | "redis">("postgres");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        api<{ databases: ManagedDatabase[] }>("/api/databases"),
        api<{ projects: Project[] }>("/api/projects"),
      ]);
      setDatabases(d.databases);
      setProjects(p.projects);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
  }, [user, refresh]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/databases", {
        method: "POST",
        body: JSON.stringify({
          name,
          kind,
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
        <form className="panel" onSubmit={(e) => void onCreate(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2>Provision database</h2>
          <p className="muted" style={{ margin: 0 }}>
            Linking injects DATABASE_URL / REDIS_URL and can redeploy the project.
          </p>
          <label className="field">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              required
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
            />
          </label>
          <label className="field">
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as "postgres" | "redis")}>
              <option value="postgres">Postgres</option>
              <option value="redis">Redis</option>
            </select>
          </label>
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
          <button className="btn" type="submit" disabled={busy || !name}>
            Create database
          </button>
        </form>

        <section className="panel">
          <h2>Your databases</h2>
          <div className="list">
            {databases.length === 0 ? (
              <p className="muted">No databases yet</p>
            ) : (
              databases.map((db) => (
                <div
                  key={db.id}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: 12,
                    padding: 14,
                    background: "var(--bg-elevated)",
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>
                      {db.name} <span className="muted">({db.kind})</span>
                    </strong>
                    <StatusBadge status={db.status} />
                  </div>
                  <div className="muted mono" style={{ fontSize: "0.78rem", marginTop: 8 }}>
                    {db.connectionUrl}
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <button
                      className="btn danger"
                      type="button"
                      onClick={() => {
                        if (!confirm("Delete this database and its volume?")) return;
                        void api(`/api/databases/${db.id}`, { method: "DELETE" }).then(refresh);
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
      </div>
    </AppShell>
  );
}
