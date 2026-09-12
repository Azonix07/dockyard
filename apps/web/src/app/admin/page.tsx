"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  formatBytes,
  type AdminAccount,
  type AdminDatabaseRow,
  type AdminOverview,
  type AdminProjectRow,
  type DeviceHealth,
  type UserElectricityShare,
  type Plan,
  type PlanId,
} from "@laptop-paas/shared";
import { AppShell, Meter, StatusBadge } from "@/components/AppShell";
import { useRequireAdmin } from "@/components/AuthProvider";
import { api } from "@/lib/api";

type Tab = "overview" | "device" | "accounts" | "fleet" | "activity";

function healthTone(status: DeviceHealth["status"]): string {
  if (status === "healthy") return "running";
  if (status === "warning") return "deploying";
  if (status === "critical") return "failed";
  return "idle";
}

function inr(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export default function AdminPage() {
  const { user, loading } = useRequireAdmin();
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [device, setDevice] = useState<DeviceHealth | null>(null);
  const [userPower, setUserPower] = useState<UserElectricityShare[]>([]);
  const [publicHost, setPublicHost] = useState("");
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [projects, setProjects] = useState<AdminProjectRow[]>([]);
  const [databases, setDatabases] = useState<AdminDatabaseRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refreshOverview = useCallback(async () => {
    const res = await api<{
      overview: AdminOverview;
      publicHost: string;
    }>("/api/admin/overview");
    setOverview(res.overview);
    setPublicHost(res.publicHost);
  }, []);

  const refreshDevice = useCallback(async () => {
    const res = await api<{
      device: DeviceHealth;
      users: UserElectricityShare[];
    }>("/api/admin/device");
    setDevice(res.device);
    setUserPower(res.users ?? []);
  }, []);

  const refreshAccounts = useCallback(async () => {
    const res = await api<{ accounts: AdminAccount[]; plans: Plan[] }>(
      "/api/admin/accounts",
    );
    setAccounts(res.accounts);
    setPlans(res.plans);
  }, []);

  const refreshFleet = useCallback(async () => {
    const res = await api<{
      projects: AdminProjectRow[];
      databases: AdminDatabaseRow[];
    }>("/api/admin/fleet");
    setProjects(res.projects);
    setDatabases(res.databases);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      if (tab === "overview" || tab === "activity") {
        await refreshOverview();
      }
      if (tab === "overview" || tab === "device") {
        await refreshDevice();
      }
      if (tab === "accounts") await refreshAccounts();
      if (tab === "fleet") await refreshFleet();
      if (tab === "overview") {
        await Promise.all([refreshAccounts(), refreshFleet()]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tab, refreshOverview, refreshDevice, refreshAccounts, refreshFleet]);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const id = setInterval(
      () => void refresh(),
      tab === "device" ? 8_000 : 12_000,
    );
    return () => clearInterval(id);
  }, [user, refresh, tab]);

  async function setAccountPlan(accountId: string, plan: PlanId) {
    setBusyId(accountId);
    try {
      await api(`/api/admin/accounts/${accountId}`, {
        method: "PATCH",
        body: JSON.stringify({ plan, onboardingCompleted: true }),
      });
      await refreshAccounts();
      if (overview) await refreshOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (loading || !user) {
    return <div className="auth-wrap muted">Loading…</div>;
  }

  const host = overview?.host;
  const memPct =
    host?.memTotalBytes && overview
      ? (overview.fleet.reservedMemoryBytes / host.memTotalBytes) * 100
      : 0;
  const cpuPct =
    host?.ncpu && overview
      ? (overview.fleet.reservedCpuNano / 1e9 / host.ncpu) * 100
      : 0;

  return (
    <AppShell
      title="Super admin"
      actions={
        <button className="btn secondary" type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      }
    >
      <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
        Platform monitor for accounts, fleet, device health, and deploys
        {publicHost ? (
          <>
            {" "}
            · host <span className="mono">{publicHost}</span>
          </>
        ) : null}
      </p>

      {error ? <p className="error">{error}</p> : null}

      <div className="tabs-row">
        {(
          [
            ["overview", "Overview"],
            ["device", "Device"],
            ["accounts", "Accounts"],
            ["fleet", "Fleet"],
            ["activity", "Activity"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "tab-btn active" : "tab-btn"}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && overview ? (
        <>
          <div className="grid-3" style={{ marginBottom: 12 }}>
            <div className="metric-card">
              <div className="label">Accounts</div>
              <div className="value">{overview.accounts.total}</div>
              <div className="sub">
                {overview.accounts.hobby} hobby · {overview.accounts.pro} pro ·{" "}
                {overview.accounts.newLast7d} new (7d)
              </div>
            </div>
            <div className="metric-card">
              <div className="label">Services</div>
              <div className="value">{overview.fleet.projects}</div>
              <div className="sub">
                {overview.fleet.running} running · {overview.fleet.deploying}{" "}
                deploying · {overview.fleet.failed} error
              </div>
            </div>
            <div className="metric-card">
              <div className="label">Device health</div>
              <div className="value">
                {device ? `${device.score}` : "—"}
                {device ? (
                  <span className="muted" style={{ fontSize: "0.9rem" }}>
                    {" "}
                    / 100
                  </span>
                ) : null}
              </div>
              <div className="sub">
                {device ? (
                  <>
                    <StatusBadge status={healthTone(device.status)} />
                    {device.temperatures.thermalZoneC != null
                      ? ` · ${device.temperatures.thermalZoneC}°C`
                      : ""}
                    {device.power.watts != null
                      ? ` · ${device.power.watts} W`
                      : ""}
                  </>
                ) : (
                  "Collecting…"
                )}
              </div>
            </div>
          </div>

          <div className="grid-2" style={{ marginBottom: 12 }}>
            <section className="panel">
              <h2>Host capacity</h2>
              {!host?.available ? (
                <p className="muted">Docker host unreachable</p>
              ) : (
                <div className="list">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Machine</span>
                    <span className="mono">
                      {host.name} · {host.ncpu} CPU ·{" "}
                      {formatBytes(host.memTotalBytes ?? 0)}
                    </span>
                  </div>
                  <div>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="muted">Reserved RAM</span>
                      <span className="mono">
                        {formatBytes(overview.fleet.reservedMemoryBytes)} /{" "}
                        {formatBytes(host.memTotalBytes ?? 0)}
                      </span>
                    </div>
                    <Meter value={memPct} max={100} />
                  </div>
                  <div>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="muted">Reserved vCPU</span>
                      <span className="mono">
                        {(overview.fleet.reservedCpuNano / 1e9).toFixed(1)} /{" "}
                        {host.ncpu}
                      </span>
                    </div>
                    <Meter value={cpuPct} max={100} />
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Containers</span>
                    <span className="mono">
                      {host.containersRunning}/{host.containers} running ·{" "}
                      {host.paasContainers} paas-*
                    </span>
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Docker</span>
                    <span className="mono">
                      {host.dockerVersion} · {host.driver}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: "0.75rem" }}>
                    {host.operatingSystem} · {host.architecture} ·{" "}
                    {host.images} images
                  </div>
                </div>
              )}
            </section>

            <section className="panel">
              <h2>Workload & queues</h2>
              <div className="list">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">Databases</span>
                  <span>
                    {overview.fleet.databasesRunning}/{overview.fleet.databases}{" "}
                    running
                  </span>
                </div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">GitHub connected</span>
                  <span>{overview.accounts.withGithub} accounts</span>
                </div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">Jobs queued</span>
                  <span className="mono">{overview.activity.jobsQueued}</span>
                </div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">Jobs running</span>
                  <span className="mono">{overview.activity.jobsRunning}</span>
                </div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">Jobs failed</span>
                  <span className="mono">{overview.activity.jobsFailed}</span>
                </div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">Idle / stopped services</span>
                  <span>
                    {overview.fleet.idle} / {overview.fleet.stopped}
                  </span>
                </div>
              </div>
            </section>
          </div>

          <div className="grid-2">
            <section className="panel">
              <h2>Newest accounts</h2>
              <div className="list">
                {overview.recentAccounts.map((a) => (
                  <div key={a.id} className="admin-row">
                    <div>
                      <strong>{a.name}</strong>
                      <div className="muted mono" style={{ fontSize: "0.75rem" }}>
                        {a.email}
                      </div>
                    </div>
                    <span className="plan-chip">{a.plan}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="panel">
              <h2>Live fleet snapshot</h2>
              <div className="list">
                {projects.slice(0, 8).map((p) => (
                  <div key={p.id} className="admin-row">
                    <div>
                      <Link href={`/project/${p.id}`}>
                        <strong>{p.name}</strong>
                      </Link>
                      <div className="muted" style={{ fontSize: "0.75rem" }}>
                        {p.ownerEmail ?? "admin"} · {formatBytes(p.memoryLimitBytes)}
                      </div>
                    </div>
                    <StatusBadge status={p.status} />
                  </div>
                ))}
                {projects.length === 0 ? (
                  <p className="muted">No projects yet</p>
                ) : null}
              </div>
            </section>
          </div>
        </>
      ) : null}

      {tab === "device" ? (
        !device ? (
          <p className="muted">Loading device health…</p>
        ) : (
          <>
            <div className="grid-3" style={{ marginBottom: 12 }}>
              <div className="metric-card">
                <div className="label">Health score</div>
                <div className="value">{device.score}</div>
                <Meter value={device.score} max={100} />
                <div className="sub">
                  <StatusBadge status={healthTone(device.status)} />
                  {device.staleSeconds != null
                    ? ` · sampled ${device.staleSeconds}s ago`
                    : ""}
                </div>
              </div>
              <div className="metric-card">
                <div className="label">Temperature</div>
                <div className="value">
                  {device.temperatures.thermalZoneC != null
                    ? `${device.temperatures.thermalZoneC}°`
                    : "—"}
                </div>
                <div className="sub">
                  Zone
                  {device.temperatures.gpuC != null
                    ? ` · GPU ${device.temperatures.gpuC}°C`
                    : ""}
                  {device.temperatures.cpuLoadPct != null
                    ? ` · CPU ${device.temperatures.cpuLoadPct}%`
                    : ""}
                </div>
              </div>
              <div className="metric-card">
                <div className="label">Power draw</div>
                <div className="value">
                  {device.power.watts != null ? `${device.power.watts}` : "—"}
                  {device.power.watts != null ? (
                    <span className="muted" style={{ fontSize: "0.9rem" }}>
                      {" "}
                      W
                    </span>
                  ) : null}
                </div>
                <div className="sub">
                  {device.power.onAc
                    ? device.power.charging
                      ? "AC · charging"
                      : "AC power"
                    : "On battery"}
                  {device.power.batteryPercent != null
                    ? ` · ${device.power.batteryPercent}%`
                    : ""}
                </div>
              </div>
            </div>

            {device.issues.length > 0 ? (
              <section className="panel" style={{ marginBottom: 12 }}>
                <h2>Alerts</h2>
                <div className="list">
                  {device.issues.map((issue) => (
                    <div key={issue} className="admin-row">
                      <span>{issue}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <div className="grid-2" style={{ marginBottom: 12 }}>
              <section className="panel">
                <h2>Kerala electricity bill (Runbase host)</h2>
                <p className="muted" style={{ marginTop: 0 }}>
                  {device.power.electricity.tariffLabel} ·{" "}
                  {device.power.electricity.authority} · slab ₹
                  {device.power.electricity.slabRateInrPerKwh}/kWh
                  {device.power.electricity.summerSurchargeApplied
                    ? " · summer +₹0.10/unit"
                    : ""}
                  {device.power.electricity.extrapolated
                    ? " · extrapolated from live draw"
                    : ` · based on ${device.power.electricity.measuredHours}h samples`}
                </p>
                <div className="list">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Avg power</span>
                    <span className="mono">
                      {device.power.electricity.avgWatts} W
                      {device.power.electricity.avgWattsLast1h != null
                        ? ` · 1h ${device.power.electricity.avgWattsLast1h} W`
                        : ""}
                    </span>
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>Daily</strong>
                    <span className="mono">
                      {device.power.electricity.daily.kwh} kWh ·{" "}
                      {inr(device.power.electricity.daily.totalInr)}
                    </span>
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>Weekly</strong>
                    <span className="mono">
                      {device.power.electricity.weekly.kwh} kWh ·{" "}
                      {inr(device.power.electricity.weekly.totalInr)}
                    </span>
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>Monthly (30d)</strong>
                    <span className="mono">
                      {device.power.electricity.monthly.kwh} kWh ·{" "}
                      {inr(device.power.electricity.monthly.totalInr)}
                    </span>
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Energy / fixed / surcharge (mo)</span>
                    <span className="mono" style={{ fontSize: "0.75rem" }}>
                      {inr(device.power.electricity.monthly.energyInr)} /{" "}
                      {inr(device.power.electricity.monthly.fixedInr)} /{" "}
                      {inr(device.power.electricity.monthly.surchargeInr)}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: "0.72rem" }}>
                    {device.power.electricity.sourceNote}
                  </div>
                </div>
              </section>

              <section className="panel">
                <h2>Memory & CPU</h2>
                <div className="list">
                  <div>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="muted">RAM used</span>
                      <span className="mono">
                        {device.memory.usedPercent != null
                          ? `${device.memory.usedPercent}%`
                          : "—"}
                        {device.memory.totalBytes != null
                          ? ` · ${formatBytes(device.memory.usedBytes ?? 0)} / ${formatBytes(device.memory.totalBytes)}`
                          : ""}
                      </span>
                    </div>
                    <Meter value={device.memory.usedPercent ?? 0} max={100} />
                  </div>
                  <div>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="muted">Committed</span>
                      <span className="mono">
                        {device.memory.committedPercent != null
                          ? `${device.memory.committedPercent}%`
                          : "—"}
                      </span>
                    </div>
                    <Meter
                      value={device.memory.committedPercent ?? 0}
                      max={100}
                    />
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">CPU clock</span>
                    <span className="mono">
                      {device.clocks.currentMhz ?? "—"} /{" "}
                      {device.clocks.maxMhz ?? "—"} MHz
                    </span>
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Disk busy</span>
                    <span className="mono">
                      {device.diskTimePercent != null
                        ? `${device.diskTimePercent}%`
                        : "—"}
                    </span>
                  </div>
                </div>
              </section>
            </div>

            <section className="panel" style={{ marginBottom: 12 }}>
              <h2>Per-user electricity share</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                Allocated by reserved RAM (projects + databases) as a share of
                host Runbase draw under {device.power.electricity.tariffLabel}.
              </p>
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Share</th>
                      <th>Watts</th>
                      <th>Daily</th>
                      <th>Weekly</th>
                      <th>Monthly</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userPower.map((u) => (
                      <tr key={u.userId ?? u.email}>
                        <td>
                          <strong>{u.name}</strong>
                          <div className="muted mono" style={{ fontSize: "0.72rem" }}>
                            {u.email}
                            {u.plan ? ` · ${u.plan}` : ""}
                            {" · "}
                            {u.projectCount} svc / {u.databaseCount} db
                          </div>
                        </td>
                        <td className="mono">{u.sharePercent}%</td>
                        <td className="mono">{u.avgWatts} W</td>
                        <td className="mono">
                          {u.dailyKwh} kWh
                          <div className="muted">{inr(u.dailyInr)}</div>
                        </td>
                        <td className="mono">
                          {u.weeklyKwh} kWh
                          <div className="muted">{inr(u.weeklyInr)}</div>
                        </td>
                        <td className="mono">
                          {u.monthlyKwh} kWh
                          <div className="muted">{inr(u.monthlyInr)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {userPower.length === 0 ? (
                  <p className="muted">No user allocations yet</p>
                ) : null}
              </div>
            </section>

            <div className="grid-2">
              <section className="panel">
                <h2>Hardware</h2>
                <div className="list">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Model</span>
                    <span>{device.device?.model ?? "—"}</span>
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">CPU</span>
                    <span className="mono" style={{ fontSize: "0.8rem" }}>
                      {device.device?.cpu ?? "—"}
                    </span>
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted">Cores</span>
                    <span className="mono">
                      {device.device?.cores ?? "—"}C /{" "}
                      {device.device?.logicalProcessors ?? "—"}T
                    </span>
                  </div>
                  {device.gpu ? (
                    <>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <span className="muted">GPU</span>
                        <span>{device.gpu.name}</span>
                      </div>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <span className="muted">GPU util / VRAM</span>
                        <span className="mono">
                          {device.gpu.utilizationPct ?? 0}% ·{" "}
                          {device.gpu.memoryUsedMiB ?? 0}/
                          {device.gpu.memoryTotalMiB ?? 0} MiB
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>
              </section>

              <section className="panel">
                <h2>Storage health</h2>
                <div className="list">
                  {device.disks.length === 0 ? (
                    <p className="muted">No disk data</p>
                  ) : (
                    device.disks.map((d) => (
                      <div key={d.name} className="admin-row">
                        <div>
                          <strong>{d.name}</strong>
                          <div className="muted" style={{ fontSize: "0.75rem" }}>
                            {d.mediaType} · {formatBytes(d.sizeBytes)} ·{" "}
                            {d.status}
                          </div>
                        </div>
                        <StatusBadge
                          status={
                            d.health.toLowerCase() === "healthy"
                              ? "running"
                              : "failed"
                          }
                        />
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </>
        )
      ) : null}

      {tab === "accounts" ? (
        <section className="panel">
          <h2>Accounts ({accounts.length})</h2>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Plan</th>
                  <th>Projects</th>
                  <th>DBs</th>
                  <th>GitHub</th>
                  <th>Last deploy</th>
                  <th>Joined</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>
                      <div className="muted mono" style={{ fontSize: "0.72rem" }}>
                        {a.email}
                      </div>
                    </td>
                    <td>
                      <span className="plan-chip">{a.plan}</span>
                    </td>
                    <td className="mono">
                      {a.runningProjects}/{a.projectCount}
                    </td>
                    <td className="mono">{a.databaseCount}</td>
                    <td className="mono">{a.githubLogin ?? "—"}</td>
                    <td className="muted" style={{ fontSize: "0.75rem" }}>
                      {a.lastDeployAt
                        ? new Date(a.lastDeployAt).toLocaleString()
                        : "—"}
                    </td>
                    <td className="muted" style={{ fontSize: "0.75rem" }}>
                      {new Date(a.createdAt).toLocaleDateString()}
                    </td>
                    <td>
                      <select
                        className="field compact"
                        value={a.plan}
                        disabled={busyId === a.id}
                        onChange={(e) =>
                          void setAccountPlan(a.id, e.target.value as PlanId)
                        }
                      >
                        {(plans.length
                          ? plans
                          : [
                              { id: "hobby" as const, name: "Hobby" },
                              { id: "pro" as const, name: "Pro" },
                            ]
                        ).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {tab === "fleet" ? (
        <div className="grid-2">
          <section className="panel">
            <h2>Projects ({projects.length})</h2>
            <div className="list">
              {projects.map((p) => (
                <div key={p.id} className="admin-row">
                  <div>
                    <Link href={`/project/${p.id}`}>
                      <strong>{p.name}</strong>
                    </Link>
                    <div className="muted mono" style={{ fontSize: "0.72rem" }}>
                      {p.hostname}
                    </div>
                    <div className="muted" style={{ fontSize: "0.72rem" }}>
                      {p.ownerEmail ?? "unassigned"} ·{" "}
                      {formatBytes(p.memoryLimitBytes)} ·{" "}
                      {(p.cpuNanoCpus / 1e9).toFixed(1)} vCPU
                    </div>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
              ))}
              {projects.length === 0 ? (
                <p className="muted">No projects</p>
              ) : null}
            </div>
          </section>
          <section className="panel">
            <h2>Databases ({databases.length})</h2>
            <div className="list">
              {databases.map((d) => (
                <div key={d.id} className="admin-row">
                  <div>
                    <strong>{d.name}</strong>
                    <div className="muted" style={{ fontSize: "0.72rem" }}>
                      {d.kind} · {d.ownerEmail ?? "unassigned"}
                      {d.projectName ? ` · ${d.projectName}` : ""}
                    </div>
                  </div>
                  <StatusBadge status={d.status} />
                </div>
              ))}
              {databases.length === 0 ? (
                <p className="muted">No databases</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {tab === "activity" && overview ? (
        <section className="panel">
          <h2>Recent deploys</h2>
          <div className="list">
            {overview.recentDeploys.map((d) => (
              <div key={d.id} className="admin-deploy">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{d.projectName}</strong>
                  <StatusBadge status={d.status} />
                </div>
                <div className="muted mono" style={{ fontSize: "0.75rem", marginTop: 4 }}>
                  {d.ownerEmail ?? "admin"} · {d.triggeredBy} ·{" "}
                  {new Date(d.createdAt).toLocaleString()}
                </div>
                {d.error ? (
                  <pre className="log-block" style={{ marginTop: 8, maxHeight: 120 }}>
                    {d.error}
                  </pre>
                ) : null}
              </div>
            ))}
            {overview.recentDeploys.length === 0 ? (
              <p className="muted">No deploys yet</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {!overview &&
      tab !== "accounts" &&
      tab !== "fleet" &&
      tab !== "device" ? (
        <p className="muted">Loading admin data…</p>
      ) : null}
    </AppShell>
  );
}
