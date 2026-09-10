"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Project } from "@laptop-paas/shared";
import { AppShell, StatusBadge } from "@/components/AppShell";
import { useRequireAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

export default function DashboardPage() {
  const { user, loading } = useRequireAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ projects: Project[] }>("/api/projects");
      setProjects(res.projects);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [user, refresh]);

  if (loading || !user) {
    return <div className="auth-wrap muted">Loading…</div>;
  }

  return (
    <AppShell
      title="Projects"
      actions={
        <Link href="/new" className="btn">
          New Project
        </Link>
      }
    >
      {error ? <p className="error">{error}</p> : null}

      {projects.length === 0 ? (
        <div className="empty-state">
          <h2>Create a new project</h2>
          <p>
            Deploy from GitHub or start empty — then add services, databases, and
            env vars the Railway way.
          </p>
          <Link href="/new" className="btn">
            New Project
          </Link>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((p, i) => (
            <Link
              key={p.id}
              href={`/project/${p.id}`}
              className="project-card"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3>{p.name}</h3>
                <StatusBadge status={p.status} />
              </div>
              <div className="meta" style={{ marginTop: 10 }}>
                /p/{p.name}/
              </div>
              <div className="meta" style={{ marginTop: 4 }}>
                {p.repoUrl || "Empty project"}
              </div>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
