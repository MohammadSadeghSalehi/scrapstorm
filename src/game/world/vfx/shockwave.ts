/**
 * Blast shockwaves — expanding ground rings.
 *
 * Separate from the particle pool because a shockwave is not a billboard: it is
 * a flat, world-oriented annulus whose radius is the whole animation, and it
 * needs a non-uniform scale so a directional blast produces an ellipse rather
 * than a circle. Trying to express that through the billboard path would have
 * meant a per-particle orientation mode that only one effect ever used.
 *
 * COST: one InstancedMesh, one draw call, 8 slots. The ring geometry is a
 * 28-segment annulus = 56 triangles, so the whole system caps at 448 triangles
 * and is usually zero.
 */
import { rndIn, rngSeed } from "./rng";

export const SHOCKWAVE_MAX = 8;

export interface Shockwave {
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** Radius now and at end of life, metres. */
  r0: number;
  r1: number;
  /** Unit XZ direction the blast travelled — the long axis of the ellipse. */
  dirX: number;
  dirZ: number;
  /** 1 = circular, >1 = stretched along dir. */
  aniso: number;
  life: number;
  maxLife: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
}

function make(): Shockwave {
  return {
    active: false,
    x: 0,
    y: 0,
    z: 0,
    r0: 0.5,
    r1: 6,
    dirX: 1,
    dirZ: 0,
    aniso: 1,
    life: 0,
    maxLife: 1,
    r: 1,
    g: 0.9,
    b: 0.75,
    alpha: 0.6,
  };
}

const pool: Shockwave[] = Array.from({ length: SHOCKWAVE_MAX }, make);
let live = 0;

function acquire(): Shockwave {
  for (let i = 0; i < SHOCKWAVE_MAX; i++) {
    const s = pool[i]!;
    if (!s.active) {
      s.active = true;
      live += 1;
      return s;
    }
  }
  // Saturated: replace the one furthest through its life. A ring that is 90%
  // expanded is nearly invisible anyway, so it is the cheapest thing to lose.
  let worst = pool[0]!;
  for (let i = 1; i < SHOCKWAVE_MAX; i++) {
    if (pool[i]!.life < worst.life) worst = pool[i]!;
  }
  return worst;
}

/**
 * `y` must already be the real ground height at (x, z) — see getGroundHeight.
 * A ring placed at the road plane sinks into the desert the moment the blast
 * happens off the tarmac, which is where most of them happen.
 */
export function spawnShockwave(
  x: number,
  y: number,
  z: number,
  radius: number,
  dirX: number,
  dirZ: number,
  seed: number,
  tint: { r: number; g: number; b: number } = { r: 1, g: 0.88, b: 0.72 },
): void {
  rngSeed(seed);
  const s = acquire();
  const len = Math.hypot(dirX, dirZ);
  s.x = x;
  // Lifted clear of the surface: the ring is depth-tested (so cars occlude it
  // correctly) which means anything sitting exactly on the heightmap gets
  // half-eaten by the terrain's own tessellation error.
  s.y = y + 0.22;
  s.z = z;
  s.r0 = radius * rndIn(0.25, 0.4);
  s.r1 = radius * rndIn(2.6, 3.6);
  s.dirX = len > 1e-4 ? dirX / len : 1;
  s.dirZ = len > 1e-4 ? dirZ / len : 0;
  // Only a blast with real directionality gets stretched. A barrel going off
  // under a stationary car should stay round.
  s.aniso = len > 1e-4 ? rndIn(1.15, 1.55) : 1;
  s.maxLife = rndIn(0.34, 0.55);
  s.life = s.maxLife;
  s.r = tint.r;
  s.g = tint.g;
  s.b = tint.b;
  s.alpha = rndIn(0.35, 0.6);
}

export function stepShockwaves(dt: number): void {
  if (live === 0) return;
  for (let i = 0; i < SHOCKWAVE_MAX; i++) {
    const s = pool[i]!;
    if (!s.active) continue;
    s.life -= dt;
    if (s.life <= 0) {
      s.active = false;
      live -= 1;
    }
  }
}

export function shockwavePool(): readonly Shockwave[] {
  return pool;
}

export function shockwaveLive(): number {
  return live;
}

export function resetShockwaves(): void {
  for (let i = 0; i < SHOCKWAVE_MAX; i++) pool[i]!.active = false;
  live = 0;
}
