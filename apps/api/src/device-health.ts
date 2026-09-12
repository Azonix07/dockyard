import { readFileSync, existsSync } from "node:fs";
import type {
  DeviceHealth,
  DeviceHealthStatus,
  KeralaElectricityEstimate,
  UserElectricityShare,
  PlanId,
} from "@laptop-paas/shared";
import { config } from "./config.js";
import { estimateKeralaBill, type KeralaTariffId } from "./kerala-tariff.js";
import { query } from "./db/pool.js";

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

type RawHealth = {
  available?: boolean;
  sampledAt?: string;
  error?: string;
  device?: DeviceHealth["device"];
  temperatures?: Partial<DeviceHealth["temperatures"]>;
  memory?: Partial<DeviceHealth["memory"]>;
  power?: {
    onAc?: boolean;
    charging?: boolean;
    discharging?: boolean;
    batteryPercent?: number;
    watts?: number;
    source?: string;
    electricityRateInrPerKwh?: number;
  };
  gpu?: DeviceHealth["gpu"];
  disks?: DeviceHealth["disks"];
  diskTimePercent?: number;
  clocks?: DeviceHealth["clocks"];
};

function integrateKwh(
  historyPath: string,
  windowMs: number,
): { kwh: number | null; avgWatts: number | null; measuredHours: number | null } {
  if (!existsSync(historyPath)) {
    return { kwh: null, avgWatts: null, measuredHours: null };
  }
  const now = Date.now();
  const cutoff = now - windowMs;
  const lines = readFileSync(historyPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const samples: Array<{ t: number; w: number }> = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as { t?: string; w?: number };
      if (!row.t || typeof row.w !== "number" || !Number.isFinite(row.w)) continue;
      const t = Date.parse(row.t);
      if (!Number.isFinite(t) || t < cutoff) continue;
      samples.push({ t, w: row.w });
    } catch {
      /* skip */
    }
  }
  if (samples.length < 2) {
    if (samples.length === 1) {
      return { kwh: 0, avgWatts: samples[0]!.w, measuredHours: 0 };
    }
    return { kwh: null, avgWatts: null, measuredHours: null };
  }
  samples.sort((a, b) => a.t - b.t);

  let joules = 0;
  let wattSeconds = 0;
  let durationMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const dtMs = Math.max(0, b.t - a.t);
    if (dtMs <= 0 || dtMs > 5 * 60_000) continue;
    const avgW = (a.w + b.w) / 2;
    joules += avgW * (dtMs / 1000);
    wattSeconds += avgW * (dtMs / 1000);
    durationMs += dtMs;
  }
  const kwh = joules / 3_600_000;
  const avgWatts = durationMs > 0 ? wattSeconds / (durationMs / 1000) : null;
  return {
    kwh: Number.isFinite(kwh) ? Math.round(kwh * 1000) / 1000 : null,
    avgWatts:
      avgWatts != null && Number.isFinite(avgWatts)
        ? Math.round(avgWatts * 10) / 10
        : null,
    measuredHours:
      durationMs > 0 ? Math.round((durationMs / 3_600_000) * 100) / 100 : null,
  };
}

function emptyElectricity(avgWatts = 0): KeralaElectricityEstimate {
  const bill = estimateKeralaBill({
    avgWatts,
    tariffId: (process.env.KERALA_TARIFF as KeralaTariffId) || "lt7a_commercial",
    measuredHours: null,
  });
  return {
    tariffId: bill.tariffId,
    tariffLabel: bill.tariff.label,
    authority: bill.tariff.authority,
    effectiveFrom: bill.tariff.effectiveFrom,
    effectiveTo: bill.tariff.effectiveTo,
    avgWatts: bill.avgWatts,
    measuredHours: bill.measuredHours,
    extrapolated: true,
    summerSurchargeApplied: bill.summerSurchargeApplied,
    slabRateInrPerKwh: bill.slabRateInrPerKwh,
    connectedLoadKw: bill.connectedLoadKw,
    phase: bill.phase,
    daily: bill.daily,
    weekly: bill.weekly,
    monthly: bill.monthly,
    notes: bill.tariff.notes,
    sourceNote: bill.sourceNote,
    kwhLast1h: null,
    kwhLast24h: null,
    avgWattsLast1h: null,
    avgWattsLast24h: null,
  };
}

function scoreHealth(raw: RawHealth): {
  score: number;
  status: DeviceHealthStatus;
  issues: string[];
} {
  if (!raw.available) {
    return {
      score: 0,
      status: "unknown",
      issues: [raw.error || "Host health collector offline"],
    };
  }

  let score = 100;
  const issues: string[] = [];

  const thermal = raw.temperatures?.thermalZoneC;
  if (thermal != null) {
    if (thermal >= 90) {
      score -= 40;
      issues.push(`Thermal zone critical (${thermal}°C)`);
    } else if (thermal >= 75) {
      score -= 20;
      issues.push(`Thermal zone warm (${thermal}°C)`);
    }
  }

  const gpuC = raw.temperatures?.gpuC ?? raw.gpu?.tempC;
  if (gpuC != null) {
    if (gpuC >= 90) {
      score -= 30;
      issues.push(`GPU temperature critical (${gpuC}°C)`);
    } else if (gpuC >= 80) {
      score -= 12;
      issues.push(`GPU temperature high (${gpuC}°C)`);
    }
  }

  const committed = raw.memory?.committedPercent;
  const memPct = raw.memory?.usedPercent;
  const pressure = committed ?? memPct;
  if (pressure != null) {
    if (pressure >= 95) {
      score -= 35;
      issues.push(`Memory pressure critical (${pressure}%)`);
    } else if (pressure >= 85) {
      score -= 18;
      issues.push(`Memory pressure high (${pressure}%)`);
    }
  }

  for (const d of raw.disks ?? []) {
    if (d.health && d.health.toLowerCase() !== "healthy") {
      score -= 25;
      issues.push(`Disk ${d.name}: ${d.health}`);
    }
  }

  const batt = raw.power?.batteryPercent;
  if (raw.power?.discharging && batt != null && batt <= 15) {
    score -= 15;
    issues.push(`Battery low (${batt}%) while on battery`);
  }

  const cpuLoad = raw.temperatures?.cpuLoadPct;
  if (cpuLoad != null && cpuLoad >= 95) {
    score -= 10;
    issues.push(`CPU saturated (${cpuLoad}%)`);
  }

  score = Math.max(0, Math.min(100, score));
  let status: DeviceHealthStatus = "healthy";
  if (score < 50) status = "critical";
  else if (score < 80) status = "warning";
  if (issues.length === 0 && score >= 80) status = "healthy";

  return { score, status, issues };
}

export function loadDeviceHealth(): DeviceHealth {
  const empty: DeviceHealth = {
    available: false,
    sampledAt: null,
    staleSeconds: null,
    status: "unknown",
    score: 0,
    issues: ["Host health file not found — start scripts/host-health-daemon.sh"],
    device: null,
    temperatures: { thermalZoneC: null, gpuC: null, cpuLoadPct: null },
    memory: {
      usedBytes: null,
      totalBytes: null,
      usedPercent: null,
      committedPercent: null,
    },
    power: {
      onAc: null,
      charging: null,
      discharging: null,
      batteryPercent: null,
      watts: null,
      source: null,
      electricity: emptyElectricity(0),
    },
    gpu: null,
    disks: [],
    diskTimePercent: null,
    clocks: { currentMhz: null, maxMhz: null },
  };

  if (!existsSync(config.hostHealthPath)) {
    return empty;
  }

  try {
    const raw = JSON.parse(
      readFileSync(config.hostHealthPath, "utf8"),
    ) as RawHealth;

    const sampledAt = raw.sampledAt ?? null;
    const staleSeconds =
      sampledAt != null
        ? Math.max(0, Math.round((Date.now() - Date.parse(sampledAt)) / 1000))
        : null;

    const last1h = integrateKwh(config.hostHealthHistoryPath, 60 * 60 * 1000);
    const last24h = integrateKwh(
      config.hostHealthHistoryPath,
      24 * 60 * 60 * 1000,
    );

    const thermalZoneC = num(raw.temperatures?.thermalZoneC);
    const gpuC = num(raw.temperatures?.gpuC) ?? num(raw.gpu?.tempC);
    const cpuLoadPct = num(raw.temperatures?.cpuLoadPct) ?? 0;

    let usedBytes = num(raw.memory?.usedBytes);
    let totalBytes = num(raw.memory?.totalBytes);
    let usedPercent = num(raw.memory?.usedPercent);
    if (
      (usedPercent == null || usedPercent === 0) &&
      usedBytes != null &&
      totalBytes != null &&
      totalBytes > 0 &&
      usedBytes > 0
    ) {
      usedPercent = Math.round((usedBytes / totalBytes) * 1000) / 10;
    }

    let watts = num(raw.power?.watts);
    const gpuPower = num(raw.gpu?.powerWatts);
    const gpuUtil = num(raw.gpu?.utilizationPct) ?? 0;
    if (watts == null) {
      const cpuWatts = 12 + (cpuLoadPct / 100) * 40;
      const gpuWatts =
        gpuPower ??
        (raw.gpu ? 3 + (gpuUtil / 100) * 50 : 0);
      watts = Math.round((14 + cpuWatts + gpuWatts) * 10) / 10;
    }

    const avgWatts =
      last24h.avgWatts ?? last1h.avgWatts ?? watts ?? 0;
    const measuredHours = last24h.measuredHours ?? last1h.measuredHours;
    const tariffId =
      (process.env.KERALA_TARIFF as KeralaTariffId) || "lt7a_commercial";
    const bill = estimateKeralaBill({
      avgWatts,
      tariffId,
      measuredHours,
      phase:
        process.env.KERALA_PHASE === "three" ? "three" : "single",
      connectedLoadKw: Number(process.env.KERALA_CONNECTED_KW ?? 1) || 1,
    });
    const electricity: KeralaElectricityEstimate = {
      tariffId: bill.tariffId,
      tariffLabel: bill.tariff.label,
      authority: bill.tariff.authority,
      effectiveFrom: bill.tariff.effectiveFrom,
      effectiveTo: bill.tariff.effectiveTo,
      avgWatts: bill.avgWatts,
      measuredHours: bill.measuredHours,
      extrapolated: bill.extrapolated,
      summerSurchargeApplied: bill.summerSurchargeApplied,
      slabRateInrPerKwh: bill.slabRateInrPerKwh,
      connectedLoadKw: bill.connectedLoadKw,
      phase: bill.phase,
      daily: bill.daily,
      weekly: bill.weekly,
      monthly: bill.monthly,
      notes: bill.tariff.notes,
      sourceNote: bill.sourceNote,
      kwhLast1h: last1h.kwh,
      kwhLast24h: last24h.kwh,
      avgWattsLast1h: last1h.avgWatts,
      avgWattsLast24h: last24h.avgWatts,
    };

    const scored = scoreHealth({
      ...raw,
      available: raw.available !== false && (staleSeconds == null || staleSeconds < 120),
      temperatures: {
        thermalZoneC,
        gpuC,
        cpuLoadPct,
      },
      memory: {
        usedBytes,
        totalBytes,
        usedPercent,
        committedPercent: num(raw.memory?.committedPercent),
      },
      power: {
        ...raw.power,
        watts,
      },
    });

    if (staleSeconds != null && staleSeconds >= 120) {
      scored.issues.unshift(`Health sample stale (${staleSeconds}s old)`);
      scored.status = scored.status === "healthy" ? "warning" : scored.status;
      scored.score = Math.min(scored.score, 70);
    }

    return {
      available: raw.available !== false,
      sampledAt,
      staleSeconds,
      status: scored.status,
      score: scored.score,
      issues: scored.issues,
      device: raw.device ?? null,
      temperatures: {
        thermalZoneC,
        gpuC,
        cpuLoadPct,
      },
      memory: {
        usedBytes,
        totalBytes,
        usedPercent,
        committedPercent: num(raw.memory?.committedPercent),
      },
      power: {
        onAc: raw.power?.onAc ?? null,
        charging: raw.power?.charging ?? null,
        discharging: raw.power?.discharging ?? null,
        batteryPercent: num(raw.power?.batteryPercent),
        watts,
        source: raw.power?.source ?? (watts != null ? "api_estimate" : null),
        electricity,
      },
      gpu: raw.gpu
        ? {
            name: raw.gpu.name ?? null,
            tempC: num(raw.gpu.tempC),
            powerWatts: gpuPower,
            utilizationPct: gpuUtil,
            memoryUsedMiB: num(raw.gpu.memoryUsedMiB),
            memoryTotalMiB: num(raw.gpu.memoryTotalMiB),
          }
        : null,
      disks: raw.disks ?? [],
      diskTimePercent: num(raw.diskTimePercent),
      clocks: {
        currentMhz: num(raw.clocks?.currentMhz),
        maxMhz: num(raw.clocks?.maxMhz),
      },
    };
  } catch (err) {
    return {
      ...empty,
      issues: [
        `Failed to read host health: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

/** Allocate host electricity cost by each user's reserved RAM share. */
export async function loadUserElectricityShares(
  hostAvgWatts: number,
  electricity: KeralaElectricityEstimate,
): Promise<UserElectricityShare[]> {
  const { rows } = await query(
    `SELECT
       u.id,
       u.email,
       u.name,
       u.plan,
       (SELECT COUNT(*)::int FROM projects p WHERE p.owner_id = u.id) AS project_count,
       (SELECT COUNT(*)::int FROM databases db WHERE db.owner_id = u.id) AS database_count,
       (SELECT COALESCE(SUM(p.memory_limit_bytes), 0)::bigint
          FROM projects p WHERE p.owner_id = u.id) AS project_mem,
       (SELECT COALESCE(SUM(COALESCE((db.config->>'memoryMb')::int, 512) * 1024 * 1024), 0)::bigint
          FROM databases db WHERE db.owner_id = u.id) AS db_mem
     FROM users u
     ORDER BY u.created_at DESC`,
  );

  // Platform / unowned share
  const orphanProjects = await query(
    `SELECT COALESCE(SUM(memory_limit_bytes),0)::bigint AS mem, COUNT(*)::int AS c
     FROM projects WHERE owner_id IS NULL`,
  );
  const platformMem = Number(orphanProjects.rows[0]?.mem ?? 0);

  type Acc = {
    userId: string | null;
    email: string;
    name: string;
    plan: PlanId | null;
    projectCount: number;
    databaseCount: number;
    reservedMemoryBytes: number;
  };

  const accounts: Acc[] = rows.map((r) => ({
    userId: r.id as string,
    email: r.email as string,
    name: r.name as string,
    plan: (r.plan as PlanId) ?? null,
    projectCount: Number(r.project_count ?? 0),
    databaseCount: Number(r.database_count ?? 0),
    reservedMemoryBytes:
      Number(r.project_mem ?? 0) + Number(r.db_mem ?? 0),
  }));

  if (platformMem > 0) {
    accounts.push({
      userId: null,
      email: "platform@runbase.local",
      name: "Platform / unassigned",
      plan: null,
      projectCount: Number(orphanProjects.rows[0]?.c ?? 0),
      databaseCount: 0,
      reservedMemoryBytes: platformMem,
    });
  }

  const totalMem = accounts.reduce((s, a) => s + a.reservedMemoryBytes, 0);
  const active = accounts.filter((a) => a.reservedMemoryBytes > 0);
  const denom = totalMem > 0 ? totalMem : Math.max(active.length, 1);

  return accounts.map((a) => {
    const share =
      totalMem > 0
        ? a.reservedMemoryBytes / denom
        : active.length > 0
          ? 1 / active.length
          : 0;
    const avgWatts = Math.round(hostAvgWatts * share * 10) / 10;
    const dailyKwh =
      Math.round(electricity.daily.kwh * share * 1000) / 1000;
    const weeklyKwh =
      Math.round(electricity.weekly.kwh * share * 1000) / 1000;
    const monthlyKwh =
      Math.round(electricity.monthly.kwh * share * 1000) / 1000;
    return {
      userId: a.userId,
      email: a.email,
      name: a.name,
      plan: a.plan,
      projectCount: a.projectCount,
      databaseCount: a.databaseCount,
      reservedMemoryBytes: a.reservedMemoryBytes,
      sharePercent: Math.round(share * 1000) / 10,
      avgWatts,
      dailyKwh,
      weeklyKwh,
      monthlyKwh,
      dailyInr: Math.round(electricity.daily.totalInr * share * 100) / 100,
      weeklyInr: Math.round(electricity.weekly.totalInr * share * 100) / 100,
      monthlyInr: Math.round(electricity.monthly.totalInr * share * 100) / 100,
    };
  });
}
