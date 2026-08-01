import type { VehicleClassId } from "./types";

const META_KEY = "scrapstorm-meta-v1";

export interface PaintDef {
  id: string;
  name: string;
  hex: string;
  cost: number;
  classId?: VehicleClassId; // undefined = universal
}

export const PAINTS: PaintDef[] = [
  { id: "stock", name: "Factory", hex: "", cost: 0 },
  { id: "ember", name: "Ember Rust", hex: "#ea580c", cost: 120 },
  { id: "acid", name: "Acid Teal", hex: "#14b8a6", cost: 150 },
  { id: "volt", name: "Volt Yellow", hex: "#eab308", cost: 180 },
  { id: "void", name: "Void Violet", hex: "#a78bfa", cost: 220 },
  { id: "blood", name: "Blood Oxide", hex: "#e11d48", cost: 200 },
  { id: "chrome", name: "Scrap Chrome", hex: "#d4d4d8", cost: 280 },
  { id: "ice", name: "Ice Coil", hex: "#38bdf8", cost: 160 },
  { id: "jade", name: "Jade Scrap", hex: "#34d399", cost: 170 },
];

export interface MetaState {
  scrap: number;
  unlockedPaints: string[];
  selectedPaint: Record<VehicleClassId, string>;
  races: number;
  wins: number;
  bestLap: number | null;
  totalPlaySec: number;
}

const DEFAULT: MetaState = {
  scrap: 80,
  unlockedPaints: ["stock"],
  selectedPaint: {
    interceptor: "stock",
    bruiser: "stock",
    trickster: "stock",
  },
  races: 0,
  wins: 0,
  bestLap: null,
  totalPlaySec: 0,
};

function clampMeta(raw: Partial<MetaState> | null): MetaState {
  if (!raw) return { ...DEFAULT, selectedPaint: { ...DEFAULT.selectedPaint } };
  const unlocked = Array.isArray(raw.unlockedPaints)
    ? Array.from(new Set(["stock", ...raw.unlockedPaints.filter((id) => PAINTS.some((p) => p.id === id))]))
    : ["stock"];
  const sel = { ...DEFAULT.selectedPaint, ...(raw.selectedPaint ?? {}) };
  for (const k of Object.keys(sel) as VehicleClassId[]) {
    if (!unlocked.includes(sel[k])) sel[k] = "stock";
  }
  return {
    scrap: Math.max(0, Math.floor(raw.scrap ?? DEFAULT.scrap)),
    unlockedPaints: unlocked,
    selectedPaint: sel,
    races: Math.max(0, raw.races ?? 0),
    wins: Math.max(0, raw.wins ?? 0),
    bestLap: raw.bestLap ?? null,
    totalPlaySec: Math.max(0, raw.totalPlaySec ?? 0),
  };
}

export function loadMeta(): MetaState {
  if (typeof window === "undefined") {
    return { ...DEFAULT, selectedPaint: { ...DEFAULT.selectedPaint } };
  }
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return { ...DEFAULT, selectedPaint: { ...DEFAULT.selectedPaint } };
    return clampMeta(JSON.parse(raw) as Partial<MetaState>);
  } catch {
    return { ...DEFAULT, selectedPaint: { ...DEFAULT.selectedPaint } };
  }
}

export function saveMeta(meta: MetaState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* quota */
  }
}

export function paintHex(classId: VehicleClassId, paintId: string, stockColor: string): string {
  const p = PAINTS.find((x) => x.id === paintId);
  if (!p || p.id === "stock" || !p.hex) return stockColor;
  return p.hex;
}

/** Scrap payout by place (1-based). */
export function scrapForPlace(place: number, fieldSize: number): number {
  if (place <= 0) return 40;
  const base = [220, 140, 95, 60];
  const b = base[Math.min(place, base.length) - 1] ?? 45;
  return b + Math.max(0, fieldSize - place) * 12;
}

export function applyRaceReward(
  meta: MetaState,
  place: number,
  fieldSize: number,
  raceTimeSec: number,
  bestLapThisRace: number | null,
): { meta: MetaState; earned: number } {
  let earned = scrapForPlace(place, fieldSize);
  // Bonus for fast race / new best lap
  if (place === 1) earned += 40;
  if (bestLapThisRace != null && (meta.bestLap == null || bestLapThisRace < meta.bestLap)) {
    earned += 35;
  }
  if (raceTimeSec < 120) earned += 20;
  const next: MetaState = {
    ...meta,
    scrap: meta.scrap + earned,
    races: meta.races + 1,
    wins: meta.wins + (place === 1 ? 1 : 0),
    totalPlaySec: meta.totalPlaySec + raceTimeSec,
    bestLap:
      bestLapThisRace != null && (meta.bestLap == null || bestLapThisRace < meta.bestLap)
        ? bestLapThisRace
        : meta.bestLap,
    selectedPaint: { ...meta.selectedPaint },
    unlockedPaints: [...meta.unlockedPaints],
  };
  return { meta: next, earned };
}

/**
 * Fold a finished MISSION into the garage's stats.
 *
 * Deliberately does NOT compute a payout. A career run's scrap is decided by
 * missions/career.ts from objectives, markers, takedowns and the stake; running
 * applyRaceReward as well would pay the player twice for the same race and
 * would do it with the free-play formula, which knows nothing about any of
 * that. The caller hands the already-decided number in.
 */
export function applyMissionMeta(
  meta: MetaState,
  opts: {
    scrap: number;
    place: number;
    raceTimeSec: number;
    bestLap: number | null;
    won: boolean;
  },
): MetaState {
  const better =
    opts.bestLap != null && (meta.bestLap == null || opts.bestLap < meta.bestLap);
  return {
    ...meta,
    scrap: Math.max(0, meta.scrap + opts.scrap),
    races: meta.races + 1,
    wins: meta.wins + (opts.won ? 1 : 0),
    totalPlaySec: meta.totalPlaySec + opts.raceTimeSec,
    bestLap: better ? opts.bestLap : meta.bestLap,
    selectedPaint: { ...meta.selectedPaint },
    unlockedPaints: [...meta.unlockedPaints],
  };
}

/** Take the stake at the grid. Clamped at zero — entry is gated before this. */
export function spendScrap(meta: MetaState, amount: number): MetaState {
  if (amount <= 0) return meta;
  return {
    ...meta,
    scrap: Math.max(0, meta.scrap - Math.floor(amount)),
    selectedPaint: { ...meta.selectedPaint },
    unlockedPaints: [...meta.unlockedPaints],
  };
}

export function tryUnlockPaint(meta: MetaState, paintId: string): MetaState | null {
  if (meta.unlockedPaints.includes(paintId)) return null;
  const p = PAINTS.find((x) => x.id === paintId);
  if (!p || p.cost <= 0) return null;
  if (meta.scrap < p.cost) return null;
  return {
    ...meta,
    scrap: meta.scrap - p.cost,
    unlockedPaints: [...meta.unlockedPaints, paintId],
    selectedPaint: { ...meta.selectedPaint },
  };
}

export function selectPaint(meta: MetaState, classId: VehicleClassId, paintId: string): MetaState {
  if (!meta.unlockedPaints.includes(paintId) && paintId !== "stock") return meta;
  return {
    ...meta,
    selectedPaint: { ...meta.selectedPaint, [classId]: paintId },
  };
}
