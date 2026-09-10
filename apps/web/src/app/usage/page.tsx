"use client";

import { useCallback, useEffect, useState } from "react";
import {
  formatBytes,
  type UsageSummary,
} from "@laptop-paas/shared";
import { AppShell, Meter, StatusBadge } from "@/components/AppShell";
import { useRequireAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

export default function UsagePage() {
  const { user, loading } = useRequireAuth();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ usage: UsageSummary }>("/api/usage");
      setUsage(res.usage);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const id = setInterval(() => void refresh(), 8000);
    return () => clearInterval(id);
  }, [user, refresh]);

  if (loading || !user) {
    return <div className="auth-wrap muted">Loading…</div>;
  }

  return (
    <AppShell title="Usage & performance">
      {error ? <p className="error">{error}</p> : null}
      {!usage ? (
        <p className="muted">Loading usage…</p>
      ) : (
        <>
          <div className="grid-3" style={{ marginBottom: 12 }}>
            <div className="metric-card">
              <div className="label">Services</div>
              <div className="value">
                {usage.projectsUsed}
                <span className="muted" style={{ fontSize: "0.9rem" }}>
                  {" "}
                  / {usage.projectsLimit}
                </span>
              </div>
              <Meter
                value={usage.projectsUsed}
                max={Math.max(usage.projectsLimit, 1)}
              />
              <div className="sub">{usage.runningServices} running now</div>
            </div>
            <div className="metric-card">
              <div className="label">Databases</div>
              <div className="value">
                {usage.databasesUsed}
                <span className="muted" style={{ fontSize: "0.9rem" }}>
                  {" "}
                  / {usage.databasesLimit}
                </span>
              </div>
              <Meter
                value={usage.databasesUsed}
                max={Math.max(usage.databasesLimit, 1)}
              />
              <div className="sub">{usage.plan.name} plan</div>
            </div>
            <div className="metric-card">
              <div className="label">Deploys (24h)</div>
              <div className="value">{usage.deploysLast24h}</div>
              <div className="sub">
                {usage.failedDeploysLast24h} failed · reserved{" "}
                {formatBytes(usage.reservedMemoryBytes)}
              </div>
            </div>
          </div>

          <div className="grid-2">
            <section className="panel">
              <h2>Plan capacity</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                Self-hosted limits mirror Railway/Render quotas without billing.
              </p>
              <div className="list">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">Default RAM / service</span>
                  <span className="mono">
                    {formatBytes(usage.plan.defaultMemoryBytes)}
                  </span>
                </div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">Default CPU / service</span>
                  <span className="mono">
                    {(usage.plan.defaultCpuNano / 1e9).toFixed(1)} vCPU
                  </span>
                </div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">Reserved CPU (all services)</span>
                  <span className="mono">
                    {(usage.reservedCpuNano / 1e9).toFixed(1)} vCPU
                  </span>
                </div>
              </div>
            </section>

            <section className="panel">
              <h2>Recent activity</h2>
              <div className="list">
                {usage.recentDeploys.length === 0 ? (
                  <p className="muted">No deploys yet</p>
                ) : (
                  usage.recentDeploys.map((d) => (
                    <div
                      key={d.id}
                      style={{
                        border: "1px solid var(--line)",
                        borderRadius: 6,
                        padding: 10,
                      }}
                    >
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <strong>{d.projectName}</strong>
                        <StatusBadge status={d.status} />
                      </div>
                      <div className="muted mono" style={{ fontSize: "0.75rem", marginTop: 4 }}>
                        {d.triggeredBy} · {new Date(d.createdAt).toLocaleString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </AppShell>
  );
}
