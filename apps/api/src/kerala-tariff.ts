/**
 * Kerala KSEB / KSERC tariffs (w.e.f. 01.04.2025 – 31.03.2027)
 * Sources: KSERC Tariff Order gazette 05.12.2024; LT schedule summaries.
 *
 * Cafe / Runbase host defaults to LT-VII(A) Commercial (non-telescopic).
 * Domestic LT-I telescopic available as an alternate profile.
 */

export type KeralaTariffId = "lt7a_commercial" | "lt7b_commercial" | "lt1_domestic";

export type KeralaTariffMeta = {
  id: KeralaTariffId;
  label: string;
  authority: string;
  effectiveFrom: string;
  effectiveTo: string;
  notes: string[];
};

/** Non-telescopic: entire monthly units billed at the slab rate that contains the total. */
function nonTelescopicRate(
  monthlyKwh: number,
  slabs: Array<{ maxInclusive: number; rate: number }>,
): number {
  for (const s of slabs) {
    if (monthlyKwh <= s.maxInclusive) return s.rate;
  }
  return slabs[slabs.length - 1]!.rate;
}

/** Telescopic LT-I domestic: each band billed at its own rate. */
function telescopicCost(
  monthlyKwh: number,
  bands: Array<{ upTo: number; rate: number }>,
): { energyInr: number; effectiveRate: number } {
  let remaining = Math.max(0, monthlyKwh);
  let prev = 0;
  let cost = 0;
  for (const b of bands) {
    const width = b.upTo - prev;
    const take = Math.min(remaining, width);
    cost += take * b.rate;
    remaining -= take;
    prev = b.upTo;
    if (remaining <= 0) break;
  }
  if (remaining > 0) {
    const last = bands[bands.length - 1]!;
    cost += remaining * last.rate;
  }
  const effectiveRate = monthlyKwh > 0 ? cost / monthlyKwh : bands[0]!.rate;
  return { energyInr: cost, effectiveRate };
}

const SUMMER_SURCHARGE = 0.1; // ₹/kWh Jan–May

function isSummerMonth(d = new Date()): boolean {
  const m = d.getUTCMonth() + 1; // 1–12
  return m >= 1 && m <= 5;
}

export const KERALA_TARIFFS: Record<KeralaTariffId, KeralaTariffMeta> = {
  lt7a_commercial: {
    id: "lt7a_commercial",
    label: "LT-VII(A) Commercial",
    authority: "KSEB / KSERC",
    effectiveFrom: "2025-04-01",
    effectiveTo: "2027-03-31",
    notes: [
      "Non-telescopic energy charge — rate depends on total monthly units",
      "Fixed charge: ₹95/kW/month (1-phase) or ₹190/kW/month (3-phase)",
      "Summer surcharge ₹0.10/unit applies January–May",
      "Best fit for a cafe / shop PC hosting Runbase",
    ],
  },
  lt7b_commercial: {
    id: "lt7b_commercial",
    label: "LT-VII(B) Small commercial / cafe",
    authority: "KSEB / KSERC",
    effectiveFrom: "2025-04-01",
    effectiveTo: "2027-03-31",
    notes: [
      "For shops / internet cafes with connected load ≤ 2000 W",
      "Non-telescopic slabs; fixed ₹70/consumer/month (≤1000 W)",
      "Summer surcharge ₹0.10/unit January–May",
    ],
  },
  lt1_domestic: {
    id: "lt1_domestic",
    label: "LT-I Domestic (telescopic)",
    authority: "KSEB / KSERC",
    effectiveFrom: "2025-04-01",
    effectiveTo: "2027-03-31",
    notes: [
      "Telescopic slabs 0–50 … 201–250; non-telescopic above 250 units",
      "Only use if the cafe PC is billed on a domestic connection",
    ],
  },
};

export type PeriodEstimate = {
  kwh: number;
  energyInr: number;
  fixedInr: number;
  surchargeInr: number;
  totalInr: number;
  effectiveRateInrPerKwh: number;
};

export type KeralaBillEstimate = {
  tariffId: KeralaTariffId;
  tariff: KeralaTariffMeta;
  avgWatts: number;
  measuredHours: number | null;
  extrapolated: boolean;
  summerSurchargeApplied: boolean;
  connectedLoadKw: number;
  phase: "single" | "three";
  daily: PeriodEstimate;
  weekly: PeriodEstimate;
  monthly: PeriodEstimate;
  slabRateInrPerKwh: number;
  sourceNote: string;
};

function periodFromDaily(
  dailyKwh: number,
  days: number,
  energyRate: number,
  fixedMonthly: number,
  summer: boolean,
): PeriodEstimate {
  const kwh = dailyKwh * days;
  const surcharge = summer ? SUMMER_SURCHARGE * kwh : 0;
  const energyInr = kwh * energyRate;
  const fixedInr = (fixedMonthly * days) / 30;
  const totalInr = energyInr + surcharge + fixedInr;
  return {
    kwh: round3(kwh),
    energyInr: round2(energyInr),
    fixedInr: round2(fixedInr),
    surchargeInr: round2(surcharge),
    totalInr: round2(totalInr),
    effectiveRateInrPerKwh: kwh > 0 ? round2(totalInr / kwh) : energyRate,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Estimate bill for Runbase host power draw under a Kerala tariff.
 * `avgWatts` — measured average (prefer 1h/24h sample).
 * `connectedLoadKw` — billed connected load for fixed charges (default 1 kW laptop).
 */
export function estimateKeralaBill(opts: {
  avgWatts: number;
  tariffId?: KeralaTariffId;
  phase?: "single" | "three";
  connectedLoadKw?: number;
  measuredHours?: number | null;
  now?: Date;
}): KeralaBillEstimate {
  const tariffId = opts.tariffId ?? "lt7a_commercial";
  const phase = opts.phase ?? "single";
  const connectedLoadKw = Math.max(1, opts.connectedLoadKw ?? 1);
  const now = opts.now ?? new Date();
  const summer = isSummerMonth(now);
  const avgWatts = Math.max(0, opts.avgWatts);
  const dailyKwh = (avgWatts * 24) / 1000;
  const monthlyKwh = dailyKwh * 30;

  let slabRate = 6.05;
  let fixedMonthly = 95 * connectedLoadKw;

  if (tariffId === "lt7a_commercial") {
    slabRate = nonTelescopicRate(monthlyKwh, [
      { maxInclusive: 100, rate: 6.05 },
      { maxInclusive: 200, rate: 6.8 },
      { maxInclusive: 300, rate: 7.5 },
      { maxInclusive: 500, rate: 8.15 },
      { maxInclusive: Infinity, rate: 9.4 },
    ]);
    fixedMonthly = (phase === "three" ? 190 : 95) * connectedLoadKw;
  } else if (tariffId === "lt7b_commercial") {
    slabRate = nonTelescopicRate(monthlyKwh, [
      { maxInclusive: 100, rate: 5.4 },
      { maxInclusive: 200, rate: 6.25 },
      { maxInclusive: 300, rate: 6.9 },
      { maxInclusive: Infinity, rate: 6.9 },
    ]);
    fixedMonthly = connectedLoadKw <= 1 ? 70 : 80 * connectedLoadKw;
  } else {
    // LT-I domestic — if monthly ≤ 250 use telescopic; else non-telescopic table
    if (monthlyKwh <= 250) {
      const t = telescopicCost(monthlyKwh, [
        { upTo: 50, rate: 3.35 },
        { upTo: 100, rate: 4.25 },
        { upTo: 150, rate: 5.35 },
        { upTo: 200, rate: 7.2 },
        { upTo: 250, rate: 8.5 },
      ]);
      slabRate = t.effectiveRate;
    } else {
      slabRate = nonTelescopicRate(monthlyKwh, [
        { maxInclusive: 300, rate: 6.75 },
        { maxInclusive: 350, rate: 7.6 },
        { maxInclusive: 400, rate: 7.95 },
        { maxInclusive: 500, rate: 8.25 },
        { maxInclusive: Infinity, rate: 9.2 },
      ]);
    }
    // Domestic fixed is consumption-linked; approximate mid slab ~₹160/month for laptop-only
    fixedMonthly = monthlyKwh <= 50 ? 50 : monthlyKwh <= 100 ? 85 : 140;
  }

  const extrapolated =
    opts.measuredHours == null || opts.measuredHours < 1;

  return {
    tariffId,
    tariff: KERALA_TARIFFS[tariffId],
    avgWatts: round2(avgWatts),
    measuredHours:
      opts.measuredHours != null ? round2(opts.measuredHours) : null,
    extrapolated,
    summerSurchargeApplied: summer,
    connectedLoadKw,
    phase,
    daily: periodFromDaily(dailyKwh, 1, slabRate, fixedMonthly, summer),
    weekly: periodFromDaily(dailyKwh, 7, slabRate, fixedMonthly, summer),
    monthly: periodFromDaily(dailyKwh, 30, slabRate, fixedMonthly, summer),
    slabRateInrPerKwh: slabRate,
    sourceNote:
      "KSERC tariff order 05.12.2024 (rates w.e.f. 01.04.2025). Laptop draw is estimated from sensors; cafe wall meter will differ if other loads share the connection.",
  };
}
