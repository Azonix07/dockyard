"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@laptop-paas/shared";
import { useAuth } from "@/components/AuthProvider";
import { api, getApiUrl, setApiUrl } from "@/lib/api";

export default function LoginPage() {
  const { loginWithToken } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [showAdmin, setShowAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (apiBase.trim()) setApiUrl(apiBase.trim());
      else setApiUrl(getApiUrl());
      const res = await api<{ user: User; token: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      const user = await loginWithToken(res.token);
      router.replace(
        user.onboardingCompleted || user.id === "admin"
          ? "/dashboard"
          : "/onboarding/plan",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onAdmin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (apiBase.trim()) setApiUrl(apiBase.trim());
      else setApiUrl(getApiUrl());
      await loginWithToken(adminToken.trim());
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <aside className="auth-brand">
        <Link href="/" className="logo">
          <span className="logo-mark" aria-hidden />
          <span>Dockyard</span>
        </Link>
        <div>
          <div className="muted mono" style={{ fontSize: "0.75rem" }}>
            WELCOME BACK
          </div>
          <h1>Pick up where you left off.</h1>
        </div>
        <p className="muted">Projects, databases, and live metrics on this host.</p>
      </aside>
      <div className="auth-panel">
        <div className="auth-card">
          <h1>Log in</h1>
          <p className="sub">Sign in with your Dockyard email.</p>
          <form onSubmit={(e) => void onSubmit(e)}>
            <label className="field">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label className="field">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
            <label className="field">
              API URL <span className="muted">(optional)</span>
              <input
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder={getApiUrl()}
              />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Log in"}
            </button>
          </form>
          <p className="auth-footer">
            New here? <Link href="/signup">Create an account</Link>
            {" · "}
            <button
              type="button"
              className="btn ghost"
              style={{ display: "inline", padding: 0 }}
              onClick={() => setShowAdmin((v) => !v)}
            >
              Admin token
            </button>
          </p>
          {showAdmin ? (
            <form
              onSubmit={(e) => void onAdmin(e)}
              style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}
            >
              <label className="field">
                ADMIN_TOKEN
                <input
                  type="password"
                  value={adminToken}
                  onChange={(e) => setAdminToken(e.target.value)}
                  required
                />
              </label>
              <button className="btn secondary" type="submit" disabled={busy}>
                Enter as admin
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}
