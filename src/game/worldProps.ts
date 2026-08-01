/**
 * Arcade world props: barrels, crates, scrap piles + soft track barriers.
 * Vehicles knock dynamics around; statics push cars back (circle colliders).
 * Collision uses distance early-outs for perf.
 */
import type { Particle, VehicleState } from "./types";
import { VEHICLE_HITBOX } from "./physics";
import {
  EDGE_MARKERS,
  TRACK_SAMPLES,
  SCENERY,
  getGroundHeight,
} from "./track";
import { VEHICLE_CLASSES } from "./classes";
import {
  capsuleContact,
  querySetpieceColliders,
  rebuildSetpieceColliders,
} from "./setpieceColliders";
import { downEdgeAt, resetEdgeDamage } from "./world/edgeDamage";
import {
  debrisActiveCount,
  disturbDebris,
  resetDebris,
  spawnPropDebris,
  stepDebris,
} from "./world/debris";

export type PropKind = "barrel" | "crate" | "scrap" | "barrier";

/**
 * Height of a prop's CENTRE above the ground when it is at rest — which is
 * exactly half its visual height, because every prop mesh is centred on its own
 * origin.
 *
 * This lives in one place because it was previously in two, and they disagreed.
 * The physics rested a barrel with its centre at ground + 0.48 while
 * PhysicsPropsView ALSO lifted the mesh 0.48 inside its group, so the group sat
 * at the resting centre and the mesh sat half a metre above that. Every barrel,
 * crate and scrap pile on the track floated: 0.485m, 0.415m and 0.275m clear of
 * the road respectively.
 *
 * The values are derived from the geometry in PhysicsPropsView.makePrimitive —
 * barrel is a 0.95-tall cylinder, crate a 0.85 box, scrap a 0.45 box — and
 * scrap in particular was wrong even before the double-offset, because it shared
 * the crate's 0.42 while being half the height.
 */
export const PROP_REST_OFFSET: Record<PropKind, number> = {
  barrel: 0.475,
  crate: 0.425,
  scrap: 0.225,
  // Verge posts are placed from EDGE_MARKERS with their own lift; kept here so
  // the record is total and nothing has to guess.
  barrier: 0.4,
};

export interface PhysProp {
  id: string;
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  /** vertical velocity for hop/launch */
  vy: number;
  vz: number;
  spin: number;
  /** collision radius (XZ) */
  radius: number;
  mass: number;
  dynamic: boolean;
  hp: number;
  scale: number;
  /** scrap visual damage 0..1 */
  dent: number;
  dead: boolean;
  /**
   * Can be ploughed through and destroyed above BARRIER_BREAK_SPEED.
   *
   * Only the track-edge posts. Scenery blockers (towers, cranes) are ALSO
   * `dynamic: false` with `kind: "barrier"`, so a bare `!p.dynamic` test let a
   * 9 m/s nudge delete a crane's collider and call downEdgeAt at its position.
   */
  breakable?: boolean;
  /**
   * Cached ground-relative rest height, recomputed only while the prop moves.
   *
   * Undefined until the first step. Kept on the prop rather than queried every
   * frame so a field of settled props costs nothing.
   */
  restY?: number;
}

let seq = 0;
function nid(prefix: string) {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Build props for the active track (call on grid / track change). */
export function spawnWorldProps(): PhysProp[] {
  const props: PhysProp[] = [];
  // Fresh grid — every post stands again and the road is swept.
  resetEdgeDamage();
  resetDebris();
  /*
   * Built structure gets its colliders here rather than through a hook of its
   * own, because every path that rebuilds a grid already calls this: createState,
   * setTrack, rebuildShowcase and startCountdown. A second entry point would be
   * a second thing to forget. Cached on the track epoch inside, so restarting a
   * heat on the same circuit costs a string compare.
   */
  rebuildSetpieceColliders();

  /**
   * Track samples either side of the start line kept free of obstacles. The
   * whole field launches abreast and accelerating through here, so anything
   * placed in this stretch guaranteed contact before the first corner.
   */
  const GRID_CLEAR = Math.max(8, Math.floor(TRACK_SAMPLES.length * 0.06));

  // Soft barriers from edge markers. Stride 10 rather than 5: only every Nth
  // post carries a collider anyway, and dense colliders meant clipping a
  // corner put you into something almost immediately.
  //
  // GRID_CLEAR skips the markers flanking the start line entirely. Four cars
  // launching abreast fan out across the full width, so barrier colliders
  // right there turned a normal start into an instant collision.
  /*
   * EVERY drawn post gets a collider.
   *
   * This strode by 10, on the reasoning that dense colliders meant clipping a
   * corner put you into something immediately. The result was 17 colliders
   * under 194 drawn posts — 91% of the sticks you can see were ghosts, which is
   * a far worse problem than the one the stride was avoiding: the road looked
   * lined and behaved empty, and which posts were real was invisible.
   *
   * The clipping worry is answered by the RESPONSE instead, not by leaving most
   * of them out: a 10cm stick with a 0.28m collider that snaps at 5 m/s and
   * costs a few percent is something you plough through, and doing that to
   * three in a row should still be cheaper than lifting.
   */
  for (let i = 0; i < EDGE_MARKERS.length; i += 1) {
    const markerClear = Math.max(10, Math.floor(EDGE_MARKERS.length * 0.06));
    if (i < markerClear || i > EDGE_MARKERS.length - markerClear) continue;
    const m = EDGE_MARKERS[i];
    props.push({
      id: nid("bar"),
      kind: "barrier",
      x: m.x,
      y: m.y + 0.4,
      z: m.z,
      yaw: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,
      // A verge marker is a ~10cm stick. 0.55 gave it a 1.1m-wide collider, so
      // you clipped posts you visibly missed.
      radius: 0.28,
      mass: 0.35,
      dynamic: false,
      hp: 999,
      scale: 1,
      dent: 0,
      dead: false,
      breakable: true,
    });
  }

  // Dynamic barrels / crates along track — close enough to hit while racing.
  // GRID_CLEAR keeps the launch straight empty; the whole field is bunched and
  // accelerating there, so props in that stretch guaranteed a first-corner
  // pile-up rather than a race.
  const step = Math.max(3, Math.floor(TRACK_SAMPLES.length / 26));
  for (let i = 1; i < TRACK_SAMPLES.length; i += step) {
    if (i < GRID_CLEAR || i > TRACK_SAMPLES.length - GRID_CLEAR * 0.5) continue;
    const s = TRACK_SAMPLES[i];
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const side = i % 2 === 0 ? 1 : -1;
    // On the apron lip so cars brush them at race speed
    const off = s.width * 0.42 + 0.9 + (i % 4) * 0.15;
    const kind: PropKind = i % 3 === 0 ? "crate" : i % 3 === 1 ? "barrel" : "scrap";
    const r = kind === "crate" ? 0.78 : kind === "barrel" ? 0.52 : 0.9;
    props.push({
      id: nid(kind),
      kind,
      x: s.x + rx * side * off,
      y: s.y + PROP_REST_OFFSET[kind],
      z: s.z + rz * side * off,
      yaw: s.yaw + side * 0.4,
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,
      radius: r,
      mass: kind === "crate" ? 0.030 : kind === "barrel" ? 0.020 : 0.055,
      dynamic: true,
      hp: kind === "scrap" ? 70 : 38,
      scale: kind === "scrap" ? 1.2 : 1.05,
      dent: 0,
      dead: false,
    });
  }

  // Light clutter near the grid. This was 14 rows on BOTH sides packed 2
  // samples apart — 28 extra props inside the first ~200m, on top of the
  // distribution above. That is the densest part of the track arriving exactly
  // when the whole grid is accelerating into it, so it cost both frame time
  // and a clean launch. Halved the rows and doubled the spacing, and each row
  // now populates one side only so there is always a clear line through.
  // Starts past GRID_CLEAR — at idx 5 these sat directly on the launch.
  for (let k = 0; k < 7; k++) {
    const idx = GRID_CLEAR + 4 + k * 5;
    const s = TRACK_SAMPLES[idx % TRACK_SAMPLES.length];
    if (!s) continue;
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    for (const side of [k % 2 === 0 ? -1 : 1] as const) {
      const kind: PropKind = k % 3 === 0 ? "crate" : k % 3 === 1 ? "barrel" : "scrap";
      props.push({
        id: nid(kind),
        kind,
        x: s.x + rx * side * (s.width * 0.38 + 0.85),
        y: s.y + PROP_REST_OFFSET[kind],
        z: s.z + rz * side * (s.width * 0.38 + 0.85),
        yaw: s.yaw + side * 0.2,
        vx: 0,
        vy: 0,
        vz: 0,
        spin: 0,
        radius: kind === "barrel" ? 0.52 : kind === "crate" ? 0.75 : 0.88,
        mass: kind === "barrel" ? 0.018 : kind === "crate" ? 0.028 : 0.048,
        dynamic: true,
        hp: 36,
        scale: 1.1,
        dent: 0,
        dead: false,
      });
    }
  }

  // A few props ON the racing line (dodge or smash) — also held back past the
  // grid so the opening straight is genuinely clear.
  for (let k = 0; k < 10; k++) {
    const idx = GRID_CLEAR + 12 + k * 16;
    const s = TRACK_SAMPLES[idx % TRACK_SAMPLES.length];
    if (!s) continue;
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    // Offset toward the racing line's edge, not its centre. At 0.35 x width x
    // 0.25 these sat ~2.5m off the centreline of a 26m road — directly in the
    // driving line rather than something you choose to clip.
    const side = k % 2 === 0 ? 0.62 : -0.68;
    props.push({
      id: nid("barrel"),
      kind: "barrel",
      x: s.x + rx * side * s.width * 0.5,
      y: s.y + PROP_REST_OFFSET.barrel,
      z: s.z + rz * side * s.width * 0.5,
      yaw: s.yaw,
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,
      radius: 0.55,
      mass: 0.016,
      dynamic: true,
      hp: 28,
      scale: 1.15,
      dent: 0,
      dead: false,
    });
  }

  // Yard cluster near showcase pad
  const s0 = TRACK_SAMPLES[0];
  if (s0) {
    const yard: Array<{ dx: number; dz: number; kind: PropKind }> = [
      { dx: 14, dz: -8, kind: "barrel" },
      { dx: 18, dz: -14, kind: "crate" },
      { dx: 8, dz: -20, kind: "barrel" },
      { dx: 22, dz: -6, kind: "scrap" },
      { dx: 4, dz: -12, kind: "barrel" },
      { dx: 16, dz: 6, kind: "crate" },
      { dx: 28, dz: 10, kind: "barrel" },
      { dx: -6, dz: 8, kind: "scrap" },
      { dx: 10, dz: -10, kind: "barrel" },
      { dx: 20, dz: -18, kind: "crate" },
      { dx: 12, dz: -4, kind: "barrel" },
      { dx: 6, dz: -16, kind: "crate" },
    ];
    for (const y of yard) {
      const px = s0.x + y.dx;
      const pz = s0.z + y.dz;
      props.push({
        id: nid(y.kind),
        kind: y.kind,
        x: px,
        // Was a literal 0.48 — the height of a barrel resting on a road at
        // y = 0. This cluster sits 4-28m off the start line where the berm has
        // already started to climb, so every one of them was buried or hanging.
        y: getGroundHeight(px, pz) + PROP_REST_OFFSET[y.kind],
        z: pz,
        yaw: Math.random() * Math.PI,
        vx: 0,
        vy: 0,
        vz: 0,
        spin: 0,
        radius: y.kind === "barrel" ? 0.52 : y.kind === "crate" ? 0.75 : 0.95,
        mass: y.kind === "barrel" ? 0.020 : 0.040,
        dynamic: true,
        hp: 45,
        scale: 1.1,
        dent: 0,
        dead: false,
      });
    }
  }

  // Scenery footprints as static blockers (skip tiny)
  for (const sc of SCENERY) {
    if (sc.scale < 0.7) continue;
    const r =
      sc.kind === "tower" ? 2.0 * sc.scale : sc.kind === "crane" ? 1.6 * sc.scale : 1.3 * sc.scale;
    props.push({
      id: nid("sc"),
      kind: "barrier",
      x: sc.x,
      y: sc.y + 1,
      z: sc.z,
      yaw: sc.rot,
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,
      radius: r,
      // Immovable scenery (towers, cranes). Static, so mass only matters as a
      // "never budges" marker — but keep it in the vehicle unit scale.
      mass: 40,
      dynamic: false,
      hp: 999,
      scale: sc.scale,
      dent: 0,
      dead: false,
    });
  }

  return props;
}

function worldVel(v: VehicleState) {
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const rx = Math.cos(v.yaw);
  const rz = -Math.sin(v.yaw);
  return {
    vx: fx * v.speed + rx * v.lateral,
    vz: fz * v.speed + rz * v.lateral,
  };
}

function applyWorldVel(v: VehicleState, vx: number, vz: number) {
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const rx = Math.cos(v.yaw);
  const rz = -Math.sin(v.yaw);
  v.speed = vx * fx + vz * fz;
  v.lateral = vx * rx + vz * rz;
}

function spawnPropFx(
  particles: Particle[] | null,
  x: number,
  y: number,
  z: number,
  color: string,
) {
  if (!particles || particles.length > 50) return;
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    particles.push({
      id: `pfx-${seq++}-${i}`,
      x,
      y,
      z,
      vx: Math.cos(a) * (3 + Math.random() * 6),
      vy: 3 + Math.random() * 7,
      vz: Math.sin(a) * (3 + Math.random() * 6),
      life: 0.3 + Math.random() * 0.35,
      maxLife: 0.65,
      color,
      size: 0.14 + Math.random() * 0.18,
      kind: Math.random() > 0.45 ? "debris" : "spark",
    });
  }
}

/**
 * Secondary FX per break, layered on top of the physical debris: the chunks
 * carry the weight of the hit, these sell the material it was made of.
 */
const DEATH_FX: Record<PropKind, { puffs: number; colors: readonly string[] }> = {
  barrel: { puffs: 4, colors: ["#fb923c", "#fde68a", "#fb923c", "#7c2d12"] },
  crate: { puffs: 3, colors: ["#d6c7b0", "#a1887f", "#e7d9c3"] },
  scrap: { puffs: 2, colors: ["#a8a29e", "#facc15"] },
  barrier: { puffs: 4, colors: ["#e7e5e4", "#d6d3d1", "#dc2626", "#a8a29e"] },
};

/** Barriers are spawned at markerY + 0.4, so their footprint is 0.4 below. */
const BARRIER_BASE_DROP = 0.4;

/**
 * The single exit point for a prop's death.
 *
 * Every route to `dead` — barrel rupture, crate shatter, chain blast, worn-down
 * hp, barrier ploughed through — used to just flip the flag and drop a six
 * particle puff, so the prop simply blinked out. Routing them all through here
 * means each one throws real, kind-appropriate debris exactly once.
 *
 * `dirX/dirZ` is the impactor's travel (0,0 for a directionless collapse) and
 * `energy` is roughly closing speed / 12.
 */
function destroyProp(
  p: PhysProp,
  particles: Particle[] | null,
  dirX: number,
  dirZ: number,
  energy: number,
) {
  if (p.dead) return;
  p.dead = true;
  p.hp = 0;
  const fx = DEATH_FX[p.kind];
  /**
   * Plane the chunks bounce on. Deliberately the same plane stepWorldProps
   * rests props on rather than a terrain query: debris and the props it came
   * from must agree, and taking the current y would leave chunks from a prop
   * killed mid-flight bouncing in mid-air. Inherits that plane's one flaw —
   * it is absolute, so raised track sections are approximated — but sampling
   * the dune field here would only make debris disagree with the props.
   */
  /*
   * Plane the chunks bounce on. Must agree with the plane stepWorldProps rests
   * the prop on, or debris from a prop killed mid-flight bounces in mid-air.
   * Both are now the ground query rather than an absolute height, which is what
   * the old comment here called out as this code's "one flaw" — raised sections
   * were approximated, and off the tarmac they were simply wrong.
   */
  const ground = getGroundHeight(p.x, p.z);
  const groundY = p.dynamic
    ? Math.min(p.y, ground + PROP_REST_OFFSET[p.kind])
    : Math.max(ground, p.y - BARRIER_BASE_DROP);
  spawnPropDebris(
    p.kind,
    p.x,
    p.y,
    p.z,
    dirX,
    dirZ,
    energy,
    groundY,
    Math.max(0.35, p.radius * p.scale),
  );
  const spread = p.radius * 1.4;
  for (let k = 0; k < fx.puffs; k++) {
    spawnPropFx(
      particles,
      p.x + (Math.random() - 0.5) * spread,
      p.y + 0.25 + Math.random() * 1.0,
      p.z + (Math.random() - 0.5) * spread,
      fx.colors[k % fx.colors.length]!,
    );
  }
}

/** Vehicle ↔ prop collisions (circle). Mutates both. Broadphase: skip far pairs. */
/**
 * Closing speed (m/s) below which a prop absorbs the hit instead of moving.
 * Low, so props start reacting almost as soon as you are actually rolling —
 * a barrel that ignores a 5 m/s shunt reads as welded to the ground.
 */
const PROP_NUDGE_SPEED = 1.0;
/** Closing speed at which a light prop is fully launched/airborne. */
const PROP_LAUNCH_SPEED = 8;
/** Closing speed above which a barrel ruptures rather than tumbling. */
const BARREL_RUPTURE_SPEED = 16;
/**
 * Closing speed above which a crate bursts into slats instead of being launched.
 * Deliberately above PROP_LAUNCH_SPEED so the whole momentum-proportional
 * launch band is untouched — you still punt crates around at racing pace, and
 * only a genuinely square hit takes one apart.
 */
const CRATE_SHATTER_SPEED = 19;
/**
 * Closing speed above which a barrier breaks apart instead of holding. Below
 * this it still deflects rather than stopping you — see the static branch.
 *
 * `breakable` is set on exactly one thing: the wooden marker posts lining the
 * verge. 9 m/s meant a 4-inch stick held firm up to 32 km/h and deflected the
 * car — it read as a bollard. A marker post snaps if you lean on it. 2.5 m/s is
 * walking pace, so in practice it always snaps, which is the point.
 */
const BARRIER_BREAK_SPEED = 5;
/**
 * Reference prop mass (a light barrel) that reaction is scaled against.
 *
 * Prop masses share the vehicle unit scale (classes.ts: 0.78-1.55 per car).
 * They were previously authored at 7-80, i.e. a barrel roughly TEN TIMES the
 * mass of the car hitting it — so the impulse exchange reversed the car and
 * barely moved the barrel. That is the "pushed back, nothing gets thrown, props
 * stick to you" behaviour.
 */
const PROP_REF_MASS = 0.02;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * The single place hull damage from the world is applied. Two bugs it fixes,
 * both of which were spread across seven separate `v.health = Math.max(0, ...)`
 * sites in this file:
 *
 * 1. INVULNERABILITY WAS IGNORED HERE. physics.applyDamage returns immediately
 *    while `invuln > 0`, and collideVehicles checks it before hurting either
 *    car, but nothing in this file did — so the two seconds of protection a car
 *    gets on respawn (COMBAT.wreckInvuln) stopped weapons and other cars and did
 *    nothing at all about scenery. A car respawned onto the racing line could be
 *    killed outright by the first barrel it met, and then again by the next one.
 *    The physical response still happens while invulnerable; only the damage is
 *    withheld, which is what invulnerability has always meant everywhere else.
 *
 * 2. REACHING ZERO DID NOT WRECK THE CAR. applyDamage and collideVehicles both
 *    set `alive = false` and start the wreck timer at zero health; this file
 *    only zeroed the number. A car finished off by a barrel therefore kept
 *    driving on 0 hp forever — never wrecking, never respawning, and carrying
 *    the full COMBAT.dmg*Penalty (-14% top speed, -20% acceleration) for the
 *    rest of the race. Measured on a three-lap AI heat, one car in the field was
 *    in that state at the flag in six races out of eight.
 */
function hurtVehicle(v: VehicleState, amount: number): void {
  if (amount <= 0 || !v.alive || v.wreckTimer > 0 || v.invuln > 0) return;
  v.health = Math.max(0, v.health - amount);
  v.damageVisual = Math.min(
    1,
    Math.max(v.damageVisual, 1 - v.health / v.maxHealth),
  );
  if (v.health <= 0) {
    v.alive = false;
    // Same 2.8s as applyDamage and collideVehicles. updateWrecks owns what
    // happens at the end of it.
    v.wreckTimer = 2.8;
    v.speed *= 0.35;
  }
}

/**
 * The one response an immovable object is allowed to give: DEFLECT, never
 * reverse. Read this before adding a second solid thing to the world.
 *
 * A static prop has `invSum = 1 / massV`, so the shared restitution impulse used
 * for dynamic props works out to `-(1 + e) x approach` — it flips the car's
 * velocity straight back out of the wall. That is the "it stops us dead and
 * throws us back" behaviour, and it is the reason this is a separate path
 * instead of a mass of Infinity in the generic solver.
 *
 * So: cancel only the component INTO the surface and keep the component along
 * it. You scrape past and lose speed in proportion to how square the hit was.
 * The 0.9 rather than 1.0 leaves a sliver of inward velocity, which is what
 * stops the car re-sticking to the surface on the following step.
 *
 * `nx, nz` points FROM the car TOWARD the obstacle. `velN` is the closing speed
 * along that normal, positive when approaching.
 *
 * Shared by the verge barriers, the SCENERY blockers and the set-piece
 * structures, deliberately: three copies of a rule this hard-won is three
 * chances to reintroduce the impulse.
 */
function deflectOffStatic(
  v: VehicleState,
  va: { vx: number; vz: number },
  nx: number,
  nz: number,
  pen: number,
  velN: number,
): void {
  v.x -= nx * pen;
  v.z -= nz * pen;
  v.yaw += (nx * Math.cos(v.yaw) + nz * -Math.sin(v.yaw)) * pen * 0.06;
  const closing = Math.max(0, velN);
  if (closing <= 0.4) return;
  const removeN = closing * 0.9;
  const scrub = 1 - Math.min(0.3, closing * 0.012);
  const nvx = (va.vx - nx * removeN) * scrub;
  const nvz = (va.vz - nz * removeN) * scrub;
  applyWorldVel(v, nvx, nvz);
  va.vx = nvx;
  va.vz = nvz;
  if (closing > 6) {
    v.impactFlash = Math.max(v.impactFlash, 0.22);
    v.hitStun = Math.max(v.hitStun, 0.04);
    hurtVehicle(v, closing * 0.06);
  }
}

export function collideVehiclesWithProps(
  vehicles: VehicleState[],
  props: PhysProp[],
  particles: Particle[] | null,
): number {
  let maxImpact = 0;
  const STATIC_R = 16;
  const STATIC_R2 = STATIC_R * STATIC_R;

  for (const v of vehicles) {
    if (!v.alive || v.wreckTimer > 0) continue;
    const hb = VEHICLE_HITBOX[v.classId];
    const massV = VEHICLE_CLASSES[v.classId].mass;
    const va = worldVel(v);

    // Sweep settled debris out of the car's path. Guarded on the count so a
    // clean road costs one integer compare rather than a pool scan per car.
    if (debrisActiveCount() > 0) {
      disturbDebris(v.x, v.z, va.vx, va.vz, hb.halfL + 1.2);
    }

    for (const p of props) {
      if (p.dead) continue;
      const dx = p.x - v.x;
      const dz = p.z - v.z;
      const distSq = dx * dx + dz * dz;

      if (!p.dynamic) {
        if (distSq > STATIC_R2) continue;
      } else if (distSq > 120) {
        continue;
      }

      // OBB-aware radius: expand circle by yaw-projected half-extents so
      // long cars don't clip corners through barrels.
      const c = Math.abs(Math.cos(v.yaw));
      const s = Math.abs(Math.sin(v.yaw));
      const obbR =
        Math.max(hb.halfW * c + hb.halfL * s, hb.halfW * s + hb.halfL * c) *
          0.92 +
        p.radius;
      if (distSq >= obbR * obbR || distSq < 1e-8) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const pen = obbR - dist;

      // Closing speed is needed before the positional resolve, so a barrier
      // taken hard enough can break instead of being pushed against.
      const rvx = va.vx - p.vx;
      const rvz = va.vz - p.vz;
      const velN = rvx * nx + rvz * nz;

      // Barriers were dynamic:false with hp:999 — indestructible walls lining
      // the track that simply stopped the car dead. Hit one above the break
      // speed and it becomes debris: the car ploughs through with a speed
      // penalty rather than being pinned.
      // Hit hard enough, the barrier is destroyed outright: the collider dies
      // and downEdgeAt tells CulledEdgePosts to stop drawing that post, so the
      // world stays honest. No push-back at all — being bounced backwards off
      // scenery at speed is the thing that felt worst — just a speed cost and
      // hull damage as you plough through.
      if (!p.dynamic && p.breakable && velN > BARRIER_BREAK_SPEED) {
        // Scaled against a racing-pace reference, NOT the snap threshold. With
        // the threshold at 2.5 every contact would saturate `drive` at 2.0 and
        // a gentle clip would throw the same shower as a full-speed hit.
        const drive = Math.min(2.0, velN / 14);
        downEdgeAt(p.x, p.z);
        // Slabs go where the car was going. A radial burst would read as an
        // explosion; a barrier is something you plough through.
        const carSpd = Math.hypot(va.vx, va.vz) || 1;
        destroyProp(p, particles, va.vx / carSpd, va.vz / carSpd, drive * 0.9);
        // Was 0.9 - 0.06*drive: up to 22% of your speed for one wooden post,
        // and the verge carries dozens of them. A stick this size costs you
        // almost nothing to snap — the penalty should be felt, not survived.
        // 2.5 m/s and 1.5% was so cheap the post read as scenery you passed
        // through. A snapped post should be FELT and survivable, not free.
        const keep = 0.965 - 0.025 * drive;
        applyWorldVel(v, va.vx * keep, va.vz * keep);
        va.vx *= keep;
        va.vz *= keep;
        v.hitStun = Math.max(v.hitStun, 0.015);
        v.impactFlash = Math.max(v.impactFlash, 0.12);
        hurtVehicle(v, 0.5 * drive);
        maxImpact = Math.max(maxImpact, velN);
        continue;
      }

      // Intact barrier (below break speed): deflect, never reverse. The rule and
      // the reason it is not the generic impulse are on deflectOffStatic.
      if (!p.dynamic) {
        deflectOffStatic(v, va, nx, nz, pen, velN);
        maxImpact = Math.max(maxImpact, Math.abs(velN));
        continue;
      }

      const total = massV + p.mass;
      v.x -= nx * pen * (p.mass / total) * 0.9;
      v.z -= nz * pen * (p.mass / total) * 0.9;
      p.x += nx * pen * (massV / total) * 1.2;
      p.z += nz * pen * (massV / total) * 1.2;
      // Still apply soft push when nested even if not approaching
      if (velN < -0.5 && pen < 0.05) continue;

      const restitution = p.dynamic ? 0.62 : 0.28;
      const invSum = 1 / massV + (p.dynamic ? 1 / p.mass : 0);
      const approach = Math.max(0, velN);
      const j =
        approach > 0.02
          ? (-(1 + restitution) * approach) / invSum
          : -pen * 2.8;
      // No constant floor for dynamic props: a fixed -5.5 meant a barrel was
      // launched just as hard by a crawl as by a full-speed hit. Only keep
      // enough impulse to resolve the penetration; everything above that has
      // to be earned by actual closing speed.
      const jPush = p.dynamic
        ? Math.min(-pen * 2.0, j * 1.25)
        : Math.min(-2.2, j);
      const jx = jPush * nx;
      const jz = jPush * nz;

      applyWorldVel(v, va.vx + jx / massV, va.vz + jz / massV);
      va.vx += jx / massV;
      va.vz += jz / massV;

      if (p.dynamic) {
        const closing = Math.max(0, velN);
        // Heavier props resist the same hit: an 80kg barrier barely shifts
        // where an 8kg barrel is thrown clear.
        const massRatio = PROP_REF_MASS / Math.max(0.005, p.mass);
        // 0 at a nudge, 1 once there is enough speed to fully launch.
        const speedT = clamp01(
          (closing - PROP_NUDGE_SPEED) / (PROP_LAUNCH_SPEED - PROP_NUDGE_SPEED),
        );

        const launch = 1 + speedT * 2.6 * massRatio;
        p.vx -= (jx / p.mass) * launch;
        p.vz -= (jz / p.mass) * launch;
        // Drag along with the car — more so at speed, so a slow shunt rolls
        // the prop aside instead of firing it down the track.
        const carry = 0.16 + speedT * 0.34;
        p.vx += va.vx * carry;
        p.vz += va.vz * carry;

        // Vertical only once the hit can actually lift the prop's own mass.
        // Previously every contact popped it 2.5m/s upward, so barrels took
        // flight at walking pace.
        if (speedT > 0) {
          p.vy = Math.max(p.vy, speedT * (3.0 + closing * 0.24) * massRatio);
        }
        p.spin +=
          (nx * va.vz - nz * va.vx) * (0.05 + speedT * 0.12) +
          (Math.random() - 0.5) * (0.5 + speedT * 3.0);

        const impact = closing + pen * 4;
        maxImpact = Math.max(maxImpact, impact);

        // A barrel taken at speed ruptures rather than tumbling away. A barrel
        // you have already clipped goes early — accumulated dent is visible on
        // the mesh, so the primed one is the one you can see is primed.
        const ruptureAt = BARREL_RUPTURE_SPEED * (1 - p.dent * 0.35);
        if (p.kind === "barrel" && closing > ruptureAt && !p.dead) {
          const blast = Math.min(2.4, closing / BARREL_RUPTURE_SPEED);
          destroyProp(p, particles, nx, nz, blast * 1.1);
          v.hitStun = Math.max(v.hitStun, 0.14 * blast);
          v.impactFlash = Math.max(v.impactFlash, 0.6);
          /*
           * 6 x blast was 14.4 hull at a full-speed rupture — 15% of an
           * Interceptor. Ten barrels stand ON the racing line by design ("dodge
           * or smash"), so driving the line and smashing them was worth 144
           * damage against 92 health: the line itself was lethal. That never
           * showed, only because nothing in this file acted on reaching zero —
           * the car limped on at 0 hp instead of wrecking. Now that it does
           * wreck, the number has to be one a race can survive: 2.6 x blast is
           * 6.2 at the cap, so a clean lap through every barrel on the circuit
           * costs about two thirds of the hull rather than one and a half times
           * it. Still the most expensive prop on the track by a factor of two.
           */
          hurtVehicle(v, 2.6 * blast);
          // Blast radius: throws nearby props and hurts nearby cars, so a
          // cluster of barrels chain-reacts instead of each one popping in
          // isolation. This is what makes them worth aiming at.
          const R = 6.5 * blast;
          const R2 = R * R;
          for (const o of props) {
            if (o === p || o.dead || !o.dynamic) continue;
            const ox = o.x - p.x;
            const oz = o.z - p.z;
            const od2 = ox * ox + oz * oz;
            if (od2 > R2 || od2 < 1e-6) continue;
            const od = Math.sqrt(od2);
            const falloff = (1 - od / R) * blast;
            const push = (0.55 * falloff) / Math.max(0.005, o.mass);
            o.vx += (ox / od) * push;
            o.vz += (oz / od) * push;
            o.vy = Math.max(o.vy, 4 * falloff);
            o.spin += (Math.random() - 0.5) * 8 * falloff;
            o.hp -= 22 * falloff;
            // Survivors of a nearby blast carry the scorch. Without this the
            // only visible outcome of a chain reaction was "gone" or "fine".
            o.dent = Math.min(1, o.dent + falloff * 0.45);
            if (o.hp <= 0) destroyProp(o, particles, ox / od, oz / od, falloff * 1.5);
          }
          for (const other of vehicles) {
            if (!other.alive || other.wreckTimer > 0) continue;
            const ox = other.x - p.x;
            const oz = other.z - p.z;
            const od2 = ox * ox + oz * oz;
            if (od2 > R2) continue;
            const falloff = (1 - Math.sqrt(od2) / R) * blast;
            // Scaled with the direct hit above, and kept below it: being near a
            // barrel somebody else hit must always cost less than hitting it.
            hurtVehicle(other, 3.5 * falloff);
            other.impactFlash = Math.max(other.impactFlash, 0.5 * falloff);
            other.hitStun = Math.max(other.hitStun, 0.1 * falloff);
          }
          continue;
        }

        // A crate taken square comes apart into slats. No blast, no push-back
        // and no extra impulse on the car — the launch above already happened,
        // this only decides whether what flies away is a crate or its planks.
        if (
          p.kind === "crate" &&
          closing > CRATE_SHATTER_SPEED * (1 - p.dent * 0.3) &&
          !p.dead
        ) {
          destroyProp(p, particles, va.vx, va.vz, closing / 11);
          v.impactFlash = Math.max(v.impactFlash, 0.34);
          v.hitStun = Math.max(v.hitStun, 0.06);
          hurtVehicle(v, closing * 0.08);
          maxImpact = Math.max(maxImpact, impact);
          continue;
        }

        if (impact > 2.5) {
          p.hp -= impact * 1.4;
          p.dent = Math.min(1, p.dent + impact * 0.07);
          v.impactFlash = Math.max(v.impactFlash, 0.22);
          if (impact > 6) {
            v.hitStun = Math.max(v.hitStun, 0.08);
            // Barrels used to be excluded here, so ramming one below the
            // rupture threshold cost nothing at all — they read as scenery.
            // Lighter than a scrap pile, but no longer free.
            const dmgMul = p.kind === "barrel" ? 0.07 : 0.12;
            hurtVehicle(v, impact * dmgMul);
            spawnPropFx(
              particles,
              p.x,
              p.y,
              p.z,
              p.kind === "barrel" ? "#fb923c" : "#d6d3d1",
            );
          }
          if (p.hp <= 0) {
            // Worn down rather than blown apart, so the burst inherits the
            // last hit's direction at whatever energy actually finished it.
            destroyProp(p, particles, nx, nz, impact / 12);
          }
        }
      } else {
        const impact = Math.abs(velN);
        maxImpact = Math.max(maxImpact, impact);
        if (impact > 8) {
          v.impactFlash = Math.max(v.impactFlash, 0.18);
          v.hitStun = Math.max(v.hitStun, 0.06);
          hurtVehicle(v, impact * 0.07);
        }
      }
    }

    /*
     * Built structure — the walls, gates, container runs, wreck piles, pipeline
     * trestles, cranes, kilns, pumps and monoliths in world/setpieces.
     *
     * Separate from the props pass because these are capsules, not circles, and
     * they come out of a uniform grid rather than a linear scan: a 14m wall
     * module is the wrong shape for a circle at any radius, and there are up to
     * 136 of them on a circuit. The RESPONSE is the same deflectOffStatic every
     * other immovable thing gets — solid, immovable, never a push-back.
     *
     * Cost: one grid query per vehicle per fixed step (1-4 cells at a 24m cell
     * size), then a point-to-segment projection per capsule in those cells.
     */
    const yawC = Math.abs(Math.cos(v.yaw));
    const yawS = Math.abs(Math.sin(v.yaw));
    const carR =
      Math.max(hb.halfW * yawC + hb.halfL * yawS, hb.halfW * yawS + hb.halfL * yawC) *
      0.92;
    const statics = querySetpieceColliders(v.x, v.z, carR);
    for (const sc of statics) {
      const hit = capsuleContact(sc, v.x, v.z, carR);
      if (!hit.hit) continue;
      // Static, so the closing speed is just the car's velocity along the normal.
      const velN = va.vx * hit.nx + va.vz * hit.nz;
      deflectOffStatic(v, va, hit.nx, hit.nz, hit.pen, velN);
      maxImpact = Math.max(maxImpact, Math.abs(velN));
    }
  }
  return maxImpact;
}

/** Integrate dynamic props after vehicle collisions. */
export function stepWorldProps(props: PhysProp[], dt: number) {
  // Driven from here rather than sim.ts so debris rides the same fixed
  // timestep as the props it came from, with no extra plumbing through the
  // sim loop. Early-outs internally when the pool is empty.
  stepDebris(dt);

  for (const p of props) {
    if (p.dead || !p.dynamic) continue;
    if (p.vy === undefined) p.vy = 0;
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.y += p.vy * dt;
    p.yaw += p.spin * dt;
    /*
     * Rest height is GROUND-RELATIVE. It was a literal 0.48 / 0.42 — the height
     * a barrel sits at on a road at y = 0 — so every prop was dragged down to
     * that absolute height no matter where it stood. Beside the road the desert
     * is already several metres up (getGroundHeight reaches roadY + 1.1 +
     * dune*16.5 out in the open), so props spawned correctly on the surface got
     * pulled straight down into it on the first step. That is the "barrels in
     * the ground" report, and it is why fixing the SPAWN heights earlier did
     * not fix the symptom: this line undid it 60 times a second.
     *
     * Cost is one ground query per moving prop per step. The query is ~1.2us
     * and props asleep on the ground skip it entirely via the settled check
     * below, so a full field is well under a tenth of a millisecond.
     */
    const settled =
      p.vy === 0 && p.vx === 0 && p.vz === 0 && p.restY !== undefined;
    if (!settled) {
      p.restY = getGroundHeight(p.x, p.z) + PROP_REST_OFFSET[p.kind];
    }
    const restY = p.restY!;
    // Gravity + ground clamp
    p.vy -= 22 * dt;
    if (p.y <= restY) {
      p.y = restY;
      if (p.vy < 0) p.vy *= -0.35;
      if (Math.abs(p.vy) < 0.4) p.vy = 0;
    }
    p.vx *= 1 - 1.9 * dt;
    p.vz *= 1 - 1.9 * dt;
    p.spin *= 1 - 2.2 * dt;
    if (Math.abs(p.vx) < 0.03) p.vx = 0;
    if (Math.abs(p.vz) < 0.03) p.vz = 0;
  }

  const dyn = props.filter((p) => p.dynamic && !p.dead);
  const active = dyn.filter(
    (p) => Math.abs(p.vx) > 0.08 || Math.abs(p.vz) > 0.08 || p.dent > 0,
  );
  const check = active.length ? active : dyn.slice(0, 10);
  for (let i = 0; i < check.length; i++) {
    for (let j = i + 1; j < dyn.length; j++) {
      const a = check[i];
      const b = dyn[j];
      if (a === b) continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > 16) continue;
      const r = a.radius + b.radius;
      if (distSq >= r * r || distSq < 1e-8) continue;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const pen = (r - dist) * 0.5;
      a.x -= nx * pen;
      a.z -= nz * pen;
      b.x += nx * pen;
      b.z += nz * pen;
      const rvx = a.vx - b.vx;
      const rvz = a.vz - b.vz;
      const vn = rvx * nx + rvz * nz;
      if (vn > 0) {
        a.vx -= vn * nx * 0.5;
        a.vz -= vn * nz * 0.5;
        b.vx += vn * nx * 0.5;
        b.vz += vn * nz * 0.5;
        // Props batter each other too. Only cosmetic (no hp), so a launched
        // barrel scattering a stack leaves visibly scuffed survivors without
        // props being able to destroy props behind the player's back.
        if (vn > 3.5) {
          const scuff = Math.min(0.22, (vn - 3.5) * 0.03);
          a.dent = Math.min(1, a.dent + scuff);
          b.dent = Math.min(1, b.dent + scuff);
        }
      }
    }
  }
}
