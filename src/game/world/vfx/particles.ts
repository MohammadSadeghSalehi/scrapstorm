/**
 * The VFX particle pool.
 *
 * Structure follows debris.ts, which is the proven shape in this codebase:
 * everything preallocated at module load, `active` flags instead of
 * push/splice, and saturation handled by recycling the piece closest to death
 * rather than refusing to spawn. A five-barrel chain reaction is exactly the
 * moment you cannot afford a GC pause, and it is also exactly the moment the
 * player is looking at the effects.
 *
 * --------------------------------------------------------------------------
 * DRAW-CALL AND FILL BUDGET (the binding constraint — frame time on the target
 * GPU is unmeasured, with one reading of 14fps / 226ms peaks, so everything
 * here is sized pessimistically)
 * --------------------------------------------------------------------------
 * Six layers, one InstancedMesh each, so the entire particle system is SIX
 * draw calls regardless of how many particles are live. Each particle is one
 * two-triangle quad, so the triangle cost is 2 x live count — trivial. The real
 * cost is transparent OVERDRAW, which is why the caps below are on live count
 * AND why sizes are clamped per layer rather than left to the spawner.
 *
 *   layer     capacity  tri@cap  typical live   notes
 *   SMOKE       120       240      10-45        largest quads, worst overdraw
 *   FIRE         56       112       0-24        short lived, only during blasts
 *   SPARK        72       144       0-40        small quads, cheap
 *   ARC          20        40       0-8         high tier only
 *   FLUID        32        64       0-12        small quads
 *   SHIMMER       8        16       0-4         high tier only, near-zero alpha
 *   ------------------------------------------------------------------------
 *   worst case  308       616 triangles, 6 draw calls
 *
 * Per-tier live fraction (LIVE_FRAC) then cuts that to 60% on medium and 30% on
 * low, and the renderer additionally distance-culls, so low tier peaks at ~92
 * live particles across 4 layers (ARC and SHIMMER never spawn there).
 *
 * Nothing in this file allocates after module load. `stepVfx` is a flat loop
 * over a single Float32Array; the spawners write into slots.
 */
import type { QualityTier } from "../quality";
import { rnd, rndBell, rndChance, rndIn, rndInt, rndSym, rngSeed } from "./rng";

export const VFX_LAYER = {
  /** Normal-blended soft puffs: soot, tyre smoke, off-road dust, steam. */
  SMOKE: 0,
  /** Additive combustion: fireball core, muzzle bloom, boost flare. */
  FIRE: 1,
  /** Additive hot points, optionally velocity-stretched and ground-bouncing. */
  SPARK: 2,
  /** Additive electrical arcs on damaged systems. */
  ARC: 3,
  /** Normal-blended oil / coolant droplets. */
  FLUID: 4,
  /** Near-transparent scrolling haze over hot geometry. */
  SHIMMER: 5,
} as const;

export type VfxLayer = (typeof VFX_LAYER)[keyof typeof VFX_LAYER];
export const VFX_LAYER_COUNT = 6;

const CAP = [120, 56, 72, 20, 32, 8] as const;
const START = [0, 120, 176, 248, 268, 300] as const;
export const VFX_TOTAL = 308;

/** Fraction of each layer's capacity allowed live, per tier. */
const LIVE_FRAC: Record<QualityTier, number> = { low: 0.3, medium: 0.6, high: 1 };

/**
 * Field offsets into the interleaved pool.
 *
 * Interleaved rather than 24 parallel arrays: the step loop touches almost
 * every field of one particle before moving on, so one strided walk beats 24
 * independent walks over 24 cache lines.
 */
const F = {
  X: 0,
  Y: 1,
  Z: 2,
  VX: 3,
  VY: 4,
  VZ: 5,
  LIFE: 6,
  MAXLIFE: 7,
  /** Sprite half-size in metres at birth and at death. */
  SIZE0: 8,
  SIZE1: 9,
  ROT: 10,
  SPIN: 11,
  R0: 12,
  G0: 13,
  B0: 14,
  R1: 15,
  G1: 16,
  B1: 17,
  /** Peak opacity before the per-layer life curve is applied. */
  ALPHA: 18,
  /** Linear damping, per second. */
  DRAG: 19,
  /** Signed vertical accel: negative = gravity, positive = buoyancy. */
  GRAV: 20,
  /** Rest plane for FLAG_BOUNCE / FLAG_GROUND — from getGroundHeight. */
  GROUNDY: 21,
  /** How strongly this particle couples to wind + curl noise. */
  TURB: 22,
  /** >0 = stretch the quad along velocity by this factor. */
  STRETCH: 23,
} as const;

export const VFX_STRIDE = 24;
export const VFX_F = F;

export const VFX_FLAG = {
  /** Bounces off GROUNDY, losing energy — sparks skittering across tarmac. */
  BOUNCE: 1,
  /** Clamps to GROUNDY and spreads — dust and soot pooling on the floor. */
  GROUND: 2,
  /** Quad's long axis follows velocity instead of screen up. */
  ALIGN: 4,
  /** Leaves a stain where it lands (oil). */
  STAIN: 8,
} as const;

const data = new Float32Array(VFX_TOTAL * VFX_STRIDE);
const active = new Uint8Array(VFX_TOTAL);
const layerOf = new Uint8Array(VFX_TOTAL);
const flags = new Uint8Array(VFX_TOTAL);
const counts = new Int32Array(VFX_LAYER_COUNT);
const cursors = new Int32Array(VFX_LAYER_COUNT);

/**
 * Desert wind. Smoke that rises straight up and stays put is the giveaway that
 * a column is a particle emitter; drifting it downwind and letting turbulence
 * shear it is most of what makes a sustained column read as real.
 */
const WIND_X = 1.9;
const WIND_Z = -1.15;

let vfxTime = 0;

/** Landing callback for FLAG_STAIN, wired by the scene so this file stays pure. */
let onFluidLand: ((x: number, y: number, z: number, size: number) => void) | null = null;
export function setFluidLandHandler(
  fn: ((x: number, y: number, z: number, size: number) => void) | null,
): void {
  onFluidLand = fn;
}

export function vfxData(): Float32Array {
  return data;
}
export function vfxActive(): Uint8Array {
  return active;
}
export function vfxFlags(): Uint8Array {
  return flags;
}
export function vfxLayerStart(layer: number): number {
  return START[layer]!;
}
export function vfxLayerCap(layer: number): number {
  return CAP[layer]!;
}
export function vfxLayerLive(layer: number): number {
  return counts[layer]!;
}
export function vfxLiveTotal(): number {
  let n = 0;
  for (let i = 0; i < VFX_LAYER_COUNT; i++) n += counts[i]!;
  return n;
}
export function vfxClock(): number {
  return vfxTime;
}

let tier: QualityTier = "medium";
export function setVfxTier(t: QualityTier): void {
  tier = t;
}
export function vfxTier(): QualityTier {
  return tier;
}

function limitFor(layer: number): number {
  // ARC and SHIMMER are pure garnish and the first things to go: on low tier
  // they are switched off entirely rather than merely thinned, because four
  // arcs is not a cheaper version of twenty, it is a different (worse) effect.
  if (tier === "low" && (layer === VFX_LAYER.ARC || layer === VFX_LAYER.SHIMMER)) {
    return 0;
  }
  if (tier === "medium" && layer === VFX_LAYER.SHIMMER) return 0;
  return Math.ceil(CAP[layer]! * LIVE_FRAC[tier]);
}

/**
 * Next writable slot inside a layer's own range.
 *
 * Per-layer ranges rather than one shared free list on purpose: a wrecked car
 * pouring out a smoke column would otherwise starve the spark pool, and the
 * frame where you most need sparks (the impact that wrecked it) is the frame
 * the column is thickest.
 *
 * Returns -1 when the layer is disabled for this tier.
 */
function acquire(layer: number): number {
  const limit = limitFor(layer);
  if (limit <= 0) return -1;
  const s = START[layer]!;
  const c = CAP[layer]!;

  if (counts[layer]! < limit) {
    for (let i = 0; i < c; i++) {
      const idx = s + ((cursors[layer]! + i) % c);
      if (!active[idx]) {
        cursors[layer] = (cursors[layer]! + i + 1) % c;
        active[idx] = 1;
        counts[layer] = counts[layer]! + 1;
        layerOf[idx] = layer;
        flags[idx] = 0;
        return idx;
      }
    }
  }

  /*
   * At or over the tier's live budget: degrade oldest-first, i.e. RECYCLE
   * whichever active slot is closest to dying.
   *
   * It must not fall back to a free slot here, even when the layer's physical
   * capacity has room. An earlier version did, and the effect was that the
   * per-tier budget only ever bound once the pool was physically full — a low
   * tier that should have held 85 particles held 248, because the "saturated"
   * path kept finding free slots and incrementing past the limit. That is the
   * exact opposite of what the budget is for.
   *
   * Recycling in pool order rather than by remaining life would routinely kill
   * a spark that launched this frame while a two-second-old smoke puff sat
   * untouched, which is why this is a shortest-life scan.
   *
   * `worst` is annotated because START is `as const`, so `s` carries a
   * literal-union type that an inferred `let` would inherit and then reject
   * every other slot index.
   */
  let worst = -1;
  let worstLife = Infinity;
  for (let i = 0; i < c; i++) {
    const idx = s + i;
    if (!active[idx]) continue;
    const l = data[idx * VFX_STRIDE + F.LIFE]!;
    if (l < worstLife) {
      worstLife = l;
      worst = idx;
    }
  }
  if (worst < 0) {
    // Only reachable if the tier limit dropped to zero live particles while
    // the layer is enabled; take the first slot rather than returning -1 so a
    // caller never silently loses an entire effect.
    const idx: number = s;
    active[idx] = 1;
    counts[layer] = counts[layer]! + 1;
    layerOf[idx] = layer;
    flags[idx] = 0;
    return idx;
  }
  layerOf[worst] = layer;
  flags[worst] = 0;
  return worst;
}

/** Write a slot. All spawners funnel through here so no field is ever stale. */
function emit(
  layer: number,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  life: number,
  size0: number,
  size1: number,
  r0: number,
  g0: number,
  b0: number,
  r1: number,
  g1: number,
  b1: number,
  alpha: number,
  drag: number,
  grav: number,
  turb: number,
  spin: number,
  stretch: number,
  flag: number,
  groundY: number,
): number {
  const i = acquire(layer);
  if (i < 0) return -1;
  const o = i * VFX_STRIDE;
  data[o + F.X] = x;
  data[o + F.Y] = y;
  data[o + F.Z] = z;
  data[o + F.VX] = vx;
  data[o + F.VY] = vy;
  data[o + F.VZ] = vz;
  data[o + F.LIFE] = life;
  data[o + F.MAXLIFE] = life;
  data[o + F.SIZE0] = size0;
  data[o + F.SIZE1] = size1;
  data[o + F.ROT] = rnd() * Math.PI * 2;
  data[o + F.SPIN] = spin;
  data[o + F.R0] = r0;
  data[o + F.G0] = g0;
  data[o + F.B0] = b0;
  data[o + F.R1] = r1;
  data[o + F.G1] = g1;
  data[o + F.B1] = b1;
  data[o + F.ALPHA] = alpha;
  data[o + F.DRAG] = drag;
  data[o + F.GRAV] = grav;
  data[o + F.GROUNDY] = groundY;
  data[o + F.TURB] = turb;
  data[o + F.STRETCH] = stretch;
  flags[i] = flag;
  return i;
}

/* ------------------------------------------------------------------ step */

/**
 * Integrate the whole pool.
 *
 * Driven from the RENDER clock, not the fixed sim step. Particles are not
 * gameplay: nothing reads their positions back, so there is no determinism to
 * protect, and stepping them at display rate is what stops smoke from visibly
 * ticking at 60Hz on a 144Hz panel. It also means this subsystem needs no hook
 * inside worldProps/sim, which are owned elsewhere.
 */
export function stepVfx(dt: number): void {
  if (dt <= 0) return;
  // Clamp: a tab that was backgrounded hands back a multi-second delta, and
  // integrating that in one go teleports every particle to the horizon.
  const h = dt > 0.06 ? 0.06 : dt;
  vfxTime += h;

  for (let layer = 0; layer < VFX_LAYER_COUNT; layer++) {
    if (counts[layer] === 0) continue;
    const s = START[layer]!;
    const c = CAP[layer]!;
    for (let k = 0; k < c; k++) {
      const i = s + k;
      if (!active[i]) continue;
      const o = i * VFX_STRIDE;

      const life = data[o + F.LIFE]! - h;
      if (life <= 0) {
        active[i] = 0;
        counts[layer] = counts[layer]! - 1;
        continue;
      }
      data[o + F.LIFE] = life;

      let vx = data[o + F.VX]!;
      let vy = data[o + F.VY]!;
      let vz = data[o + F.VZ]!;

      vy += data[o + F.GRAV]! * h;

      const turb = data[o + F.TURB]!;
      if (turb > 0) {
        const x = data[o + F.X]!;
        const y = data[o + F.Y]!;
        const z = data[o + F.Z]!;
        const ph = data[o + F.ROT]!;
        // Cheap divergence-free-ish curl. Two sines is enough shear to break a
        // column into billows; a real noise field would be strictly better and
        // strictly more expensive, and this runs on up to 308 particles.
        vx += (Math.sin(y * 0.55 + vfxTime * 1.3 + ph) * 1.6 + (WIND_X - vx) * 0.35) * turb * h;
        vz += (Math.cos(x * 0.42 + vfxTime * 1.1 + ph) * 1.6 + (WIND_Z - vz) * 0.35) * turb * h;
        vy += Math.sin(z * 0.37 + vfxTime * 0.9 + ph) * 0.55 * turb * h;
      }

      const drag = 1 - Math.min(0.95, data[o + F.DRAG]! * h);
      vx *= drag;
      vy *= drag;
      vz *= drag;

      const px = data[o + F.X]! + vx * h;
      let py = data[o + F.Y]! + vy * h;
      const pz = data[o + F.Z]! + vz * h;

      const fl = flags[i]!;
      if (fl & (VFX_FLAG.BOUNCE | VFX_FLAG.GROUND)) {
        const gy = data[o + F.GROUNDY]!;
        if (py < gy) {
          if (fl & VFX_FLAG.BOUNCE) {
            py = gy;
            // Sparks skitter: most of the vertical energy is lost, most of the
            // horizontal is kept, so they run along the ground instead of
            // pogoing on the spot. The life penalty stops a spark bouncing for
            // its full lifetime in one place, which reads as a stuck sprite.
            vy = -vy * 0.32;
            vx *= 0.74;
            vz *= 0.74;
            if (vy < 1.1) {
              vy *= 0.4;
              data[o + F.LIFE] = life * 0.72;
            }
            if (fl & VFX_FLAG.STAIN && onFluidLand && rndChance(0.28)) {
              onFluidLand(px, gy, pz, data[o + F.SIZE1]!);
            }
          } else {
            // Ground-hugging smoke: kill the descent and let it spread out.
            py = gy;
            vy = 0;
            vx *= 1.02;
            vz *= 1.02;
          }
        }
      }

      data[o + F.VX] = vx;
      data[o + F.VY] = vy;
      data[o + F.VZ] = vz;
      data[o + F.X] = px;
      data[o + F.Y] = py;
      data[o + F.Z] = pz;
      data[o + F.ROT] = data[o + F.ROT]! + data[o + F.SPIN]! * h;
    }
  }
}

export function resetVfx(): void {
  active.fill(0);
  counts.fill(0);
  cursors.fill(0);
  flags.fill(0);
  vfxTime = 0;
}

/* -------------------------------------------------------------- spawners */

const TAU = Math.PI * 2;

/**
 * Explosion kinds. These are not size presets — each one changes the RATIO of
 * fire to soot to sparks to ground dust, which is what makes a barrel rupture
 * read differently from a mine going off rather than just bigger.
 */
export type BlastKind = "barrel" | "mine" | "shell" | "wreck" | "small" | "missile";

interface BlastProfile {
  /** Multiplies every particle count. */
  density: number;
  fire: number;
  soot: number;
  sparks: number;
  groundDust: number;
  /** 0 = sooty orange fireball, 1 = clean white-hot flash. */
  temper: number;
  /** Seconds the soot column lives, before per-particle jitter. */
  sootLife: number;
  /** Radial launch speed of the fireball, m/s. */
  burst: number;
  /**
   * Slow, long-lived flame left burning after the fireball has gone.
   *
   * The fireball is 0.3-0.7s; anything that reads as "something is ON FIRE"
   * rather than "something flashed" has to outlast it. 0 on every kind that
   * predates this, so their timing is unchanged.
   */
  linger?: number;
}

const BLAST: Record<BlastKind, BlastProfile> = {
  // Fuel: a big lazy orange fireball, comparatively few sparks, and a soot
  // column that outlives the fire by an order of magnitude. The fire is the
  // event; the smoke is the memory of it.
  barrel: {
    density: 1,
    fire: 8,
    soot: 10,
    sparks: 10,
    groundDust: 6,
    temper: 0.25,
    sootLife: 4.4,
    burst: 7,
  },
  // Shaped charge: white flash, very little sustained flame, a lot of fast
  // metal. Sharp and over quickly.
  mine: {
    density: 1,
    fire: 5,
    soot: 5,
    sparks: 18,
    groundDust: 8,
    temper: 0.85,
    sootLife: 2.4,
    burst: 11,
  },
  // A shell landing in sand is mostly a dirt geyser with a flash in it.
  shell: {
    density: 0.8,
    fire: 3,
    soot: 3,
    sparks: 7,
    groundDust: 10,
    temper: 0.55,
    sootLife: 2,
    burst: 6,
  },
  // A burning wreck: almost no flash, thick black smoke for a long time.
  wreck: {
    density: 1.1,
    fire: 6,
    soot: 14,
    sparks: 8,
    groundDust: 4,
    temper: 0.1,
    sootLife: 6,
    burst: 5,
  },
  small: {
    density: 0.55,
    fire: 3,
    soot: 3,
    sparks: 6,
    groundDust: 3,
    temper: 0.6,
    sootLife: 1.6,
    burst: 5,
  },
  /*
   * High-explosive warhead against a car — the heaviest thing in the game.
   *
   * Deliberately NOT the mine profile it used to borrow. A mine is a shaped
   * charge going off under a floorpan: a white flash, a lot of fast metal, over
   * in a quarter of a second. A rocket is a filled warhead going off against
   * bodywork, and it has to read as three separate stages the eye can follow —
   * a hard flash, a big rolling fireball that cools from yellow through orange
   * to deep red, and then FIRE STILL BURNING plus a soot plume that hangs long
   * enough for the car to drive out of it. `linger` is that third stage; it is
   * the difference between an explosion and a detonation.
   *
   * temper sits mid-range rather than high because HE against a painted panel
   * is sooty. A clean white blast would read as energy, which is the
   * interceptor's vocabulary, not this one.
   */
  missile: {
    density: 1.05,
    fire: 8,
    soot: 11,
    sparks: 15,
    groundDust: 5,
    temper: 0.5,
    sootLife: 3.8,
    burst: 13,
    linger: 5,
  },
};

export interface BlastOptions {
  kind?: BlastKind;
  /** Fireball radius in metres. Everything else scales off this. */
  radius?: number;
  /** 0..1.5 — pushes counts, speed and lifetimes together. */
  energy?: number;
  /** Ground plane under the blast; MUST come from getGroundHeight. */
  groundY?: number;
  /** Direction the blast was travelling, for a lopsided burst. */
  dirX?: number;
  dirZ?: number;
  seed: number;
}

/**
 * The full explosion: flash, fireball, soot, ground ring and sparks.
 *
 * Deliberately layered rather than one "explosion particle": the phases are
 * what sell it. The flash is 2-3 frames of near-white, the fireball is half a
 * second of combustion cooling from yellow to deep red, and the soot is a
 * multi-second column that starts where the fire was and drifts downwind. A
 * single sprite doing all three at once is the "engine default" look.
 *
 * Returns the number of particles actually written (0 if the pools were full),
 * which the caller can use to decide whether to bother with a shockwave.
 */
export function vfxExplosion(
  x: number,
  y: number,
  z: number,
  opts: BlastOptions,
): number {
  rngSeed(opts.seed);
  const prof = BLAST[opts.kind ?? "barrel"];
  const radius = opts.radius ?? 2.2;
  const energy = Math.max(0.2, Math.min(1.5, opts.energy ?? 1));
  const groundY = opts.groundY ?? y - 0.6;
  const dirX = opts.dirX ?? 0;
  const dirZ = opts.dirZ ?? 0;

  // Per-event colour temperature. This is the single most effective variation
  // knob: two barrels at 0.2 and 0.6 look like different fuels, not like the
  // same effect twice.
  const temper = Math.max(0, Math.min(1, prof.temper + rndBell() * 0.28));
  const scale = radius * (0.85 + rnd() * 0.35);
  const dens = prof.density * (0.75 + energy * 0.5);
  let written = 0;

  // --- 1. Flash. Two frames of it. Sized big and faded instantly so it reads
  //        as exposure rather than as a sphere.
  const flashN = 1 + (rnd() < 0.5 ? 1 : 0);
  for (let i = 0; i < flashN; i++) {
    written +=
      emit(
        VFX_LAYER.FIRE,
        x + rndSym() * scale * 0.2,
        y + rndSym() * scale * 0.2,
        z + rndSym() * scale * 0.2,
        0,
        0.5,
        0,
        rndIn(0.055, 0.1),
        scale * rndIn(1.1, 1.5),
        scale * rndIn(1.9, 2.5),
        1,
        0.97 - (1 - temper) * 0.08,
        0.82 + temper * 0.16,
        1,
        0.72,
        0.34,
        0.95,
        3.5,
        1.2,
        0,
        rndSym() * 2,
        0,
        0,
        groundY,
      ) >= 0
        ? 1
        : 0;
  }

  // --- 2. Fireball. Radial, biased along the blast direction, cooling from
  //        white-yellow to deep red across its (short) life.
  const fireN = Math.round(prof.fire * dens);
  for (let i = 0; i < fireN; i++) {
    const a = rnd() * TAU;
    const el = rndIn(-0.25, 0.95);
    const sp = prof.burst * rndIn(0.35, 1.05) * (0.7 + energy * 0.45);
    const cx = Math.cos(a) * Math.cos(el) + dirX * 0.45;
    const cz = Math.sin(a) * Math.cos(el) + dirZ * 0.45;
    const cy = Math.sin(el);
    written +=
      emit(
        VFX_LAYER.FIRE,
        x + cx * scale * 0.35,
        y + cy * scale * 0.3,
        z + cz * scale * 0.35,
        cx * sp,
        cy * sp + 1.4,
        cz * sp,
        rndIn(0.3, 0.42) + energy * 0.28,
        scale * rndIn(0.35, 0.72),
        scale * rndIn(1.35, 2.15),
        1,
        0.9 - (1 - temper) * 0.16,
        0.55 + temper * 0.3,
        rndIn(0.75, 0.95),
        rndIn(0.14, 0.28),
        0.05,
        rndIn(0.72, 0.95),
        rndIn(2.4, 3.6),
        1.6,
        0.35,
        rndSym() * 2.4,
        0,
        0,
        groundY,
      ) >= 0
        ? 1
        : 0;
  }

  // --- 2b. Residual burn. Slow, buoyant, an order of magnitude longer lived
  //         than the fireball, and it starts already deep orange rather than
  //         white — this is fuel still burning, not the detonation.
  const lingerN = Math.round((prof.linger ?? 0) * dens);
  for (let i = 0; i < lingerN; i++) {
    const a = rnd() * TAU;
    written +=
      emit(
        VFX_LAYER.FIRE,
        x + Math.cos(a) * scale * rndIn(0.1, 0.5),
        y + rndIn(-0.1, 0.4) * scale,
        z + Math.sin(a) * scale * rndIn(0.1, 0.5),
        Math.cos(a) * rndIn(0.3, 1.4) + dirX * 0.8,
        rndIn(1.1, 2.8),
        Math.sin(a) * rndIn(0.3, 1.4) + dirZ * 0.8,
        rndIn(0.9, 1.9) + energy * 0.5,
        scale * rndIn(0.2, 0.42),
        scale * rndIn(0.55, 0.95),
        1,
        rndIn(0.6, 0.78),
        rndIn(0.16, 0.3),
        rndIn(0.55, 0.8),
        rndIn(0.08, 0.16),
        0.02,
        rndIn(0.55, 0.8),
        rndIn(1.1, 1.8),
        1.5,
        0.75,
        rndSym() * 1.6,
        0,
        0,
        groundY,
      ) >= 0
        ? 1
        : 0;
  }

  // --- 3. Soot. Starts inside the fireball, outlives it 8-10x, drifts.
  //        Colour goes DARK -> LIGHT over life: hot soot is near black and
  //        pales as it cools and mixes with air. Getting that backwards (the
  //        intuitive "fades to black") is why smoke used to read as a stain.
  const sootN = Math.round(prof.soot * dens);
  const soot0 = 0.1 + (1 - temper) * 0.06;
  for (let i = 0; i < sootN; i++) {
    const a = rnd() * TAU;
    const sp = prof.burst * rndIn(0.12, 0.42);
    written +=
      emit(
        VFX_LAYER.SMOKE,
        x + Math.cos(a) * scale * rndIn(0.1, 0.55),
        y + rndIn(-0.1, 0.7) * scale,
        z + Math.sin(a) * scale * rndIn(0.1, 0.55),
        Math.cos(a) * sp + dirX * 1.2,
        rndIn(0.9, 2.6),
        Math.sin(a) * sp + dirZ * 1.2,
        prof.sootLife * rndIn(0.6, 1.35),
        scale * rndIn(0.5, 0.9),
        scale * rndIn(2.4, 4.2),
        soot0 * rndIn(0.8, 1.3),
        soot0 * rndIn(0.75, 1.2),
        soot0 * rndIn(0.7, 1.1),
        rndIn(0.36, 0.5),
        rndIn(0.33, 0.46),
        rndIn(0.3, 0.42),
        rndIn(0.42, 0.62),
        rndIn(0.55, 0.95),
        1.15,
        rndIn(0.5, 1),
        rndSym() * 0.7,
        0,
        0,
        groundY,
      ) >= 0
        ? 1
        : 0;
  }

  // --- 4. Ground ring. Sand thrown outward and low. This is what anchors the
  //        blast to the terrain; without it a fireball floats.
  const dustN = Math.round(prof.groundDust * dens);
  for (let i = 0; i < dustN; i++) {
    const a = rnd() * TAU;
    const sp = rndIn(3.5, 9) * (0.6 + energy * 0.6);
    written +=
      emit(
        VFX_LAYER.SMOKE,
        x + Math.cos(a) * scale * 0.5,
        groundY + rndIn(0.05, 0.5),
        z + Math.sin(a) * scale * 0.5,
        Math.cos(a) * sp,
        rndIn(0.6, 2.4),
        Math.sin(a) * sp,
        rndIn(1.1, 2.6),
        scale * rndIn(0.3, 0.6),
        scale * rndIn(1.4, 2.6),
        0.74,
        0.62,
        0.44,
        0.6,
        0.53,
        0.42,
        rndIn(0.28, 0.46),
        rndIn(1.5, 2.4),
        -0.4,
        rndIn(0.3, 0.7),
        rndSym() * 0.9,
        0,
        VFX_FLAG.GROUND,
        groundY,
      ) >= 0
        ? 1
        : 0;
  }

  // --- 5. Sparks. Bouncing, velocity-stretched, cooling to red.
  const sparkN = Math.round(prof.sparks * dens);
  for (let i = 0; i < sparkN; i++) {
    const a = rnd() * TAU;
    const el = rndIn(-0.15, 1.25);
    const sp = rndIn(6, 20) * (0.6 + energy * 0.7);
    const cx = Math.cos(a) * Math.cos(el) + dirX * 0.5;
    const cz = Math.sin(a) * Math.cos(el) + dirZ * 0.5;
    written +=
      emit(
        VFX_LAYER.SPARK,
        x + cx * 0.3,
        y + rndIn(0, 0.5),
        z + cz * 0.3,
        cx * sp,
        Math.sin(el) * sp + 2,
        cz * sp,
        rndIn(0.35, 1.35),
        rndIn(0.045, 0.1),
        rndIn(0.02, 0.05),
        1,
        rndIn(0.86, 0.98),
        rndIn(0.55, 0.8),
        rndIn(0.7, 0.95),
        rndIn(0.1, 0.24),
        0.03,
        rndIn(0.7, 1),
        rndIn(0.25, 0.6),
        -19,
        0,
        0,
        rndIn(2.5, 7),
        VFX_FLAG.BOUNCE | VFX_FLAG.ALIGN,
        groundY,
      ) >= 0
        ? 1
        : 0;
  }

  return written;
}

/**
 * Muzzle flash, per weapon type.
 *
 * The weapons are different physical devices and should not share a flash: the
 * interceptor's twin bolts are an energy discharge (tiny, teal, no smoke), the
 * bruiser's cannon is a chemical propellant gun (big warm bloom plus a forward
 * smoke jet), the trickster's disc launcher is an EM rail (cold ring plus arcs,
 * no combustion at all), and a rocket is the only one of the four that throws
 * most of its signature BACKWARDS.
 */
export function vfxMuzzleFlash(
  x: number,
  y: number,
  z: number,
  dx: number,
  dz: number,
  weapon: "bolt" | "cannon" | "disc" | "rocket",
  charge: number,
  seed: number,
): void {
  rngSeed(seed);
  const ch = 0.7 + Math.max(0, Math.min(1, charge)) * 0.6;

  if (weapon === "rocket") {
    /*
     * Back-blast, which is the whole tell that a rocket left a tube rather than
     * a gun firing a shell. A gun's propellant goes forward with the projectile;
     * a launcher's exhaust goes out of the BACK, hangs, and rolls outward — so
     * everything here is emitted along -d and given almost no forward carry.
     */
    for (let i = 0; i < 6; i++) {
      const sp = rndIn(3, 9);
      emit(
        VFX_LAYER.SMOKE,
        x - dx * rndIn(0.1, 1.1),
        y + rndSym() * 0.2,
        z - dz * rndIn(0.1, 1.1),
        -dx * sp + rndSym() * 2.2,
        rndIn(0.4, 1.8),
        -dz * sp + rndSym() * 2.2,
        rndIn(0.8, 1.6),
        rndIn(0.24, 0.45) * ch,
        rndIn(1.3, 2.2) * ch,
        0.5,
        0.47,
        0.44,
        0.66,
        0.63,
        0.6,
        rndIn(0.26, 0.42),
        rndIn(2.4, 3.6),
        0.5,
        0.6,
        rndSym() * 1.5,
        0,
        0,
        y - 1,
      );
    }
    // Motor ignition: a short bright plume at the tube mouth, the one part that
    // does point forward, because that is where the nozzle is once it clears.
    for (let i = 0; i < 2; i++) {
      emit(
        VFX_LAYER.FIRE,
        x + dx * rndIn(0, 0.5),
        y,
        z + dz * rndIn(0, 0.5),
        -dx * rndIn(1, 4),
        rndIn(0.2, 1),
        -dz * rndIn(1, 4),
        rndIn(0.09, 0.17),
        rndIn(0.4, 0.7) * ch,
        rndIn(0.95, 1.5) * ch,
        1,
        0.9,
        0.62,
        1,
        0.38,
        0.08,
        0.9,
        4,
        0.7,
        0,
        rndSym() * 3,
        0,
        0,
        y - 1,
      );
    }
    for (let i = 0; i < 5; i++) {
      const sp = rndIn(6, 16);
      emit(
        VFX_LAYER.SPARK,
        x,
        y,
        z,
        -dx * sp + rndSym() * 3,
        rndIn(-1, 2.5),
        -dz * sp + rndSym() * 3,
        rndIn(0.14, 0.4),
        rndIn(0.035, 0.07),
        0.014,
        1,
        rndIn(0.8, 0.94),
        0.5,
        0.8,
        0.18,
        0.03,
        0.75,
        rndIn(1.6, 2.8),
        -12,
        0,
        0,
        rndIn(3, 6),
        VFX_FLAG.ALIGN,
        y - 1,
      );
    }
    return;
  }

  if (weapon === "bolt") {
    for (let i = 0; i < 2; i++) {
      emit(
        VFX_LAYER.FIRE,
        x + dx * rndIn(0, 0.3),
        y,
        z + dz * rndIn(0, 0.3),
        dx * 5,
        rndIn(-0.4, 0.6),
        dz * 5,
        rndIn(0.045, 0.08),
        rndIn(0.24, 0.4) * ch,
        rndIn(0.5, 0.75) * ch,
        0.72,
        1,
        0.94,
        0.16,
        0.78,
        0.72,
        0.85,
        6,
        0,
        0,
        rndSym() * 4,
        0,
        0,
        y - 1,
      );
    }
    for (let i = 0; i < 3; i++) {
      const sp = rndIn(7, 15);
      emit(
        VFX_LAYER.SPARK,
        x,
        y,
        z,
        dx * sp + rndSym() * 3,
        rndIn(-1, 2),
        dz * sp + rndSym() * 3,
        rndIn(0.08, 0.2),
        rndIn(0.03, 0.06),
        0.012,
        0.75,
        1,
        0.96,
        0.2,
        0.8,
        0.78,
        0.8,
        1.5,
        -6,
        0,
        0,
        rndIn(3, 6),
        VFX_FLAG.ALIGN,
        y - 1,
      );
    }
    return;
  }

  if (weapon === "cannon") {
    emit(
      VFX_LAYER.FIRE,
      x + dx * 0.3,
      y,
      z + dz * 0.3,
      dx * 3,
      0.6,
      dz * 3,
      rndIn(0.07, 0.12),
      rndIn(0.75, 1.1) * ch,
      rndIn(1.3, 1.9) * ch,
      1,
      0.95,
      0.74,
      1,
      0.45,
      0.1,
      0.9,
      5,
      0.5,
      0,
      rndSym() * 3,
      0,
      0,
      y - 1,
    );
    // Propellant blast: a short cone of grey smoke pushed hard forward, which
    // then stalls. This is the part that makes the cannon feel heavy.
    for (let i = 0; i < 5; i++) {
      const sp = rndIn(4, 11);
      emit(
        VFX_LAYER.SMOKE,
        x + dx * rndIn(0.2, 0.9),
        y + rndSym() * 0.15,
        z + dz * rndIn(0.2, 0.9),
        dx * sp + rndSym() * 2.4,
        rndIn(0.2, 1.4),
        dz * sp + rndSym() * 2.4,
        rndIn(0.5, 1.1),
        rndIn(0.2, 0.4),
        rndIn(0.9, 1.6),
        0.42,
        0.39,
        0.36,
        0.6,
        0.57,
        0.53,
        rndIn(0.24, 0.4),
        rndIn(3.2, 4.6),
        0.4,
        0.5,
        rndSym() * 1.4,
        0,
        0,
        y - 1,
      );
    }
    for (let i = 0; i < 7; i++) {
      const sp = rndIn(8, 22);
      const spread = 0.32;
      emit(
        VFX_LAYER.SPARK,
        x + dx * 0.4,
        y,
        z + dz * 0.4,
        (dx + rndSym() * spread) * sp,
        rndIn(-1, 3),
        (dz + rndSym() * spread) * sp,
        rndIn(0.12, 0.4),
        rndIn(0.04, 0.085),
        0.015,
        1,
        rndIn(0.88, 0.98),
        0.62,
        0.85,
        0.2,
        0.04,
        0.8,
        rndIn(1.4, 2.6),
        -14,
        0,
        0,
        rndIn(3, 7),
        VFX_FLAG.ALIGN,
        y - 1,
      );
    }
    return;
  }

  // disc — electromagnetic launcher: cold, no combustion, visible arcing.
  for (let i = 0; i < 2; i++) {
    emit(
      VFX_LAYER.FIRE,
      x + dx * rndIn(0.1, 0.4),
      y,
      z + dz * rndIn(0.1, 0.4),
      dx * 2,
      0.3,
      dz * 2,
      rndIn(0.05, 0.09),
      rndIn(0.3, 0.5) * ch,
      rndIn(0.7, 1.0) * ch,
      0.5,
      0.95,
      1,
      0.1,
      0.55,
      0.8,
      0.8,
      6,
      0,
      0,
      rndSym() * 5,
      0,
      0,
      y - 1,
    );
  }
  vfxElectricArc(x + dx * 0.5, y, z + dz * 0.5, 0.7, seed ^ 0x51ab);
}

/**
 * A projectile's wake. Called once per rendered frame per live projectile with
 * the frame delta; internally rate-limited by the caller's accumulator, so this
 * only ever writes one or two particles.
 */
export function vfxProjectileTrail(
  kind: "bolt" | "cannon" | "disc" | "missile",
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  seed: number,
): void {
  rngSeed(seed);
  const inv = 1 / (Math.hypot(vx, vy, vz) || 1);

  if (kind === "missile") {
    /*
     * A motor that is still burning, which is what separates a rocket's wake
     * from a shell's. Two parts, and the ratio is the effect:
     *
     *  - a short, hot, thin exhaust that sits just behind the nozzle and dies in
     *    a tenth of a second, so it stays welded to the missile and reads as
     *    thrust rather than as a comet tail;
     *  - a thick pale smoke trail that takes almost none of the missile's
     *    velocity and therefore hangs in the air. That hanging line is what lets
     *    you see a salvo's arc, and see it curving toward you.
     *
     * The missile borrowed the cannon trail before this, which is propellant
     * smoke with no fire at all — a guided rocket that looks like a lobbed shell
     * is unreadable as a threat.
     */
    emit(
      VFX_LAYER.FIRE,
      x - vx * inv * 0.42,
      y - vy * inv * 0.42,
      z - vz * inv * 0.42,
      -vx * 0.12,
      -vy * 0.12 + 0.3,
      -vz * 0.12,
      rndIn(0.07, 0.13),
      rndIn(0.14, 0.24),
      rndIn(0.3, 0.5),
      1,
      rndIn(0.86, 0.98),
      rndIn(0.5, 0.72),
      1,
      0.4,
      0.1,
      rndIn(0.7, 0.95),
      rndIn(3, 4.5),
      0.6,
      0,
      rndSym() * 4,
      0,
      0,
      y - 20,
    );
    emit(
      VFX_LAYER.SMOKE,
      x - vx * inv * 0.85,
      y - vy * inv * 0.85,
      z - vz * inv * 0.85,
      rndSym() * 0.7,
      rndIn(0.2, 0.9),
      rndSym() * 0.7,
      rndIn(1.1, 2.1),
      rndIn(0.12, 0.22),
      rndIn(0.9, 1.7),
      // Pale, not grey: a solid rocket motor's exhaust is close to white and
      // stays bright as it expands, which is what makes the line readable
      // against the desert rather than dissolving into it.
      0.78,
      0.76,
      0.73,
      0.62,
      0.6,
      0.58,
      rndIn(0.2, 0.34),
      rndIn(0.9, 1.5),
      0.5,
      0.55,
      rndSym() * 1,
      0,
      0,
      y - 20,
    );
    return;
  }

  if (kind === "bolt") {
    emit(
      VFX_LAYER.SPARK,
      x,
      y,
      z,
      vx * 0.06,
      vy * 0.06,
      vz * 0.06,
      rndIn(0.08, 0.16),
      rndIn(0.05, 0.085),
      0.02,
      0.6,
      1,
      0.93,
      0.12,
      0.62,
      0.58,
      0.7,
      3,
      0,
      0,
      0,
      rndIn(4, 7),
      VFX_FLAG.ALIGN,
      y - 20,
    );
    return;
  }

  if (kind === "cannon") {
    // A shell trails propellant smoke, and the smoke is left BEHIND — it takes
    // almost none of the shell's velocity, which is what makes the trail read
    // as a line in the air rather than a comet stuck to the projectile.
    emit(
      VFX_LAYER.SMOKE,
      x - vx * inv * 0.5,
      y,
      z - vz * inv * 0.5,
      rndSym() * 0.6,
      rndIn(0.15, 0.7),
      rndSym() * 0.6,
      rndIn(0.6, 1.3),
      rndIn(0.1, 0.2),
      rndIn(0.5, 1.0),
      0.4,
      0.37,
      0.34,
      0.58,
      0.55,
      0.51,
      rndIn(0.14, 0.26),
      1.2,
      0.35,
      0.45,
      rndSym() * 1.1,
      0,
      0,
      y - 20,
    );
    if (rndChance(0.35)) {
      emit(
        VFX_LAYER.SPARK,
        x,
        y,
        z,
        rndSym() * 1.5,
        rndIn(-0.5, 1),
        rndSym() * 1.5,
        rndIn(0.15, 0.35),
        rndIn(0.03, 0.05),
        0.01,
        1,
        0.8,
        0.4,
        0.6,
        0.16,
        0.03,
        0.6,
        1.5,
        -8,
        0,
        0,
        2,
        VFX_FLAG.ALIGN,
        y - 20,
      );
    }
    return;
  }

  // disc — a cold cyan helix, so the ricochet path is readable in the air.
  const a = seed * 0.001 + x * 0.7;
  emit(
    VFX_LAYER.SPARK,
    x + Math.cos(a) * 0.28,
    y + Math.sin(a) * 0.28,
    z,
    rndSym() * 0.5,
    rndSym() * 0.5,
    rndSym() * 0.5,
    rndIn(0.18, 0.34),
    rndIn(0.035, 0.07),
    0.012,
    0.42,
    0.95,
    1,
    0.08,
    0.42,
    0.62,
    0.65,
    2.4,
    0,
    0,
    0,
    2.5,
    VFX_FLAG.ALIGN,
    y - 20,
  );
}

export type ImpactMaterial = "metal" | "sand" | "stone" | "energy";

/**
 * Point-of-impact burst. `nx/ny/nz` is the surface normal (or just the reversed
 * projectile direction) — sparks spray along the reflection, not radially,
 * which is the difference between a hit and a firework.
 */
export function vfxImpactBurst(
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  material: ImpactMaterial,
  energy: number,
  groundY: number,
  seed: number,
): void {
  rngSeed(seed);
  const e = Math.max(0.15, Math.min(1.6, energy));
  const nl = Math.hypot(nx, ny, nz) || 1;
  const ux = nx / nl;
  const uy = ny / nl;
  const uz = nz / nl;

  if (material === "metal" || material === "stone") {
    const n = Math.round((material === "metal" ? 9 : 6) * (0.5 + e));
    for (let i = 0; i < n; i++) {
      const sp = rndIn(5, 17) * (0.5 + e * 0.7);
      const sx = ux + rndSym() * 0.75;
      const sy = uy + rndIn(0.05, 0.9);
      const sz = uz + rndSym() * 0.75;
      emit(
        VFX_LAYER.SPARK,
        x,
        y,
        z,
        sx * sp,
        sy * sp,
        sz * sp,
        rndIn(0.2, 0.75),
        rndIn(0.035, 0.075),
        0.015,
        1,
        rndIn(0.85, 0.98),
        material === "metal" ? rndIn(0.6, 0.85) : rndIn(0.4, 0.6),
        0.8,
        rndIn(0.12, 0.26),
        0.04,
        rndIn(0.65, 0.9),
        rndIn(0.4, 0.9),
        -17,
        0,
        0,
        rndIn(3, 6),
        VFX_FLAG.BOUNCE | VFX_FLAG.ALIGN,
        groundY,
      );
    }
    // A short hot flash at the contact point sells the energy transfer.
    emit(
      VFX_LAYER.FIRE,
      x,
      y,
      z,
      0,
      0.5,
      0,
      rndIn(0.04, 0.08),
      rndIn(0.2, 0.4) * (0.6 + e),
      rndIn(0.5, 0.85) * (0.6 + e),
      1,
      0.94,
      0.78,
      1,
      0.5,
      0.16,
      0.75,
      5,
      0,
      0,
      rndSym() * 3,
      0,
      0,
      groundY,
    );
    // Fine grey particulate — paint and scale coming off, not smoke.
    for (let i = 0; i < 3; i++) {
      emit(
        VFX_LAYER.SMOKE,
        x,
        y,
        z,
        ux * rndIn(1, 3) + rndSym() * 1.5,
        rndIn(0.4, 1.6),
        uz * rndIn(1, 3) + rndSym() * 1.5,
        rndIn(0.35, 0.8),
        rndIn(0.08, 0.16),
        rndIn(0.35, 0.7),
        0.36,
        0.34,
        0.32,
        0.55,
        0.53,
        0.5,
        rndIn(0.16, 0.3),
        2.6,
        0.3,
        0.4,
        rndSym() * 1.5,
        0,
        0,
        groundY,
      );
    }
    return;
  }

  if (material === "sand") {
    const n = Math.round(8 * (0.5 + e));
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU;
      const sp = rndIn(2.5, 8) * (0.5 + e * 0.6);
      emit(
        VFX_LAYER.SMOKE,
        x + Math.cos(a) * 0.2,
        y,
        z + Math.sin(a) * 0.2,
        Math.cos(a) * sp + ux * 2,
        rndIn(1.2, 4.5),
        Math.sin(a) * sp + uz * 2,
        rndIn(0.7, 1.8),
        rndIn(0.16, 0.34),
        rndIn(0.8, 1.7),
        0.8,
        0.68,
        0.48,
        0.62,
        0.55,
        0.44,
        rndIn(0.3, 0.5),
        rndIn(1.6, 2.6),
        -1.2,
        rndIn(0.2, 0.5),
        rndSym() * 1.2,
        0,
        VFX_FLAG.GROUND,
        groundY,
      );
    }
    return;
  }

  // energy — a cold implosion ring of arcs, no debris at all.
  vfxElectricArc(x, y, z, 1.1 + e * 0.6, seed ^ 0x77c1);
  emit(
    VFX_LAYER.FIRE,
    x,
    y,
    z,
    0,
    0,
    0,
    rndIn(0.08, 0.14),
    rndIn(0.35, 0.6) * (0.6 + e),
    rndIn(1.0, 1.5) * (0.6 + e),
    0.55,
    0.95,
    1,
    0.08,
    0.4,
    0.6,
    0.8,
    5,
    0,
    0,
    rndSym() * 4,
    0,
    0,
    groundY,
  );
}

/**
 * Tyre smoke under load.
 *
 * Deliberately NOT the same particle as off-road dust with a different tint.
 * Burnt rubber is a bluish-white, it is *dense* at birth and thins out fast, it
 * barely rises (hot but light, and the car's wake keeps knocking it down), and
 * it hangs around after the car has gone. Desert dust is ochre, coarse, thrown
 * hard, and settles. Those are the two behaviours that were previously one.
 */
export function vfxTyreSmoke(
  x: number,
  y: number,
  z: number,
  vx: number,
  vz: number,
  load: number,
  groundY: number,
  seed: number,
): void {
  rngSeed(seed);
  const l = Math.max(0, Math.min(1, load));
  emit(
    VFX_LAYER.SMOKE,
    x + rndSym() * 0.22,
    y + rndIn(0.03, 0.2),
    z + rndSym() * 0.22,
    -vx * rndIn(0.06, 0.16) + rndSym() * 0.9,
    rndIn(0.35, 1.1),
    -vz * rndIn(0.06, 0.16) + rndSym() * 0.9,
    rndIn(1.1, 2.1) + l * 0.7,
    rndIn(0.14, 0.26),
    rndIn(1.2, 2.3) + l * 0.8,
    // Fresh rubber smoke is close to white with a cold cast.
    rndIn(0.74, 0.84),
    rndIn(0.75, 0.85),
    rndIn(0.78, 0.88),
    0.5,
    0.49,
    0.5,
    (0.2 + l * 0.34) * rndIn(0.8, 1.2),
    rndIn(1.9, 2.8),
    0.25,
    rndIn(0.35, 0.7),
    rndSym() * 0.9,
    0,
    VFX_FLAG.GROUND,
    groundY,
  );
}

/** Off-road dust — coarse, ochre, thrown hard, settles. */
export function vfxOffroadDust(
  x: number,
  y: number,
  z: number,
  vx: number,
  vz: number,
  amount: number,
  groundY: number,
  seed: number,
): void {
  rngSeed(seed);
  const a = Math.max(0, Math.min(1, amount));
  emit(
    VFX_LAYER.SMOKE,
    x + rndSym() * 0.45,
    groundY + rndIn(0.05, 0.35),
    z + rndSym() * 0.45,
    -vx * rndIn(0.1, 0.26) + rndSym() * 2.2,
    rndIn(0.8, 2.8) * (0.5 + a),
    -vz * rndIn(0.1, 0.26) + rndSym() * 2.2,
    rndIn(0.9, 1.9),
    rndIn(0.25, 0.5),
    rndIn(1.6, 3.2),
    rndIn(0.76, 0.88),
    rndIn(0.63, 0.72),
    rndIn(0.42, 0.52),
    0.58,
    0.5,
    0.38,
    (0.18 + a * 0.3) * rndIn(0.8, 1.25),
    rndIn(1.2, 2),
    -0.9,
    rndIn(0.25, 0.6),
    rndSym() * 1.1,
    0,
    VFX_FLAG.GROUND,
    groundY,
  );
}

/**
 * One puff of a sustained damage column. Call repeatedly at a rate; the drift
 * and dissipation come from the wind coupling and the 3.5x growth, not from
 * the emitter.
 */
export function vfxSmokeColumn(
  x: number,
  y: number,
  z: number,
  severity: number,
  seed: number,
): void {
  rngSeed(seed);
  const s = Math.max(0, Math.min(1, severity));
  // Darker AND longer-lived the worse the damage — a lightly-scraped car
  // should wisp, a nearly-dead one should trail a black column you can see
  // from the far side of the lap.
  const dark = 0.34 - s * 0.26;
  emit(
    VFX_LAYER.SMOKE,
    x + rndSym() * 0.3,
    y + rndIn(0, 0.35),
    z + rndSym() * 0.3,
    rndSym() * 1.1,
    rndIn(1.1, 2.6) + s * 1.2,
    rndSym() * 1.1,
    rndIn(1.6, 3.2) + s * 2.4,
    rndIn(0.18, 0.35),
    rndIn(1.3, 2.6) + s * 1.4,
    dark * rndIn(0.85, 1.2),
    dark * rndIn(0.82, 1.14),
    dark * rndIn(0.78, 1.08),
    rndIn(0.4, 0.55),
    rndIn(0.38, 0.52),
    rndIn(0.36, 0.5),
    (0.2 + s * 0.32) * rndIn(0.85, 1.15),
    rndIn(0.7, 1.2),
    1.35,
    rndIn(0.7, 1.2),
    rndSym() * 0.8,
    0,
    0,
    y - 40,
  );
  // Engine fire once the damage is genuinely severe.
  if (s > 0.72 && rndChance(0.25)) {
    emit(
      VFX_LAYER.FIRE,
      x + rndSym() * 0.25,
      y,
      z + rndSym() * 0.25,
      rndSym() * 0.6,
      rndIn(1.5, 3),
      rndSym() * 0.6,
      rndIn(0.18, 0.34),
      rndIn(0.16, 0.3),
      rndIn(0.35, 0.6),
      1,
      0.82,
      0.42,
      0.7,
      0.16,
      0.03,
      rndIn(0.5, 0.75),
      2.2,
      1,
      0.5,
      rndSym() * 2,
      0,
      0,
      y - 40,
    );
  }
}

/** Electrical arcing on damaged systems. Short, bright, jagged, cold. */
export function vfxElectricArc(
  x: number,
  y: number,
  z: number,
  radius: number,
  seed: number,
): void {
  rngSeed(seed);
  const n = 2 + rndInt(3);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU;
    const el = rndSym();
    emit(
      VFX_LAYER.ARC,
      x + Math.cos(a) * radius * rndIn(0.1, 0.8),
      y + el * radius * 0.5,
      z + Math.sin(a) * radius * rndIn(0.1, 0.8),
      // A little velocity so the bolt is never twice in the same place, but
      // not enough to read as a projectile.
      Math.cos(a) * rndIn(0.5, 2.5),
      rndSym() * 1.5,
      Math.sin(a) * rndIn(0.5, 2.5),
      rndIn(0.04, 0.13),
      radius * rndIn(0.45, 1.1),
      radius * rndIn(0.5, 1.2),
      0.78,
      0.9,
      1,
      0.42,
      0.5,
      0.95,
      rndIn(0.55, 0.95),
      1,
      0,
      0,
      rndSym() * 12,
      0,
      0,
      y - 40,
    );
  }
  if (rndChance(0.6)) {
    emit(
      VFX_LAYER.SPARK,
      x,
      y,
      z,
      rndSym() * 4,
      rndIn(0.5, 3),
      rndSym() * 4,
      rndIn(0.15, 0.4),
      rndIn(0.03, 0.06),
      0.012,
      0.75,
      0.9,
      1,
      0.35,
      0.45,
      0.9,
      0.7,
      1.2,
      -11,
      0,
      0,
      3,
      VFX_FLAG.ALIGN,
      y - 40,
    );
  }
}

/** Oil / coolant spray from a ruptured system. Stains where it lands. */
export function vfxFluidSpray(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  fluid: "oil" | "coolant",
  groundY: number,
  seed: number,
): void {
  rngSeed(seed);
  const oil = fluid === "oil";
  const n = 2 + rndInt(3);
  for (let i = 0; i < n; i++) {
    emit(
      VFX_LAYER.FLUID,
      x + rndSym() * 0.12,
      y + rndSym() * 0.12,
      z + rndSym() * 0.12,
      vx + rndSym() * 2.4,
      vy + rndIn(0.5, 3),
      vz + rndSym() * 2.4,
      rndIn(0.5, 1.4),
      rndIn(0.035, 0.085),
      rndIn(0.03, 0.07),
      oil ? 0.1 : 0.72,
      oil ? 0.085 : 0.92,
      oil ? 0.07 : 0.88,
      oil ? 0.05 : 0.55,
      oil ? 0.04 : 0.72,
      oil ? 0.035 : 0.7,
      oil ? 0.9 : 0.55,
      0.35,
      -15,
      0,
      0,
      2.2,
      VFX_FLAG.BOUNCE | VFX_FLAG.ALIGN | (oil ? VFX_FLAG.STAIN : 0),
      groundY,
    );
  }
  if (!oil) {
    // Coolant flashes to steam the moment it hits hot metal.
    emit(
      VFX_LAYER.SMOKE,
      x,
      y,
      z,
      rndSym() * 0.8,
      rndIn(1.5, 3.5),
      rndSym() * 0.8,
      rndIn(0.5, 1.1),
      rndIn(0.1, 0.2),
      rndIn(0.6, 1.2),
      0.92,
      0.94,
      0.95,
      0.7,
      0.72,
      0.74,
      rndIn(0.2, 0.36),
      2.2,
      1.8,
      0.6,
      rndSym() * 1,
      0,
      0,
      groundY,
    );
  }
}

/** A directed shower of bouncing sparks — body scrape, wall grind, wheel lock. */
export function vfxSparkShower(
  x: number,
  y: number,
  z: number,
  dirX: number,
  dirZ: number,
  energy: number,
  groundY: number,
  seed: number,
): void {
  rngSeed(seed);
  const e = Math.max(0.1, Math.min(1.4, energy));
  const n = 2 + rndInt(Math.round(3 + e * 5));
  for (let i = 0; i < n; i++) {
    const sp = rndIn(4, 14) * (0.5 + e * 0.7);
    emit(
      VFX_LAYER.SPARK,
      x + rndSym() * 0.2,
      y,
      z + rndSym() * 0.2,
      (dirX + rndSym() * 0.8) * sp,
      rndIn(0.5, 4),
      (dirZ + rndSym() * 0.8) * sp,
      rndIn(0.25, 0.9),
      rndIn(0.03, 0.07),
      0.012,
      1,
      rndIn(0.82, 0.96),
      rndIn(0.5, 0.75),
      0.72,
      rndIn(0.1, 0.22),
      0.03,
      rndIn(0.6, 0.9),
      rndIn(0.4, 0.9),
      -18,
      0,
      0,
      rndIn(3, 6),
      VFX_FLAG.BOUNCE | VFX_FLAG.ALIGN,
      groundY,
    );
  }
}

/**
 * One tick of a boost plume. `fx/fz` is the car's forward unit vector.
 *
 * The plume is given a fraction of the car's own speed and no more, so it is
 * continuously left behind — which is the only reason a boost reads as thrust.
 * Emitting it at the car's full velocity welds it to the bumper and looks like
 * a decal; emitting it at zero makes it a stationary puff the car drives out of.
 */
export function vfxBoostJet(
  x: number,
  y: number,
  z: number,
  fx: number,
  fz: number,
  speed: number,
  seed: number,
): void {
  rngSeed(seed);
  const carry = speed * rndIn(0.42, 0.66);
  emit(
    VFX_LAYER.FIRE,
    x + rndSym() * 0.14,
    y + rndSym() * 0.1,
    z + rndSym() * 0.14,
    fx * carry - fx * rndIn(5, 11) + rndSym() * 1.2,
    rndIn(-0.3, 0.9),
    fz * carry - fz * rndIn(5, 11) + rndSym() * 1.2,
    rndIn(0.09, 0.2),
    rndIn(0.16, 0.3),
    rndIn(0.42, 0.78),
    // Cold plasma at the nozzle warming to white as it expands, not an orange
    // flame: this is the same afterburner cyan the HUD and boost UI use.
    0.44,
    rndIn(0.88, 1),
    1,
    0.16,
    0.42,
    0.72,
    rndIn(0.45, 0.75),
    rndIn(3.5, 5.5),
    0.4,
    0,
    rndSym() * 4,
    0,
    0,
    y - 40,
  );
  if (rndChance(0.3)) {
    emit(
      VFX_LAYER.SPARK,
      x,
      y,
      z,
      fx * carry - fx * rndIn(8, 16) + rndSym() * 2,
      rndIn(0, 1.5),
      fz * carry - fz * rndIn(8, 16) + rndSym() * 2,
      rndIn(0.1, 0.28),
      rndIn(0.025, 0.05),
      0.01,
      0.6,
      0.95,
      1,
      0.2,
      0.5,
      0.7,
      0.6,
      1.6,
      -4,
      0,
      0,
      3,
      VFX_FLAG.ALIGN,
      y - 40,
    );
  }
}

/** Heat haze over a hot volume. See sprites.ts for why this is an approximation. */
export function vfxHeatShimmer(
  x: number,
  y: number,
  z: number,
  radius: number,
  life: number,
  seed: number,
): void {
  rngSeed(seed);
  emit(
    VFX_LAYER.SHIMMER,
    x,
    y + radius * 0.35,
    z,
    rndSym() * 0.3,
    rndIn(0.6, 1.6),
    rndSym() * 0.3,
    life * rndIn(0.8, 1.25),
    radius * rndIn(0.9, 1.3),
    radius * rndIn(1.8, 2.6),
    1,
    1,
    1,
    1,
    1,
    1,
    rndIn(0.05, 0.11),
    0.6,
    0.5,
    0.9,
    rndSym() * 0.5,
    0,
    0,
    y - 40,
  );
}
