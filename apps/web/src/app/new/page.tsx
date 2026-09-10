"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Project } from "@laptop-paas/shared";
import { AppShell } from "@/components/AppShell";
import { useRequireAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

type Mode = "pick" | "github" | "empty";

export default function NewProjectPage() {
  const { user, loading } = useRequireAuth();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("pick");
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [port, setPort] = useState("3000");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(opts: { deployNow: boolean; withRepo: boolean }) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          repoUrl: opts.withRepo ? repoUrl : "",
          branch,
          port: Number(port),
          deployNow: opts.deployNow,
          autoDeploy: true,
        }),
      });
      router.replace(`/project/${res.project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onGithub(e: FormEvent) {
    e.preventDefault();
    await create({ deployNow: true, withRepo: true });
  }

  async function onEmpty(e: FormEvent) {
    e.preventDefault();
    await create({ deployNow: false, withRepo: false });
  }

  if (loading || !user) {
    return <div className="auth-wrap muted">Loading…</div>;
  }

  return (
    <AppShell title="New Project">
      {mode === "pick" ? (
        <div className="choice-grid" style={{ maxWidth: 720 }}>
          <button
            type="button"
            className="choice-card"
            onClick={() => setMode("github")}
          >
            <h3>Deploy from GitHub repo</h3>
            <p>
              Connect a repository URL. Dockyard builds on push and deploys to
              this machine over Tailscale.
            </p>
          </button>
          <button
            type="button"
            className="choice-card"
            onClick={() => setMode("empty")}
          >
            <h3>Empty project</h3>
            <p>
              Create a blank project canvas, then attach a repo or database when
              you&apos;re ready.
            </p>
          </button>
        </div>
      ) : null}

      {mode === "github" ? (
        <form
          className="panel"
          style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 14 }}
          onSubmit={(e) => void onGithub(e)}
        >
          <h2>Deploy from GitHub</h2>
          <label className="field">
            Project name
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="api"
              required
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
            />
          </label>
          <label className="field">
            GitHub repo URL
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/you/app.git"
              required
            />
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
          {error ? <p className="error">{error}</p> : null}
          <div className="row">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Creating…" : "Deploy Now"}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => setMode("pick")}
            >
              Back
            </button>
          </div>
        </form>
      ) : null}

      {mode === "empty" ? (
        <form
          className="panel"
          style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 14 }}
          onSubmit={(e) => void onEmpty(e)}
        >
          <h2>Empty project</h2>
          <label className="field">
            Project name
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="playground"
              required
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="row">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create project"}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => setMode("pick")}
            >
              Back
            </button>
          </div>
        </form>
      ) : null}
    </AppShell>
  );
}
