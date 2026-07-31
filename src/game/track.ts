import type { CheckpointGate, SurfaceInfo, SurfaceKind, TrackSample } from "./types";
import { sampleDuneField } from "./world/terrainHeight";

export type TrackId = "ash_spire" | "cinder_bowl";

export interface TrackDef {
  id: TrackId;
  name: string;
  tagline: string;
  description: string;
}

export const TRACK_DEFS: TrackDef[] = [
  {
    id: "ash_spire",
    name: "Ash Spire Circuit",
    tagline: "Stadium loop · combat arena",
    description: "Wide desert stadium with a jump bank and scrapyard hazard.",
  },
  {
    id: "cinder_bowl",
    name: "Cinder Bowl",
    tagline: "Tight kidney · hairpin scrap",
    description: "Narrower technical bowl with a choke hazard and high banked turn.",
  },
];

type Ctrl = {
  x: number;
  z: number;
  y?: number;
  w?: number;
  zone?: TrackSample["zone"];
};

/**
 * Ash Spire Circuit — open desert stadium loop.
 * Wide road, large radii, parallel legs kept far apart.
 */
const ASH_SPIRE: Ctrl[] = [
  { x: 0, z: 0, w: 26, zone: "race" },
  { x: 40, z: -8, w: 26, zone: "race" },
  { x: 95, z: -35, w: 28, zone: "race" },
  { x: 145, z: -20, w: 30, zone: "arena" },
  { x: 175, z: 35, w: 32, zone: "arena" },
  { x: 165, z: 95, w: 28, zone: "arena" },
  { x: 120, z: 145, w: 26, zone: "race" },
  { x: 55, z: 165, w: 26, zone: "race" },
  { x: -20, z: 160, w: 28, zone: "hazard" },
  { x: -85, z: 130, w: 26, zone: "hazard" },
  { x: -130, z: 70, w: 24, zone: "jump" },
  { x: -140, z: 10, w: 24, zone: "jump" },
  { x: -115, z: -45, w: 26, zone: "race" },
  { x: -55, z: -55, w: 26, zone: "race" },
];

/**
 * Cinder Bowl — smaller kidney, tighter radii still corridor-safe.
 */
const CINDER_BOWL: Ctrl[] = [
  { x: -20, z: 10, w: 22, zone: "race" },
  { x: 30, z: 5, w: 22, zone: "race" },
  { x: 85, z: -25, w: 24, zone: "race" },
  { x: 110, z: 20, w: 24, zone: "arena" },
  { x: 100, z: 85, w: 26, zone: "arena", y: 1.2 },
  { x: 55, z: 120, w: 22, zone: "race" },
  { x: -10, z: 130, w: 20, zone: "hazard" },
  { x: -70, z: 100, w: 20, zone: "hazard" },
  { x: -105, z: 50, w: 20, zone: "jump" },
  { x: -100, z: -5, w: 20, zone: "jump" },
  { x: -70, z: -40, w: 22, zone: "race" },
  { x: -35, z: -20, w: 22, zone: "race" },
];

function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function ctrlAt(ctrls: Ctrl[], i: number): Ctrl {
  const n = ctrls.length;
  return ctrls[((i % n) + n) % n]!;
}

/** Dense Catmull-Rom resampling with arc-length, yaw, bank. */
function buildSamples(ctrls: Ctrl[], segsPer = 20): TrackSample[] {
  const n = ctrls.length;
  const raw: {
    x: number;
    y: number;
    z: number;
    w: number;
    zone: TrackSample["zone"];
  }[] = [];

  for (let i = 0; i < n; i++) {
    const c0 = ctrlAt(ctrls, i - 1);
    const c1 = ctrlAt(ctrls, i);
    const c2 = ctrlAt(ctrls, i + 1);
    const c3 = ctrlAt(ctrls, i + 2);
    for (let s = 0; s < segsPer; s++) {
      const t = s / segsPer;
      const x = catmullRom(c0.x, c1.x, c2.x, c3.x, t);
      const z = catmullRom(c0.z, c1.z, c2.z, c3.z, t);
      const y0 = c0.y ?? 0;
      const y1 = c1.y ?? 0;
      const y2 = c2.y ?? 0;
      const y3 = c3.y ?? 0;
      const y = catmullRom(y0, y1, y2, y3, t);
      // Jump zone lift
      const zone = t < 0.5 ? (c1.zone ?? "race") : (c2.zone ?? "race");
      let lift = y;
      if (zone === "jump") lift += Math.sin(t * Math.PI) * 1.8;
      const w = (c1.w ?? 26) * (1 - t) + (c2.w ?? 26) * t;
      raw.push({ x, y: lift, z, w, zone });
    }
  }

  // Arc-length + yaw + bank
  const samples: TrackSample[] = [];
  let sAcc = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    const b = raw[(i + 1) % raw.length]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const yaw = Math.atan2(-dx, -dz);
    // Bank from curvature (cross product of consecutive tangents)
    const c = raw[(i + raw.length - 1) % raw.length]!;
    const t0x = a.x - c.x;
    const t0z = a.z - c.z;
    const t1x = b.x - a.x;
    const t1z = b.z - a.z;
    const cross = t0x * t1z - t0z * t1x;
    const bank = Math.max(-1, Math.min(1, cross * 0.012));
    samples.push({
      x: a.x,
      y: a.y,
      z: a.z,
      yaw,
      width: a.w,
      zone: a.zone,
      s: sAcc,
      ...(Math.abs(bank) > 0.02 ? { bank } : {}),
    } as TrackSample & { bank?: number });
    sAcc += Math.hypot(dx, dz);
  }
  // Normalize s so last wraps to total length
  for (const sm of samples) {
    // s stays absolute arc length; TRACK_LENGTH is total
  }
  void sAcc;
  return samples;
}

function buildCheckpointsFrom(samples: TrackSample[], count = 14): CheckpointGate[] {
  const n = samples.length;
  const gates: CheckpointGate[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor((i / count) * n) % n;
    const s = samples[idx]!;
    const nx = -Math.sin(s.yaw); // along-track normal (forward)
    const nz = -Math.cos(s.yaw);
    gates.push({
      index: i,
      x: s.x,
      z: s.z,
      nx,
      nz,
      halfWidth: s.width * 0.62,
    });
  }
  return gates;
}

function buildEdgeMarkersFrom(
  samples: TrackSample[],
): { x: number; y: number; z: number; side: number }[] {
  const markers: { x: number; y: number; z: number; side: number }[] = [];
  const step = Math.max(1, Math.floor(samples.length / 94));
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i]!;
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const half = s.width * 0.5;
    for (const side of [-1, 1] as const) {
      markers.push({
        x: s.x + rx * side * half,
        y: s.y,
        z: s.z + rz * side * half,
        side,
      });
    }
  }
  return markers;
}

type SceneryItem = {
  x: number;
  z: number;
  /** Ground height at (x, z) — filled in by settleScenery, never guessed. */
  y: number;
  kind: "tower" | "pile" | "pipe" | "crane";
  scale: number;
  rot: number;
};

function buildSceneryFrom(samples: TrackSample[]): SceneryItem[] {
  const items: SceneryItem[] = [];
  const kinds: SceneryItem["kind"][] = ["tower", "pile", "pipe", "crane"];
  // Sparser and set further back. These are 6-8m untextured boxes; at 14m from
  // the road edge they loomed over the racing line and read as slabs dumped
  // beside the track rather than as a distant refinery skyline.
  const step = Math.max(6, Math.floor(samples.length / 16));
  for (let i = 3; i < samples.length; i += step) {
    const s = samples[i]!;
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const side = i % 2 === 0 ? 1 : -1;
    const off = s.width * 0.5 + 34 + (i % 5) * 6;
    items.push({
      x: s.x + rx * side * off,
      z: s.z + rz * side * off,
      y: 0,
      kind: kinds[i % kinds.length]!,
      scale: 0.9 + (i % 4) * 0.18,
      rot: (i * 0.37) % (Math.PI * 2),
    });
  }
  // Landmark anchors near start (shared with worldProps / decor)
  const s0 = samples[0];
  if (s0) {
    items.push(
      { x: s0.x + 40, z: s0.z + 60, y: 0, kind: "tower", scale: 1.4, rot: 0.3 },
      { x: s0.x + 20, z: s0.z + 50, y: 0, kind: "crane", scale: 1.2, rot: 1.1 },
      { x: s0.x + 55, z: s0.z + 40, y: 0, kind: "pile", scale: 1.6, rot: 0.5 },
      { x: s0.x - 10, z: s0.z + 70, y: 0, kind: "pipe", scale: 1.1, rot: 0.8 },
      { x: s0.x + 70, z: s0.z - 20, y: 0, kind: "crane", scale: 1.3, rot: 2.1 },
      { x: s0.x - 40, z: s0.z + 30, y: 0, kind: "tower", scale: 1.15, rot: 0.9 },
    );
  }
  return settleScenery(items, samples);
}

/*
 * Push every scenery item clear of the tarmac.
 *
 * The ring placement above derives its position from a track sample, so it is
 * clear of THAT sample by construction - but a circuit doubles back, and the
 * landmark anchors are raw world offsets from the start point that consult the
 * track not at all. Either can land on a part of the loop they never looked at.
 * That is how a crane ended up straddling the road with nothing to hit: the
 * scenery collider is a ground-level circle, so a gantry overhead has no
 * collision by design and the only real fix is not to put it there.
 *
 * Brute force over samples - a few hundred points against ~22 items, once per
 * track build.
 */
function settleScenery(
  items: SceneryItem[],
  samples: TrackSample[],
): SceneryItem[] {
  if (!samples.length) return items;
  return items.map((it) => {
    let best = Infinity;
    let bs: TrackSample = samples[0]!;
    for (const s of samples) {
      const dx = it.x - s.x;
      const dz = it.z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bs = s;
      }
    }
    // Footprint grows with scale; these kits run 6-10m across at scale 1.
    const need = bs.width * 0.5 + 26 + it.scale * 8;
    let d = Math.sqrt(best);
    let { x, z } = it;
    if (d < need) {
      // Push out along the away-from-centreline direction. Degenerate case
      // (item sitting exactly on a sample) falls back to the sample's normal.
      let nx = it.x - bs.x;
      let nz = it.z - bs.z;
      if (d < 1e-3) {
        nx = Math.cos(bs.yaw);
        nz = -Math.sin(bs.yaw);
      } else {
        nx /= d;
        nz /= d;
      }
      x = bs.x + nx * need;
      z = bs.z + nz * need;
      d = need;
    }
    const y = duneProfile(bs.y, sampleDuneField(x, z), d, bs.width * 0.5);
    return { ...it, x, z, y };
  });
}

/* ── mutable active track state ───────────────────────────────────── */

let activeId: TrackId = "ash_spire";
let trackEpoch = 1;

function ctrlsFor(id: TrackId): Ctrl[] {
  return id === "cinder_bowl" ? CINDER_BOWL : ASH_SPIRE;
}

function rebuild(id: TrackId) {
  const ctrls = ctrlsFor(id);
  const samples = buildSamples(ctrls, 20);
  const length = samples[samples.length - 1]?.s
    ? samples[samples.length - 1]!.s +
      Math.hypot(
        samples[0]!.x - samples[samples.length - 1]!.x,
        samples[0]!.z - samples[samples.length - 1]!.z,
      )
    : 1;
  // Fix last sample s to total loop length conceptually via TRACK_LENGTH
  return {
    samples,
    length,
    checkpoints: buildCheckpointsFrom(samples, 14),
    edges: buildEdgeMarkersFrom(samples),
    scenery: buildSceneryFrom(samples),
  };
}

let pack = rebuild("ash_spire");

export let TRACK_SAMPLES: TrackSample[] = pack.samples;
export let TRACK_LENGTH = pack.length;
export let CHECKPOINTS: CheckpointGate[] = pack.checkpoints;
export let EDGE_MARKERS = pack.edges;
export let SCENERY: SceneryItem[] = pack.scenery;
syncSceneryHeights();

/**
 * Re-derive scenery `y` from the real ground query, once the track is live.
 *
 * settleScenery has to approximate: it runs inside rebuild(), before
 * TRACK_SAMPLES and activeId are assigned, so getSurfaceAt is not usable yet
 * and it falls back to nearest-SAMPLE distance. getSurfaceAt measures exact
 * point-to-segment, and on the berm roll-off those disagree by up to ~0.4m —
 * enough to leave a crane visibly hovering. Cheap to redo (23 items), and it
 * guarantees scenery sits on exactly the surface physics reports rather than on
 * a second, slightly different copy of the height curve.
 */
function syncSceneryHeights() {
  if (!TRACK_SAMPLES.length) return;
  for (const s of SCENERY) s.y = getGroundHeight(s.x, s.z);
}

export function getTrackEpoch() {
  return trackEpoch;
}

export function setActiveTrack(id: TrackId) {
  if (id === activeId && TRACK_SAMPLES.length > 0) return;
  activeId = id;
  pack = rebuild(id);
  TRACK_SAMPLES = pack.samples;
  TRACK_LENGTH = pack.length;
  CHECKPOINTS = pack.checkpoints;
  EDGE_MARKERS = pack.edges;
  SCENERY = pack.scenery;
  syncSceneryHeights();
  trackEpoch += 1;
}

export function getActiveTrackId(): TrackId {
  return activeId;
}

/* ── queries ──────────────────────────────────────────────────────── */

export function nearestTrackIndex(
  x: number,
  z: number,
  hintYaw?: number,
): number {
  const samples = TRACK_SAMPLES;
  const n = samples.length;
  if (n === 0) return 0;
  let best = 0;
  let bestD = Infinity;
  // Coarse then refine
  const step = Math.max(1, Math.floor(n / 48));
  for (let i = 0; i < n; i += step) {
    const s = samples[i]!;
    let d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (hintYaw !== undefined) {
      const dy = Math.atan2(
        Math.sin(s.yaw - hintYaw),
        Math.cos(s.yaw - hintYaw),
      );
      d += dy * dy * 18;
    }
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // Local refine
  for (let k = -step; k <= step; k++) {
    const i = ((best + k) % n + n) % n;
    const s = samples[i]!;
    let d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (hintYaw !== undefined) {
      const dy = Math.atan2(
        Math.sin(s.yaw - hintYaw),
        Math.cos(s.yaw - hintYaw),
      );
      d += dy * dy * 18;
    }
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Race standings progress = whole laps + [0..1) around the circuit.
 * Sequential checkpoint is the authority; arc-length refines within sector.
 */
export function trackProgress(
  x: number,
  z: number,
  lap: number,
  checkpoint: number,
  hintYaw?: number,
): number {
  const n = Math.max(1, CHECKPOINTS.length);
  const sectorFloor = checkpoint === 0 ? (n - 1) / n : checkpoint / n;
  const sectorCeil = checkpoint === 0 ? 1 : Math.min(1, (checkpoint + 1) / n);
  const idx = nearestTrackIndex(x, z, hintYaw);
  const sample = TRACK_SAMPLES[idx];
  const arc = sample ? sample.s / Math.max(1e-6, TRACK_LENGTH) : sectorFloor;

  let within: number;
  if (arc + 0.2 < sectorFloor) {
    within = sectorFloor;
  } else if (arc > sectorCeil + 0.25 && checkpoint !== 0) {
    within = sectorCeil - 1e-4;
  } else {
    const lo = sectorFloor;
    const hi = sectorCeil - 1e-4;
    within = Math.max(lo, Math.min(hi, arc));
  }
  return lap + within;
}

export function sampleAtProgress(progress: number): TrackSample {
  const frac = ((progress % 1) + 1) % 1;
  const targetS = frac * TRACK_LENGTH;
  const samples = TRACK_SAMPLES;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.abs(samples[i]!.s - targetS);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return samples[best] ?? samples[0]!;
}

export function getSurfaceAt(
  x: number,
  z: number,
  hintYaw?: number,
): SurfaceInfo {
  const idx = nearestTrackIndex(x, z, hintYaw);
  const sample = TRACK_SAMPLES[idx] ?? {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    width: 26,
    zone: "race" as const,
    s: 0,
  };
  // Refine against the two adjacent centreline segments rather than trusting
  // the distance to the nearest sample point. Midway between two samples the
  // point distance reads as half their spacing even when you are dead centre
  // on the road, which pushed the apron/dune blend inward and disagreed with
  // the visual mesh (see buildTrackField in HeightmapTerrain).
  const n = TRACK_SAMPLES.length;
  let dist = Math.hypot(x - sample.x, z - sample.z);
  if (n > 1) {
    for (let k = -1; k <= 0; k++) {
      const a = TRACK_SAMPLES[(idx + k + n) % n]!;
      const b = TRACK_SAMPLES[(idx + k + 1 + n) % n]!;
      const sx = b.x - a.x;
      const sz = b.z - a.z;
      const len2 = sx * sx + sz * sz;
      if (len2 < 1e-6) continue;
      const t = Math.min(1, Math.max(0, ((x - a.x) * sx + (z - a.z) * sz) / len2));
      const d = Math.hypot(x - (a.x + sx * t), z - (a.z + sz * t));
      if (d < dist) dist = d;
    }
  }
  const half = sample.width * 0.5;

  let kind: SurfaceKind = "asphalt";
  let factor = 0;
  if (dist <= half) {
    kind = "asphalt";
    factor = 0;
  } else if (dist <= half + 5.5) {
    kind = "apron";
    factor = (dist - half) / 5.5;
  } else if (dist <= half + 22) {
    kind = "sand";
    factor = 0.35 + ((dist - half - 5.5) / 16.5) * 0.5;
  } else {
    kind = "deep";
    factor = 0.85 + Math.min(0.15, (dist - half - 22) * 0.01);
  }

  if (sample.zone === "hazard" && kind === "asphalt") {
    factor = Math.max(factor, 0.08);
  }

  const roughness =
    kind === "asphalt"
      ? 0.08
      : kind === "apron"
        ? 0.35
        : kind === "sand"
          ? 0.7
          : 0.95;

  return { kind, factor, roughness, dist, half, sample };
}

/**
 * Physics ground height — road corridor flat, dunes rise off-track.
 * Amplitude boosted for AAA desert silhouette (cars stay on flat asphalt).
 */
export function getGroundHeight(x: number, z: number): number {
  const surf = getSurfaceAt(x, z);
  return duneProfile(surf.sample.y, sampleDuneField(x, z), surf.dist, surf.half);
}

/**
 * The desert height profile, as a pure function of (road height, dune noise,
 * distance from centreline, half-width).
 *
 * Split out of getGroundHeight so that anything PLACING geometry can land on
 * exactly the surface physics will report, without needing the active track
 * state. Scenery, decor and props all used to sit at the road plane (`s.y`) or
 * at a literal `0`, neither of which is where the ground is once you are more
 * than a couple of metres off the tarmac — which is the whole reason crates and
 * pipes were hanging in mid-air. Any placement code that duplicated this curve
 * instead of calling it would drift out of sync the moment one copy changed, so
 * there is deliberately only one.
 */
export function duneProfile(
  roadY: number,
  dune: number,
  dist: number,
  half: number,
): number {
  // Asphalt + tight shoulder: dead flat so cars never clip dunes
  const roadPad = half + 2.5;
  if (dist <= roadPad) {
    return roadY;
  }

  const apron = half + 22;
  const deep = half + 70;

  if (dist < apron) {
    // Soft roll-off berm
    const t = (dist - roadPad) / Math.max(0.01, apron - roadPad);
    const s = t * t * (3 - 2 * t);
    return roadY + dune * 1.15 * s;
  }

  if (dist < deep) {
    const t = (dist - apron) / Math.max(0.01, deep - apron);
    const s = t * t * (3 - 2 * t);
    const hNear = 1.1;
    const hFar = 1.1 + dune * 13.5;
    return roadY + hNear + (hFar - hNear) * s;
  }

  // Far desert — full procedural dunes (taller for horizon drama)
  return roadY + 1.1 + dune * 16.5;
}

export function isOnTrack(
  x: number,
  z: number,
  hintYaw?: number,
): {
  on: boolean;
  half: number;
  dist: number;
  sample: TrackSample;
} {
  const surf = getSurfaceAt(x, z, hintYaw);
  return {
    on: surf.kind === "asphalt" || surf.factor < 0.2,
    half: surf.half,
    dist: surf.dist,
    sample: surf.sample,
  };
}
