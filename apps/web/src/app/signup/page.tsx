"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@laptop-paas/shared";
import { useAuth } from "@/components/AuthProvider";
import { BrandLogo, PRODUCT_NAME } from "@/components/Brand";
import { api, getApiUrl, setApiUrl } from "@/lib/api";

export default function SignupPage() {
  const { loginWithToken } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (apiBase.trim()) setApiUrl(apiBase.trim());
      else setApiUrl(getApiUrl());
      const res = await api<{ user: User; token: string }>("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ name, email, password }),
      });
      await loginWithToken(res.token);
      router.replace("/onboarding/plan");
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
          <BrandLogo />
        </Link>
        <div>
          <div className="muted mono" style={{ fontSize: "0.75rem" }}>
            ACCOUNT
          </div>
          <h1>Build on your own iron.</h1>
        </div>
        <p className="muted">Email signup · plan limits · project canvas</p>
      </aside>
      <div className="auth-panel">
        <div className="auth-card">
          <h1>Create account</h1>
          <p className="sub">Use any email — accounts stay on this {PRODUCT_NAME} host.</p>
          <form onSubmit={(e) => void onSubmit(e)}>
            <label className="field">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
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
                minLength={8}
                autoComplete="new-password"
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
              {busy ? "Creating…" : "Create account"}
            </button>
          </form>
          <p className="auth-footer">
            Already have an account? <Link href="/login">Log in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
