"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { GitHubRepo, GitHubStatus, Project } from "@laptop-paas/shared";
import { AppShell } from "@/components/AppShell";
import { useRequireAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

type Mode = "pick" | "github" | "empty";

function slugifyRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function PatConnect({
  busy,
  setBusy,
  onConnected,
  onError,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  onConnected: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [token, setToken] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      await api("/api/github/token", {
        method: "POST",
        body: JSON.stringify({ token: token.trim() }),
      });
      setToken("");
      await onConnected();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <p className="muted" style={{ margin: 0, fontSize: "0.9rem" }}>
        Paste a GitHub Personal Access Token with the{" "}
        <code className="mono">repo</code> scope.{" "}
        <a
          href="https://github.com/settings/tokens/new?scopes=repo&description=Runbase"
          target="_blank"
          rel="noreferrer"
        >
          Create one
        </a>
        .
      </p>
      <label className="field">
        Personal access token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_…"
          required
          autoComplete="off"
        />
      </label>
      <button className="btn" type="submit" disabled={busy || token.length < 20}>
        {busy ? "Connecting…" : "Connect with token"}
      </button>
    </form>
  );
}

export default function NewProjectClient() {
  const { user, loading } = useRequireAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>("pick");
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [port, setPort] = useState("3000");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [ghStatus, setGhStatus] = useState<GitHubStatus | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  const [selected, setSelected] = useState<GitHubRepo | null>(null);
  const [connecting, setConnecting] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api<GitHubStatus>("/api/github/status");
      setGhStatus(s);
      return s;
    } catch {
      setGhStatus(null);
      return null;
    }
  }, []);

  const loadRepos = useCallback(async (q?: string) => {
    setReposLoading(true);
    setError(null);
    try {
      const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
      const res = await api<{ repos: GitHubRepo[] }>(`/api/github/repos${qs}`);
      setRepos(res.repos);
    } catch (err) {
      setRepos([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReposLoading(false);
    }
  }, []);

  useEffect(() => {
    if (loading || !user) return;
    void loadStatus();
  }, [loading, user, loadStatus]);

  useEffect(() => {
    const gh = searchParams.get("github");
    if (gh === "connected") {
      setMode("github");
      setError(null);
      void loadStatus().then((s) => {
        if (s?.connected || s?.canListViaHostToken) void loadRepos();
      });
    } else if (gh === "error") {
      setMode("github");
      setError(
        `GitHub connect failed: ${searchParams.get("reason") ?? "unknown"}`,
      );
    }
  }, [searchParams, loadStatus, loadRepos]);

  useEffect(() => {
    if (mode !== "github") return;
    if (!ghStatus) return;
    if (ghStatus.connected || ghStatus.canListViaHostToken) {
      void loadRepos();
    }
  }, [mode, ghStatus, loadRepos]);

  async function connectGitHub() {
    setConnecting(true);
    setError(null);
    try {
      const res = await api<{ url: string }>(
        "/api/github/connect?returnTo=/new",
      );
      window.location.href = res.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConnecting(false);
    }
  }

  async function disconnectGitHub() {
    setBusy(true);
    try {
      await api("/api/github/disconnect", { method: "DELETE" });
      setSelected(null);
      setRepos([]);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function pickRepo(repo: GitHubRepo) {
    setSelected(repo);
    setName(slugifyRepoName(repo.name));
    setRepoUrl(repo.cloneUrl);
    setBranch(repo.defaultBranch || "main");
  }

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

  async function deploySelected() {
    if (!selected) {
      setError("Select a repository first");
      return;
    }
    await create({ deployNow: true, withRepo: true });
  }

  async function onEmpty(e: FormEvent) {
    e.preventDefault();
    await create({ deployNow: false, withRepo: false });
  }

  if (loading || !user) {
    return <div className="auth-wrap muted">Loading…</div>;
  }

  const canBrowse = Boolean(
    ghStatus?.connected || ghStatus?.canListViaHostToken,
  );

  return (
    <AppShell title="New Project">
      {mode === "pick" ? (
        <div className="choice-grid" style={{ maxWidth: 720 }}>
          <button
            type="button"
            className="choice-card"
            onClick={() => setMode("github")}
          >
            <h3>Deploy from GitHub</h3>
            <p>
              Connect your GitHub account, pick a repo, and deploy to this
              machine in one click.
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
        <div
          className="panel"
          style={{
            maxWidth: 720,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div
            className="row"
            style={{ justifyContent: "space-between", alignItems: "center" }}
          >
            <h2 style={{ margin: 0 }}>Deploy from GitHub</h2>
            <button
              className="btn secondary"
              type="button"
              onClick={() => setMode("pick")}
            >
              Back
            </button>
          </div>

          {!canBrowse ? (
            <div className="github-connect">
              <h3 style={{ margin: "0 0 8px" }}>Connect GitHub</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Authorize Runbase once — then pick any repo and deploy, like
                Railway.
              </p>
              {ghStatus?.configured ? (
                <button
                  className="btn"
                  type="button"
                  style={{ width: "100%", maxWidth: 320, padding: "14px 18px" }}
                  disabled={connecting}
                  onClick={() => void connectGitHub()}
                >
                  {connecting ? "Redirecting to GitHub…" : "Connect GitHub"}
                </button>
              ) : (
                <>
                  <p className="error">
                    GitHub Connect is still being configured on this host.
                  </p>
                  <PatConnect
                    busy={busy}
                    onConnected={async () => {
                      await loadStatus();
                      await loadRepos();
                    }}
                    onError={setError}
                    setBusy={setBusy}
                  />
                </>
              )}
            </div>
          ) : (
            <>
              <div
                className="row"
                style={{
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <p className="muted" style={{ margin: 0 }}>
                  Connected as{" "}
                  <strong style={{ color: "var(--text)" }}>
                    {ghStatus?.login ?? "host token"}
                  </strong>
                </p>
                {ghStatus?.connected ? (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => void disconnectGitHub()}
                  >
                    Disconnect
                  </button>
                ) : null}
              </div>

              <label className="field">
                Search repositories
                <input
                  value={repoQuery}
                  onChange={(e) => setRepoQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void loadRepos(repoQuery);
                    }
                  }}
                  placeholder="Filter by name…"
                />
              </label>
              <div className="row">
                <button
                  className="btn secondary"
                  type="button"
                  disabled={reposLoading}
                  onClick={() => void loadRepos(repoQuery)}
                >
                  {reposLoading ? "Loading…" : "Refresh"}
                </button>
              </div>

              <div className="repo-list">
                {reposLoading && repos.length === 0 ? (
                  <p className="muted">Loading repositories…</p>
                ) : null}
                {!reposLoading && repos.length === 0 ? (
                  <p className="muted">No repositories found.</p>
                ) : null}
                {repos.map((repo) => (
                  <button
                    key={repo.id}
                    type="button"
                    className={`repo-row${selected?.id === repo.id ? " selected" : ""}`}
                    onClick={() => pickRepo(repo)}
                  >
                    <div className="repo-row-main">
                      <span className="repo-name">{repo.fullName}</span>
                      {repo.private ? (
                        <span className="repo-badge">Private</span>
                      ) : (
                        <span className="repo-badge public">Public</span>
                      )}
                    </div>
                    <div className="repo-meta muted">
                      {repo.defaultBranch}
                      {repo.description ? ` · ${repo.description}` : ""}
                    </div>
                  </button>
                ))}
              </div>

              {selected ? (
                <div className="deploy-selected">
                  <div className="row">
                    <label className="field">
                      Project name
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value.toLowerCase())}
                        required
                        pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
                      />
                    </label>
                    <label className="field">
                      Branch
                      <input
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      Port
                      <input
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                      />
                    </label>
                  </div>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || !name}
                    onClick={() => void deploySelected()}
                  >
                    {busy ? "Deploying…" : `Deploy ${selected.fullName}`}
                  </button>
                </div>
              ) : (
                <p className="muted">Select a repository to deploy.</p>
              )}
            </>
          )}

          {error ? <p className="error">{error}</p> : null}
        </div>
      ) : null}

      {mode === "empty" ? (
        <form
          className="panel"
          style={{
            maxWidth: 560,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
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
