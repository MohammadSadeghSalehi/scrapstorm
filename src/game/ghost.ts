import type { TrackId } from "./track";
import type { VehicleClassId } from "./types";

const GHOST_KEY = "scrapstorm-ghosts-v1";

export interface GhostSample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface GhostRun {
  trackId: TrackId;
  classId: VehicleClassId;
  name: string;
  color: string;
  totalTime: number;
  samples: GhostSample[];
  savedAt: number;
}

type GhostStore = Partial<Record<TrackId, GhostRun>>;

export function loadGhosts(): GhostStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(GHOST_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as GhostStore;
  } catch {
    return {};
  }
}

export function getGhost(trackId: TrackId): GhostRun | null {
  return loadGhosts()[trackId] ?? null;
}

export function saveGhostIfBest(run: GhostRun): boolean {
  const all = loadGhosts();
  const prev = all[run.trackId];
  if (prev && prev.totalTime <= run.totalTime) return false;
  // Cap samples for storage
  const samples =
    run.samples.length > 900
      ? run.samples.filter((_, i) => i % Math.ceil(run.samples.length / 900) === 0)
      : run.samples;
  all[run.trackId] = { ...run, samples };
  try {
    localStorage.setItem(GHOST_KEY, JSON.stringify(all));
  } catch {
    return false;
  }
  return true;
}

export class GhostRecorder {
  samples: GhostSample[] = [];
  private acc = 0;
  private readonly interval = 0.08;

  reset() {
    this.samples = [];
    this.acc = 0;
  }

  push(dt: number, t: number, x: number, y: number, z: number, yaw: number) {
    this.acc += dt;
    if (this.samples.length === 0 || this.acc >= this.interval) {
      this.acc = 0;
      this.samples.push({ t, x, y, z, yaw });
    }
  }

  finalize(): GhostSample[] {
    return this.samples.slice();
  }
}

/** Interpolate ghost pose at race time t. */
export function sampleGhost(
  run: GhostRun,
  t: number,
): { x: number; y: number; z: number; yaw: number } | null {
  const s = run.samples;
  if (!s.length) return null;
  if (t <= s[0].t) return { x: s[0].x, y: s[0].y, z: s[0].z, yaw: s[0].yaw };
  if (t >= s[s.length - 1].t) {
    const last = s[s.length - 1];
    return { x: last.x, y: last.y, z: last.z, yaw: last.yaw };
  }
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t < t) lo = mid;
    else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  const u = (t - a.t) / Math.max(1e-4, b.t - a.t);
  let dyaw = b.yaw - a.yaw;
  while (dyaw > Math.PI) dyaw -= Math.PI * 2;
  while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
    yaw: a.yaw + dyaw * u,
  };
}
