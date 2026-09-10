"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PLANS, type PlanId, type User } from "@laptop-paas/shared";
import { useAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

export default function PlanOnboardingPage() {
  const { user, loading, refresh } = useAuth();
  const router = useRouter();
  const [selected, setSelected] = useState<PlanId>("hobby");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (user.onboardingCompleted || user.id === "admin") {
      router.replace("/dashboard");
    }
  }, [user, loading, router]);

  async function continueWithPlan() {
    setBusy(true);
    setError(null);
    try {
      await api<{ user: User }>("/api/auth/plan", {
        method: "POST",
        body: JSON.stringify({ plan: selected }),
      });
      await refresh();
      router.replace("/dashboard");
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
    <div className="auth-wrap" style={{ alignItems: "start", paddingTop: 64 }}>
      <div style={{ width: "min(860px, 100%)", textAlign: "center" }}>
        <h1 style={{ margin: "0 0 8px", fontSize: "2rem", letterSpacing: "-0.04em" }}>
          Choose a plan
        </h1>
        <p className="muted" style={{ margin: "0 0 28px" }}>
          Self-hosted billing is free — plans set resource limits on this machine.
        </p>
        <div className="plan-grid">
          {(Object.keys(PLANS) as PlanId[]).map((id) => {
            const plan = PLANS[id];
            return (
              <button
                key={id}
                type="button"
                className={`plan-card ${selected === id ? "selected" : ""}`}
                onClick={() => setSelected(id)}
              >
                <div className="muted" style={{ fontWeight: 600 }}>
                  {plan.name}
                </div>
                <div className="price">
                  {plan.priceLabel}
                  <span style={{ fontSize: "0.9rem", color: "var(--muted)", fontWeight: 500 }}>
                    {" "}
                    / {plan.period}
                  </span>
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  {plan.description}
                </p>
                <ul>
                  {plan.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>
        {error ? <p className="error" style={{ marginTop: 16 }}>{error}</p> : null}
        <div style={{ marginTop: 24 }}>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void continueWithPlan()}
          >
            {busy ? "Saving…" : `Continue with ${PLANS[selected].name}`}
          </button>
        </div>
      </div>
    </div>
  );
}
