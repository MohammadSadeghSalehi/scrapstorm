/**
 * Procedural mesh damage — vertex displacement for vehicle panels.
 *
 * Two layers, deliberately separated:
 *
 *   1. `deformPositions` — a pure function over Float32Arrays with no THREE
 *      dependency at all. Given pristine positions and a list of hits it writes
 *      displaced positions. This is the whole algorithm, and it is testable
 *      head-less (see the jiti note in scripts/check-track-profile.mjs).
 *
 *   2. `VehicleDeformer` + a small registry — the stateful wrapper that owns
 *      geometry cloning, car-space -> mesh-space transforms, hit accumulation
 *      and normal refresh.
 *
 * The split exists because the mesh this runs on is mounted by
 * `src/game/vehicles/GltfCar.tsx`, which this agent does not own. Integration is
 * therefore ONE call (`attachVehicleDeformer`); everything else is driven from
 * the VFX scene, which already walks the vehicle list every frame.
 *
 * ---------------------------------------------------------------- art notes
 * A dent is not a smooth bump. Pushing a cosine lobe into a panel gives you the
 * "thumb in clay" look that every naive implementation produces and that reads
 * as rubber, not steel. Sheet metal does three things a cosine does not:
 *
 *   - it CRUSHES to a flattish floor and then turns a sharp shoulder, rather
 *     than easing continuously from centre to edge;
 *   - it BUCKLES into concentric folds, because the panel is a constrained
 *     surface and the material has to go somewhere circumferentially;
 *   - it CREASES along a line, because a panel folds about whichever axis is
 *     stiffest, and that fold is the single most recognisable feature of real
 *     damage;
 *   - and it BULGES just outside the crush, because the displaced material has
 *     nowhere else to go.
 *
 * All four are in the profile below, all four are seeded per hit, so the same
 * car taking two impacts on the same panel gets two visibly different dents.
 */

import * as THREE from "three";
import { hash01 } from "../vfx/rng";

/** A single impact, expressed in whatever space the positions are in. */
export interface DeformHit {
  x: number;
  y: number;
  z: number;
  /** Unit vector pointing INTO the panel — the direction it folds. */
  dx: number;
  dy: number;
  dz: number;
  /** Peak inward displacement at the centre, in the positions' units. */
  depth: number;
  /** Falloff radius, in the positions' units. */
  radius: number;
  /** Drives crease axis, ring frequency, bulge and grain. Same seed = same dent. */
  seed: number;
}

/**
 * Hits per target. Ten is enough to cover a whole race because
 * `VehicleDeformer.addHit` MERGES a new hit into a nearby existing one rather
 * than dropping it — so damage keeps accumulating past the cap, it just stops
 * gaining new fold centres. Raising this raises the per-vertex inner loop
 * linearly and buys very little: past about six overlapping dents a panel is
 * visually saturated.
 */
export const MAX_DEFORM_HITS = 10;

/**
 * Hard ceiling on how far any vertex may move, in car metres.
 *
 * Without it, an accumulating dent field eventually inverts a panel through
 * itself — which does not read as "very damaged", it reads as a broken mesh.
 */
export const MAX_DISPLACE = 0.34;

interface PreparedHit {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  depth: number;
  invR: number;
  /** Squared cull radius — 1.5x the falloff radius, to include the bulge ring. */
  outer2: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  ringFreq: number;
  ringPhase: number;
  ringAmp: number;
  cax: number;
  cay: number;
  caz: number;
  creaseAmp: number;
  /** Squared reciprocal of the crease half-width; folded in to avoid a divide. */
  creaseK: number;
  bulgeAmp: number;
  grain: number;
  seed: number;
}

function blankPrepared(): PreparedHit {
  return {
    ox: 0,
    oy: 0,
    oz: 0,
    dx: 0,
    dy: 0,
    dz: 1,
    depth: 0,
    invR: 1,
    outer2: 1,
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
    minZ: 0,
    maxZ: 0,
    ringFreq: 3,
    ringPhase: 0,
    ringAmp: 0.25,
    cax: 1,
    cay: 0,
    caz: 0,
    creaseAmp: 0.25,
    creaseK: 16,
    bulgeAmp: 0.12,
    grain: 0.05,
    seed: 1,
  };
}

/** Preallocated: `deformPositions` must not allocate, it runs over 20k+ verts. */
const prepared: PreparedHit[] = Array.from({ length: MAX_DEFORM_HITS }, blankPrepared);

const OUTER = 1.5;

function prepare(h: DeformHit, p: PreparedHit): void {
  const len = Math.hypot(h.dx, h.dy, h.dz) || 1;
  const dx = h.dx / len;
  const dy = h.dy / len;
  const dz = h.dz / len;

  const s = h.seed >>> 0;
  const a = hash01(s);
  const b = hash01(s ^ 0x9e3779b9);
  const c = hash01(s ^ 0x85ebca6b);
  const d = hash01(s ^ 0xc2b2ae35);
  const e = hash01(s ^ 0x27d4eb2f);

  // Crease axis: any unit vector perpendicular to the fold direction, chosen by
  // the seed. Built from a stable helper axis so a hit straight down the mesh's
  // own +Y (a roof strike) does not degenerate to a zero cross product.
  const helperY = Math.abs(dy) > 0.9 ? 1 : 0;
  let hx = helperY ? 1 : 0;
  let hy = helperY ? 0 : 1;
  let hz = 0;
  // t1 = normalize(cross(dir, helper))
  let t1x = dy * hz - dz * hy;
  let t1y = dz * hx - dx * hz;
  let t1z = dx * hy - dy * hx;
  const t1l = Math.hypot(t1x, t1y, t1z) || 1;
  t1x /= t1l;
  t1y /= t1l;
  t1z /= t1l;
  // t2 = cross(dir, t1) — already unit, dir and t1 are orthonormal.
  const t2x = dy * t1z - dz * t1y;
  const t2y = dz * t1x - dx * t1z;
  const t2z = dx * t1y - dy * t1x;
  const ang = a * Math.PI;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  hx = t1x * ca + t2x * sa;
  hy = t1y * ca + t2y * sa;
  hz = t1z * ca + t2z * sa;

  const r = Math.max(1e-4, h.radius);
  p.ox = h.x;
  p.oy = h.y;
  p.oz = h.z;
  p.dx = dx;
  p.dy = dy;
  p.dz = dz;
  p.depth = h.depth;
  p.invR = 1 / r;
  const outerR = r * OUTER;
  p.outer2 = outerR * outerR;
  p.minX = h.x - outerR;
  p.maxX = h.x + outerR;
  p.minY = h.y - outerR;
  p.maxY = h.y + outerR;
  p.minZ = h.z - outerR;
  p.maxZ = h.z + outerR;
  // 2.2 to 4.6 folds across the dent. Below ~2 the rings are indistinguishable
  // from the core, above ~5 they alias into noise at any sane vertex density.
  p.ringFreq = 2.2 + b * 2.4;
  p.ringPhase = c * Math.PI * 2;
  p.ringAmp = 0.16 + d * 0.24;
  p.cax = hx;
  p.cay = hy;
  p.caz = hz;
  p.creaseAmp = 0.18 + e * 0.34;
  const cw = 0.1 + b * 0.18;
  p.creaseK = 1 / (cw * cw);
  p.bulgeAmp = 0.09 + c * 0.15;
  p.grain = 0.035 + d * 0.055;
  p.seed = s;
}

/**
 * Displace `base` into `out` by every hit, and report how many vertices moved.
 *
 * `base` is never written, so the pristine mesh is always recoverable and hits
 * are re-evaluated from scratch — that is what lets a hit be MERGED into an
 * existing one (see VehicleDeformer.addHit) without the geometry drifting.
 *
 * Loop order is vertices-outer / hits-inner on purpose: `base` is walked once,
 * sequentially, and `out` is written once. The transposed loop touches the same
 * arithmetic but streams both arrays `hitCount` times.
 */
export function deformPositions(
  base: Float32Array,
  out: Float32Array,
  hits: readonly DeformHit[],
  hitCount: number,
  maxDisplace = MAX_DISPLACE,
): number {
  const n = Math.min(hitCount, MAX_DEFORM_HITS, hits.length);
  if (n <= 0) {
    out.set(base);
    return 0;
  }
  for (let i = 0; i < n; i++) prepare(hits[i]!, prepared[i]!);

  const verts = (base.length / 3) | 0;
  const maxD2 = maxDisplace * maxDisplace;
  let moved = 0;

  for (let v = 0; v < verts; v++) {
    const o = v * 3;
    const px = base[o]!;
    const py = base[o + 1]!;
    const pz = base[o + 2]!;
    let ax = 0;
    let ay = 0;
    let az = 0;

    for (let k = 0; k < n; k++) {
      const h = prepared[k]!;
      // AABB reject first: a dent covers a few percent of a car body, so the
      // overwhelming majority of vertex/hit pairs die on six compares.
      if (px < h.minX || px > h.maxX) continue;
      if (py < h.minY || py > h.maxY) continue;
      if (pz < h.minZ || pz > h.maxZ) continue;

      const dx = px - h.ox;
      const dy = py - h.oy;
      const dz = pz - h.oz;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 > h.outer2) continue;

      const r = Math.sqrt(r2);
      const t = r * h.invR;

      // --- crush envelope: flat floor, then a shoulder steeper than a cosine.
      let core = 0;
      if (t <= 0.35) {
        core = 1;
      } else if (t < 1) {
        const u = (t - 0.35) / 0.65;
        const iu = 1 - u;
        core = iu * iu * (1 - u * 0.42);
      }

      let push = 0;
      if (core > 0) {
        // --- buckle rings, dying out toward the rim so the edge stays clean.
        const ring = Math.cos(t * h.ringFreq * Math.PI + h.ringPhase) * (1 - t);
        const profile = core * (1 + h.ringAmp * ring);

        // --- crease: a Lorentzian valley along a seeded axis through the hit.
        //     Lorentzian rather than a gaussian purely for cost — this is the
        //     innermost expression in the whole subsystem.
        const c = (dx * h.cax + dy * h.cay + dz * h.caz) * h.invR;
        const crease = (h.creaseAmp * core) / (1 + c * c * h.creaseK);

        // --- grain: per-vertex hash so the crushed area is not analytically
        //     smooth. Small; this is surface texture, not shape.
        const grain = (hash01((v * 2654435761) ^ h.seed) - 0.5) * h.grain * core;

        push = h.depth * (profile + crease + grain);
      }

      // --- volume displacement: the material pushed out of the crush has to
      //     go somewhere, and it goes into a raised lip just outside it. This
      //     is the cheapest single thing that separates a dent from a hole.
      if (t > 0.72 && t < OUTER) {
        const b = Math.sin(((t - 0.72) / (OUTER - 0.72)) * Math.PI);
        push -= h.depth * h.bulgeAmp * b;
      }

      if (push !== 0) {
        ax += h.dx * push;
        ay += h.dy * push;
        az += h.dz * push;
      }
    }

    if (ax !== 0 || ay !== 0 || az !== 0) {
      const m2 = ax * ax + ay * ay + az * az;
      if (m2 > maxD2) {
        const k = maxDisplace / Math.sqrt(m2);
        ax *= k;
        ay *= k;
        az *= k;
      }
      moved++;
    }

    out[o] = px + ax;
    out[o + 1] = py + ay;
    out[o + 2] = pz + az;
  }

  return moved;
}

/* ------------------------------------------------------------- stateful */

/**
 * Meshes above this many vertices are left alone.
 *
 * The flush cost is O(verts x hits) plus a `computeVertexNormals`, and it runs
 * on the main thread. A hero car body is a few thousand vertices; anything an
 * order of magnitude past that is a merged mesh that includes glass, interior
 * and wheels, and deforming it would be both slow and wrong.
 */
const VERT_BUDGET = 26000;

interface DeformTarget {
  mesh: THREE.Mesh;
  attr: THREE.BufferAttribute;
  base: Float32Array;
  work: Float32Array;
  /** car-metre space -> this mesh's local space. */
  toLocal: THREE.Matrix4;
  /** Rotation-only part of toLocal, for directions. */
  dirMat: THREE.Matrix3;
  /** Multiply car-metre lengths by this to get mesh-local lengths. */
  lenScale: number;
}

const hitScratch: DeformHit[] = Array.from({ length: MAX_DEFORM_HITS }, () => ({
  x: 0,
  y: 0,
  z: 0,
  dx: 0,
  dy: 0,
  dz: 1,
  depth: 0,
  radius: 1,
  seed: 1,
}));

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class VehicleDeformer {
  readonly hits: DeformHit[] = [];
  private targets: DeformTarget[] = [];
  private dirty = false;
  private lastFlush = -1e9;
  private attached = false;
  /** Car-space bounding box in metres, for synthesising face hits. */
  readonly bounds = {
    minX: -0.9,
    maxX: 0.9,
    minY: 0,
    maxY: 1.2,
    minZ: -2.1,
    maxZ: 2.1,
  };
  /** Previous dent scalars, so only the RISE of a dent spawns a new fold. */
  lastDent = { f: 0, l: 0, r: 0, b: 0 };
  skippedVerts = 0;

  isAttached(): boolean {
    return this.attached;
  }

  targetCount(): number {
    return this.targets.length;
  }

  /**
   * Bind to a mounted vehicle shell.
   *
   * `shell` is the object GltfCar puts under its pose group, so "car space" is
   * shell.parent's space: metres, +X right, +Y up, and the car facing -Z (that
   * is the convention `g.rotation.y = v.yaw` establishes, since local -Z maps
   * to the world forward vector (-sin yaw, -cos yaw)).
   */
  attach(shell: THREE.Object3D): void {
    this.detachGeometry();
    this.targets = [];
    this.attached = true;
    this.skippedVerts = 0;

    let bMinX = Infinity;
    let bMaxX = -Infinity;
    let bMinY = Infinity;
    let bMaxY = -Infinity;
    let bMinZ = Infinity;
    let bMaxZ = -Infinity;

    shell.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const pos = mesh.geometry.getAttribute("position") as
        | THREE.BufferAttribute
        | undefined;
      if (!pos || pos.itemSize !== 3) return;
      if (pos.count > VERT_BUDGET) {
        this.skippedVerts += pos.count;
        return;
      }

      // Local matrix chain from the shell down to this mesh, WITHOUT touching
      // matrixWorld. Doing it this way means attach() works the instant the
      // shell is built, before React has put it in the scene graph — the
      // alternative (waiting for a world matrix) leaves the first few hits of a
      // race with nowhere to land.
      _m.identity();
      const chain: THREE.Object3D[] = [];
      let cur: THREE.Object3D | null = mesh;
      while (cur && cur !== shell) {
        chain.push(cur);
        cur = cur.parent;
      }
      chain.push(shell);
      for (let i = chain.length - 1; i >= 0; i--) {
        const o = chain[i]!;
        o.updateMatrix();
        _m.multiply(o.matrix);
      }

      // Uniform-ish scale factor: length of the transform's first basis vector.
      const el = _m.elements;
      const lenScale = Math.hypot(el[0]!, el[1]!, el[2]!) || 1;

      // Grow the car-space bounds from this mesh's own bounding box.
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (bb) {
        for (let c = 0; c < 8; c++) {
          _v.set(
            c & 1 ? bb.max.x : bb.min.x,
            c & 2 ? bb.max.y : bb.min.y,
            c & 4 ? bb.max.z : bb.min.z,
          ).applyMatrix4(_m);
          if (_v.x < bMinX) bMinX = _v.x;
          if (_v.x > bMaxX) bMaxX = _v.x;
          if (_v.y < bMinY) bMinY = _v.y;
          if (_v.y > bMaxY) bMaxY = _v.y;
          if (_v.z < bMinZ) bMinZ = _v.z;
          if (_v.z > bMaxZ) bMaxZ = _v.z;
        }
      }

      /*
       * COPY-ON-WRITE. `Object3D.clone(true)` shares BufferGeometry between
       * clones, and GltfCar builds every car from one cached template — so
       * writing into the template's position buffer would dent every car in
       * the field that uses that model, simultaneously, including the AI ones
       * that were never hit. Cloning once here is the entire reason this class
       * owns geometry at all.
       */
      const geo = mesh.geometry.clone();
      mesh.geometry = geo;
      const live = geo.getAttribute("position") as THREE.BufferAttribute;
      const arr = live.array as Float32Array;

      const toLocal = _m.clone().invert();
      const dirMat = new THREE.Matrix3().setFromMatrix4(toLocal);

      this.targets.push({
        mesh,
        attr: live,
        base: new Float32Array(arr),
        work: arr,
        toLocal,
        dirMat,
        lenScale,
      });
    });

    if (bMinX < bMaxX) {
      this.bounds.minX = bMinX;
      this.bounds.maxX = bMaxX;
      this.bounds.minY = bMinY;
      this.bounds.maxY = bMaxY;
      this.bounds.minZ = bMinZ;
      this.bounds.maxZ = bMaxZ;
    }

    // Replay whatever landed before the mesh existed.
    if (this.hits.length > 0) {
      this.dirty = true;
      this.lastFlush = -1e9;
    }
  }

  private detachGeometry(): void {
    for (const t of this.targets) t.mesh.geometry.dispose();
    this.targets = [];
  }

  /**
   * Add a hit in CAR space (metres, -Z forward).
   *
   * Past MAX_DEFORM_HITS the new hit is merged into whichever existing hit is
   * closest rather than replacing one. That is what makes damage ACCUMULATE
   * over a race: the twelfth impact on a front wing deepens the fold that is
   * already there instead of evicting a fold from the door.
   */
  addHit(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    depth: number,
    radius: number,
    seed: number,
  ): void {
    if (depth <= 0.001) return;

    if (this.hits.length < MAX_DEFORM_HITS) {
      this.hits.push({ x, y, z, dx, dy, dz, depth, radius, seed });
      this.dirty = true;
      return;
    }

    let best = this.hits[0]!;
    let bestD2 = Infinity;
    for (const h of this.hits) {
      const ddx = h.x - x;
      const ddy = h.y - y;
      const ddz = h.z - z;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = h;
      }
    }
    // Pull the fold centre a little toward the new impact and deepen it, but
    // keep the ORIGINAL seed so the existing crease/ring pattern survives —
    // re-seeding here would make the whole panel visibly re-fold on every hit.
    const w = 0.3;
    best.x += (x - best.x) * w;
    best.y += (y - best.y) * w;
    best.z += (z - best.z) * w;
    best.dx += (dx - best.dx) * w;
    best.dy += (dy - best.dy) * w;
    best.dz += (dz - best.dz) * w;
    best.depth = Math.min(MAX_DISPLACE * 1.6, best.depth + depth * 0.55);
    best.radius = Math.max(best.radius, radius * 0.85);
    this.dirty = true;
  }

  needsFlush(now: number, minInterval: number): boolean {
    return this.dirty && this.targets.length > 0 && now - this.lastFlush >= minInterval;
  }

  /**
   * Rebuild displaced positions (and optionally normals).
   *
   * `recomputeNormals` is a real cost — it is an O(verts) pass with a normalise
   * per vertex — so it is tier-gated by the caller. Skipping it leaves the
   * silhouette correct and only the shading slightly stale, which is a much
   * better trade on a low-end machine than skipping the deformation itself.
   *
   * `computeVertexNormals` is safe for hard edges here: glTF represents a hard
   * edge as duplicated vertices, and the averaging is per index, so split
   * vertices stay split.
   */
  flush(now: number, recomputeNormals: boolean): void {
    if (!this.dirty || this.targets.length === 0) return;
    this.dirty = false;
    this.lastFlush = now;

    const n = Math.min(this.hits.length, MAX_DEFORM_HITS);
    for (const t of this.targets) {
      for (let i = 0; i < n; i++) {
        const src = this.hits[i]!;
        const dst = hitScratch[i]!;
        _v.set(src.x, src.y, src.z).applyMatrix4(t.toLocal);
        dst.x = _v.x;
        dst.y = _v.y;
        dst.z = _v.z;
        _v.set(src.dx, src.dy, src.dz).applyMatrix3(t.dirMat);
        const l = _v.length() || 1;
        dst.dx = _v.x / l;
        dst.dy = _v.y / l;
        dst.dz = _v.z / l;
        // Lengths follow the transform's scale, otherwise a model normalised
        // to 4.2 metres would take a 0.2m dent as a 0.2-unit crater.
        const s = 1 / t.lenScale;
        dst.depth = src.depth * s;
        dst.radius = src.radius * s;
        dst.seed = src.seed;
      }
      deformPositions(t.base, t.work, hitScratch, n, MAX_DISPLACE / t.lenScale);
      t.attr.needsUpdate = true;
      if (recomputeNormals) {
        t.mesh.geometry.computeVertexNormals();
      }
      // The bounding sphere grows with the bulge; leaving the pristine one in
      // place makes a heavily-dented car pop out of view at glancing angles.
      t.mesh.geometry.boundingSphere = null;
      t.mesh.geometry.boundingBox = null;
    }
  }

  /** Put the panels back. Called on respawn and on a fresh race. */
  reset(): void {
    this.hits.length = 0;
    this.lastDent.f = 0;
    this.lastDent.l = 0;
    this.lastDent.r = 0;
    this.lastDent.b = 0;
    for (const t of this.targets) {
      t.work.set(t.base);
      t.attr.needsUpdate = true;
      t.mesh.geometry.computeVertexNormals();
      t.mesh.geometry.boundingSphere = null;
      t.mesh.geometry.boundingBox = null;
    }
    this.dirty = false;
  }

  dispose(): void {
    this.detachGeometry();
    this.hits.length = 0;
    this.attached = false;
  }
}

/* ------------------------------------------------------------- registry */

const registry = new Map<string, VehicleDeformer>();

function entry(id: string): VehicleDeformer {
  let d = registry.get(id);
  if (!d) {
    d = new VehicleDeformer();
    registry.set(id, d);
  }
  return d;
}

/**
 * THE integration point.
 *
 * Call once from GltfCar right after the shell clone is built:
 *
 *     attachVehicleDeformer(vehicleId ?? vehicle.id, clone);
 *
 * Idempotent — re-attaching (a class swap, a model LOD fallback) rebinds to the
 * new geometry and replays the accumulated hits onto it.
 */
export function attachVehicleDeformer(id: string, shell: THREE.Object3D): VehicleDeformer {
  const d = entry(id);
  d.attach(shell);
  return d;
}

export function getVehicleDeformer(id: string): VehicleDeformer | undefined {
  return registry.get(id);
}

/**
 * Record an impact from world space.
 *
 * The world -> car transform is done from the vehicle's authoritative pose
 * rather than from `mesh.matrixWorld`, and that is not a shortcut. Object world
 * matrices are only refreshed at render time, so reading one during the sim
 * step gives you LAST frame's pose — 1.2 metres of error at top speed, i.e. a
 * dent placed on the wrong panel.
 */
export function addVehicleDeformHitWorld(
  id: string,
  wx: number,
  wy: number,
  wz: number,
  inX: number,
  inY: number,
  inZ: number,
  vx: number,
  vy: number,
  vz: number,
  yaw: number,
  depth: number,
  radius: number,
  seed: number,
): void {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const rx = wx - vx;
  const ry = wy - vy;
  const rz = wz - vz;
  // Inverse of the yaw rotation GltfCar applies (world = Ry(yaw) * local).
  const lx = cos * rx - sin * rz;
  const lz = sin * rx + cos * rz;
  const dx = cos * inX - sin * inZ;
  const dz = sin * inX + cos * inZ;
  entry(id).addHit(lx, ry, lz, dx, inY, dz, depth, radius, seed);
}

/** Local-space variant, for callers that already work in car metres. */
export function addVehicleDeformHitLocal(
  id: string,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  depth: number,
  radius: number,
  seed: number,
): void {
  entry(id).addHit(x, y, z, dx, dy, dz, depth, radius, seed);
}

/**
 * Turn the sim's four crumple-zone scalars into fold centres.
 *
 * `dentFront/Left/Right/Rear` accumulate in physics.ts and worldProps.ts, which
 * this agent does not own, so this is the bridge: a RISE in a zone becomes one
 * new seeded hit on that face. Only the rise, never the level — polling the
 * level would re-add a hit every frame the car stayed damaged.
 *
 * Returns true if a hit was added.
 */
export function syncVehicleDents(
  id: string,
  dentFront: number,
  dentLeft: number,
  dentRight: number,
  dentRear: number,
): boolean {
  const d = registry.get(id);
  if (!d) return false;
  const b = d.bounds;
  let added = false;

  const face = (
    cur: number,
    prev: number,
    key: "f" | "l" | "r" | "b",
    axis: 0 | 1,
    sign: 1 | -1,
  ) => {
    const delta = cur - prev;
    // 0.045 is roughly two glancing scrapes' worth. Lower and a long wall
    // graze spends the whole hit budget on one panel.
    if (delta < 0.045) {
      if (cur < prev) d.lastDent[key] = cur;
      return;
    }
    d.lastDent[key] = cur;
    const seed = ((id.length * 2654435761) ^ ((cur * 4096) | 0) ^ (key.charCodeAt(0) << 16)) >>> 0;
    const j1 = hash01(seed);
    const j2 = hash01(seed ^ 0x51ed270b);
    const midY = b.minY + (b.maxY - b.minY) * (0.35 + j2 * 0.4);

    let x: number;
    let z: number;
    let dx: number;
    let dz: number;
    if (axis === 0) {
      // Side panel: fix X to the flank, jitter along the length.
      x = sign > 0 ? b.maxX : b.minX;
      z = b.minZ + (b.maxZ - b.minZ) * (0.2 + j1 * 0.6);
      dx = -sign;
      dz = (j2 - 0.5) * 0.35;
    } else {
      // End panel: fix Z to the nose/tail, jitter across the width.
      z = sign > 0 ? b.maxZ : b.minZ;
      x = b.minX + (b.maxX - b.minX) * (0.2 + j1 * 0.6);
      dz = -sign;
      dx = (j2 - 0.5) * 0.35;
    }
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    d.addHit(
      x,
      midY,
      z,
      dx,
      -0.12 - j1 * 0.18,
      dz,
      0.05 + delta * 0.62 + cur * 0.05,
      span * (0.16 + j2 * 0.16),
      seed,
    );
    added = true;
  };

  face(dentFront, d.lastDent.f, "f", 1, -1);
  face(dentRear, d.lastDent.b, "b", 1, 1);
  face(dentRight, d.lastDent.r, "r", 0, 1);
  face(dentLeft, d.lastDent.l, "l", 0, -1);
  return added;
}

export interface DeformFlushOptions {
  /** Seconds — a monotonic clock, only differences matter. */
  now: number;
  /** Minimum seconds between rebuilds of one car. */
  minInterval: number;
  recomputeNormals: boolean;
  /** Cars flushed in one frame. Keeps a pile-up from spiking a single frame. */
  maxPerFrame: number;
}

/**
 * Rebuild whichever deformers are dirty, at most `maxPerFrame` of them.
 *
 * Budgeting per frame rather than flushing everything is the difference between
 * a four-car pile-up costing one 4x spike and costing four ordinary frames.
 */
export function flushVehicleDeformers(opts: DeformFlushOptions): number {
  let done = 0;
  for (const d of registry.values()) {
    if (done >= opts.maxPerFrame) break;
    if (!d.needsFlush(opts.now, opts.minInterval)) continue;
    d.flush(opts.now, opts.recomputeNormals);
    done++;
  }
  return done;
}

/** Undo all damage but keep the bindings — a respawn, not a new race. */
export function restoreVehicleDeformer(id: string): void {
  registry.get(id)?.reset();
}

/** New race / rebuilt field: drop every binding and its cloned geometry. */
export function resetVehicleDeformers(): void {
  for (const d of registry.values()) d.dispose();
  registry.clear();
}

export function deformerStats(): {
  cars: number;
  attached: number;
  hits: number;
  targets: number;
} {
  let attached = 0;
  let hits = 0;
  let targets = 0;
  for (const d of registry.values()) {
    if (d.isAttached()) attached++;
    hits += d.hits.length;
    targets += d.targetCount();
  }
  return { cars: registry.size, attached, hits, targets };
}
