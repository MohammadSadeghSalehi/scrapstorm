/**
 * The car carrier — a ramp the ground query actually returns, not a trigger.
 *
 * ── why this is a height field and not a collider ─────────────────────
 *
 * Everything solid in this game is a capsule in XZ resolved by
 * `deflectOffStatic`, which cancels the velocity component INTO the surface and
 * keeps the tangential one. That is exactly right for a post and exactly wrong
 * for a ramp: a ramp is not something you glance off, it is something the wheels
 * follow. There is no "up" in a capsule, so a car meeting one at 40 m/s scrapes
 * along its side no matter how the artist drew it.
 *
 * The one thing in the engine that already lifts a car is the GROUND. `physics.
 * integratePos` does `targetY = getGroundHeight(x, z) + 0.55` every fixed step,
 * and `track.applyJumpLift` uses precisely that to make a jump zone: raise the
 * road samples and the car goes up because the ground went up. A prop cannot
 * raise the road samples — the sample array is the racing line, the checkpoint
 * spacing and the grid — so instead this module supplies an OVERLAY that
 * `getGroundHeight` takes the max of. Drive onto the footprint and the ground
 * under you is the deck; drive off the lip and it is the desert again, four
 * metres below.
 *
 * No teleport, no impulse, no trigger volume. The launch is whatever the
 * integrator does with a surface that stopped existing.
 *
 * ── the deck profile, and why it is a parabola ────────────────────────
 *
 *     h(u) = height * (u / length)^2
 *
 * A straight incline has a lip at the mouth: the grade jumps from 0 to its full
 * value between two adjacent ground samples, which is the same 1.8m-step defect
 * `applyJumpLift` was rewritten to remove, only sideways. The parabola's
 * derivative is zero where it meets the road, so the mouth is a smooth pickup —
 * and its derivative is MAXIMUM at the lip, which is the one place a launch ramp
 * wants its steepest angle. Mean grade is height/length; exit grade is twice
 * that. Both are reported by scripts/probe-setpieces.mjs rather than asserted
 * here, because the number that matters is the one the integrator produces.
 *
 * ── why the sides need colliders and the deck must not have any ───────
 *
 * `getGroundHeight` is sampled at the car's CENTRE. The deck edge is therefore a
 * cliff in the height field: a car whose centre crosses it from outside would be
 * teleported four metres up by the `v.y < targetY - 0.02` snap in integratePos.
 * So the below-deck body of the trailer is a wall — but a wall that must not
 * exist for a car already ON the deck, which is directly above it in XZ.
 *
 * Hence `yTop` on StaticCollider: the trailer flank is solid up to deck height
 * and transparent above it. A car at y = 0.55 is stopped by the side of a truck;
 * a car at y = deck + 0.55 drives over the top of the same capsule. That is one
 * optional field and one guard in the solver, and it is the only honest way to
 * have a drivable roof in a collision system with no vertical axis.
 *
 * Nothing is emitted where the deck is under ~0.8m — near the mouth the "wall"
 * is a kerb, and walling the mouth off would close the ramp.
 *
 * ── renderer-free, and pushed rather than pulled ──────────────────────
 *
 * `track.ts` imports this (getGroundHeight consults it), so this module must not
 * import `track.ts` back: real ESM tolerates the cycle and jiti's CJS transpile
 * does not reliably (AGENTS.md §4). Same one-way contract `terrainProfiles.ts`
 * has — `track.rebuild()` PUSHES the resolved world frame in, everything
 * downstream pulls. It also means no `three` here, so the sim stays headless.
 */
import type { TrackSample } from "../types";
import type { AnyTrackId } from "../track";

/**
 * Where a circuit's carrier is parked, in track-relative terms.
 *
 * Arc length rather than a sample index on purpose: `TARGET_SAMPLE_SPACING`
 * decides how many samples a circuit has, so an index is a number that silently
 * means somewhere else the moment that constant moves. Metres from the start
 * line survive a resample.
 */
export type CarrierSite = {
  /** Metres along the centreline from sample 0 to the RAMP MOUTH. */
  s: number;
  /**
   * Metres right of the centreline for the deck's centre line, in the sample's
   * own frame (+ is the `cos(yaw), -sin(yaw)` side).
   *
   * Never zero, and never small. See the site table below for the three
   * measurements that set it: a carrier near the racing line is one the AI
   * field spends its pace difference on, and the AI has no idea it is there.
   *
   * Must also keep the whole footprint inside `half + 2.5` of the centreline,
   * because that is the dead-flat corridor in `duneProfile`. Outside it the berm
   * starts rolling and the mouth would meet the ground at a step.
   */
  lateral: number;
  /** Deck run from mouth to launch lip, metres. */
  length: number;
  /** Lip height above the road plane, metres. */
  height: number;
  /** Deck half width. A car is 1.8-2.4m across; this is the margin for error. */
  halfW: number;
};

/**
 * Carriers, per circuit. ONE, and the count is a measured result.
 *
 * THE SABLE MILE, opening straight, 126m in. It is the only place in the
 * catalogue with 300m of dead-flat run-out in front of a ramp, and the run-out
 * is the design: at 42 m/s the launch flies 134m, which lands in a corner on
 * five of the six circuits. It is also the circuit whose stated complaint is
 * that nothing happens — a mile and a half of fourth-gear geometry — and a
 * transporter is the one event that does not need a corner to be one.
 *
 * `lateral: 15.0` is off the racing line on purpose, and the number is measured
 * rather than chosen: the road half-width here is 15.5m, so the deck straddles
 * the tarmac edge with its inner flank 10.65m off the centreline, its outer
 * flank inside the guard rail at half + 6.5, and the whole footprint inside
 * `half + 2.5` — the dead-flat corridor in `duneProfile` — so the ramp mouth
 * meets the road at grade rather than on a berm. A carrier ON the line is one
 * every AI drives over, and the AI has no idea it is there.
 *
 * ── ASH SPIRE WAS TRIED AND BACKED OUT. Do not re-add it without numbers. ──
 *
 * The scrapyard hazard section (s = 432) is the obvious home for a dumped
 * transporter and the circuit's own description invites it. Three offsets, all
 * measured with mission-smoke:
 *
 *   lateral 7.4   the pace-field probe (three identically profiled bots, 55s,
 *                 distance covered) collapsed from a >3% spread between a slow
 *                 field and a fast one to 1.4% — both fields were spending the
 *                 difference on the same truck.
 *   lateral 11.0  spread recovered, but the ladder's first rungs fell to a 19%
 *                 clear rate for a merely competent driver.
 *   lateral 14.5  spread collapsed again, to 0.0%.
 *
 * Ash Spire is a 908m loop whose straightest 50m still turns 0.22 rad; there is
 * no offset on it that is both reachable by the player and far enough from the
 * line to leave the field alone. Removing it returned mission-smoke to 840/840
 * with the Sable Mile rig still in.
 *
 * The remaining four were never candidates. The Foundry Pit is a brawl loop
 * with 20m chokes and no landing room, Rustline is 18-22m wide with a mesa
 * either side, the Dead Mile spends its elevation on a real climb, and Cinder
 * Bowl's kidney never gives you 80m of straight after anything.
 */
const CARRIER_SITES: Partial<Record<AnyTrackId, CarrierSite>> = {
  sable_run: { s: 126, lateral: 15.0, length: 27, height: 4.2, halfW: 3.8 },
};

/** The tractor unit, as multiples that hold for any deck size. */
const CAB = {
  /** Metres of cab beyond the lip. The deck overhangs it, as a real one does. */
  length: 6.2,
  /** Roof height. Must stay under the lip or the launch clips its own truck. */
  height: 3.1,
  halfW: 1.55,
};

/** Below this deck height the flank is a kerb, not a wall. See the header. */
const WALL_FROM_HEIGHT = 0.8;

export type CarrierRig = {
  readonly id: string;
  /** Ramp mouth centre, on the road plane. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit heading the deck climbs along (the direction of travel). */
  readonly fx: number;
  readonly fz: number;
  /** Unit right of `f`, so local (u, t) -> world is one multiply-add. */
  readonly rx: number;
  readonly rz: number;
  readonly length: number;
  readonly height: number;
  readonly halfW: number;
  readonly cabLength: number;
  readonly cabHeight: number;
  readonly cabHalfW: number;
  /** XZ bounds of deck + cab, inflated. The reject test for the ground query. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
};

let rigs: CarrierRig[] = [];

/**
 * Deck height above the road plane at a fraction of the run.
 *
 * Exported so the RENDERER builds its deck from this function rather than from
 * a second copy of the curve. The visible ramp and the ramp physics reports are
 * the same surface by construction — the alternative is the class of bug that
 * put the terrain mesh and `getGroundHeight` several metres apart.
 */
export function carrierDeckProfile(u01: number): number {
  const u = u01 < 0 ? 0 : u01 > 1 ? 1 : u01;
  return u * u;
}

/**
 * Resolve the active circuit's carriers into world frames.
 *
 * Called by `track.rebuild()` with the freshly built samples, BEFORE anything
 * settles onto the ground — same ordering contract as `setActiveTerrainProfile`,
 * and for the same reason: `getGroundHeight` consults this, and scenery settles
 * through `getGroundHeight`.
 */
export function setActiveCarriers(id: AnyTrackId, samples: TrackSample[]): void {
  rigs = [];
  const site = CARRIER_SITES[id];
  if (!site || samples.length < 4) return;

  // Nearest sample by arc length. The array is monotonic in `s`, but a linear
  // scan over a few hundred entries once per circuit build is not worth a
  // binary search that could disagree with a wrapped last segment.
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.abs(samples[i]!.s - site.s);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const sm = samples[best]!;
  // Forward is the direction of travel; `yaw` is authored as atan2(-dx, -dz).
  const fx = -Math.sin(sm.yaw);
  const fz = -Math.cos(sm.yaw);
  const rx = Math.cos(sm.yaw);
  const rz = -Math.sin(sm.yaw);

  const x = sm.x + rx * site.lateral;
  const z = sm.z + rz * site.lateral;

  const reach = site.length + CAB.length;
  const wide = Math.max(site.halfW, CAB.halfW) + 1.5;
  const ex = Math.abs(fx) * reach + Math.abs(rx) * wide;
  const ez = Math.abs(fz) * reach + Math.abs(rz) * wide;
  // The mouth is the origin, so the box runs forward from it, never back.
  const cx = x + fx * reach * 0.5;
  const cz = z + fz * reach * 0.5;

  rigs.push({
    id: `${id}-carrier`,
    x,
    y: sm.y,
    z,
    fx,
    fz,
    rx,
    rz,
    length: site.length,
    height: site.height,
    halfW: site.halfW,
    cabLength: CAB.length,
    cabHeight: CAB.height,
    cabHalfW: CAB.halfW,
    minX: cx - ex,
    maxX: cx + ex,
    minZ: cz - ez,
    maxZ: cz + ez,
  });
}

export function getCarriers(): readonly CarrierRig[] {
  return rigs;
}

/**
 * Deck height at a world point, or `-Infinity` where there is no deck.
 *
 * `-Infinity` rather than a nullable so the caller is a single `max` on the hot
 * path: `getGroundHeight` runs four times per vehicle per fixed step plus every
 * projectile, crater and settle query in the game, and a branch that allocates
 * or that the JIT has to type-check is not free at that rate.
 *
 * The AABB reject is first and is the only thing 99.9% of queries execute.
 */
export function carrierSurfaceAt(x: number, z: number): number {
  for (let i = 0; i < rigs.length; i++) {
    const c = rigs[i]!;
    if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
    const dx = x - c.x;
    const dz = z - c.z;
    const t = dx * c.rx + dz * c.rz;
    if (t < -c.halfW || t > c.halfW) continue;
    const u = dx * c.fx + dz * c.fz;
    if (u < 0 || u > c.length) continue;
    return c.y + c.height * carrierDeckProfile(u / c.length);
  }
  return -Infinity;
}

/**
 * Is this point under (or beside) a parked carrier?
 *
 * For prop placement, not for physics. A rig parked half on the apron sits over
 * the verge markers, and a 1.1m stick standing inside the trailer is a stick
 * you break for a few m/s every time you use the ramp — measured at 1.0-2.3 m/s
 * per run before this existed. A truck that has been dumped here has already
 * flattened them.
 *
 * Inflated by `pad` so nothing is left half under the chassis.
 */
export function carrierBlocks(x: number, z: number, pad = 1.5): boolean {
  for (let i = 0; i < rigs.length; i++) {
    const c = rigs[i]!;
    if (
      x < c.minX - pad ||
      x > c.maxX + pad ||
      z < c.minZ - pad ||
      z > c.maxZ + pad
    ) {
      continue;
    }
    const dx = x - c.x;
    const dz = z - c.z;
    const t = dx * c.rx + dz * c.rz;
    const u = dx * c.fx + dz * c.fz;
    const halfW = Math.max(c.halfW, c.cabHalfW) + pad;
    if (t < -halfW || t > halfW) continue;
    if (u < -pad || u > c.length + c.cabLength + pad) continue;
    return true;
  }
  return false;
}

/**
 * The trailer flanks, the lip end-cap and the cab, as capsule descriptions.
 *
 * Returned as plain data rather than as `StaticCollider`s so this module does
 * not have to import the registry that imports it. `setpieceColliders.ts` maps
 * them one for one.
 *
 * `yTop` is the height ABOVE WHICH the capsule is not solid — see the header.
 * The flanks use the local deck height so the wall matches the ramp it is
 * holding up; the cab uses its roof, so a car launching off a deck that is
 * higher than the cab passes straight over it.
 */
export type CarrierCapsule = {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  r: number;
  /** Solid for a car whose y is at or below this. */
  yTop: number;
  /** Ground height, for the debris burst the registry never spawns here. */
  y: number;
};

/** Flank capsule radius. Half the 1.0m depth of the trailer's side beam. */
const FLANK_R = 0.5;

export function carrierCapsules(): CarrierCapsule[] {
  const out: CarrierCapsule[] = [];
  for (const c of rigs) {
    /*
     * Where the deck first stands high enough to be a wall.
     *
     * h(u) = H (u/L)^2, so h = WALL_FROM_HEIGHT at u = L * sqrt(W/H). Solving it
     * rather than stepping u avoids a wall that starts at a slightly different
     * place than the height field says it should.
     */
    const u0 =
      c.height <= WALL_FROM_HEIGHT
        ? 0
        : c.length * Math.sqrt(WALL_FROM_HEIGHT / c.height);
    if (u0 < c.length - 0.5) {
      /*
       * Four segments, not one.
       *
       * A capsule has ONE `yTop`, and the deck it is holding up climbs from 0.8m
       * to 3.9m over its span. One capsule would have to pick a single height:
       * too low and a car on the low end of the deck falls through the wall's
       * shadow, too high and a car on the high end is stopped by its own deck.
       * Four gives a worst-case error of a quarter of the climb, which is under
       * the 0.55m ride height the test has to resolve.
       */
      const SEG = 4;
      for (let k = 0; k < SEG; k++) {
        const ua = u0 + ((c.length - u0) * k) / SEG;
        const ub = u0 + ((c.length - u0) * (k + 1)) / SEG;
        // The LOW end's deck height. A wall must never be transparent to a car
        // that is actually below it, so err short.
        const yTop = c.y + c.height * carrierDeckProfile(ua / c.length) + 0.25;
        for (const side of [-1, 1] as const) {
          const off = (c.halfW + FLANK_R * 0.5) * side;
          out.push({
            x0: c.x + c.fx * ua + c.rx * off,
            z0: c.z + c.fz * ua + c.rz * off,
            x1: c.x + c.fx * ub + c.rx * off,
            z1: c.z + c.fz * ub + c.rz * off,
            r: FLANK_R,
            yTop,
            y: c.y,
          });
        }
      }
    }

    /*
     * The lip end-cap: the tall face a car arriving from the LANDING side would
     * otherwise drive into the inside of.
     *
     * Its ceiling is a CAR at road level, not the lip. Measured: with `yTop` set
     * to the lip height the cap was solid to a car still climbing its own ramp —
     * at 2m short of the lip the deck is only 3.2m, the car is at 3.75m, and
     * 3.75 < 4.15 so the ramp ended in a wall. Every run stopped dead there and
     * then fired vertically off the stale climb velocity. Nothing within reach of
     * this capsule is ever below 3.9m unless it is on the ground in front of the
     * truck, which is exactly and only what the cap is for.
     */
    const lipTop = c.y + 1.8;
    out.push({
      x0: c.x + c.fx * c.length - c.rx * c.halfW,
      z0: c.z + c.fz * c.length - c.rz * c.halfW,
      x1: c.x + c.fx * c.length + c.rx * c.halfW,
      z1: c.z + c.fz * c.length + c.rz * c.halfW,
      r: 0.45,
      yTop: lipTop,
      y: c.y,
    });

    /*
     * The tractor unit, under the overhanging front of the deck. Its roof is
     * below the lip by design, so the flight path clears it and only a car still
     * on the ground can hit it.
     */
    const cabMid = c.length + c.cabLength * 0.5;
    out.push({
      x0: c.x + c.fx * (cabMid - c.cabLength * 0.28),
      z0: c.z + c.fz * (cabMid - c.cabLength * 0.28),
      x1: c.x + c.fx * (cabMid + c.cabLength * 0.28),
      z1: c.z + c.fz * (cabMid + c.cabLength * 0.28),
      r: c.cabHalfW,
      yTop: c.y + c.cabHeight,
      y: c.y,
    });
  }
  return out;
}
