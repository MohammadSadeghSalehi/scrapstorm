/**
 * The desert heightfield: built once, cached, and reusable from the load screen.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * This is the largest single block of main-thread work in the game. At the high
 * tier the plane is 385x385 vertices and every one of them costs an exact
 * point-to-segment track query plus two multi-octave fBm evaluations — measured
 * at roughly 5us per vertex, so about three quarters of a second of wall clock,
 * uninterruptible, in one `useMemo`.
 *
 * That `useMemo` used to run inside `HeightmapTerrain`, which mounts when the
 * race world mounts, which happens on the first React render after the phase
 * flips to "countdown". In other words the single biggest stall in the game was
 * scheduled to land on the word "three".
 *
 * Two things fix that, and this module is both of them:
 *
 *  1. The build is a GENERATOR, so the same code can be driven to completion
 *     synchronously (the fallback) or sliced across macrotasks (the load
 *     screen). One code path, so the sliced version cannot silently produce a
 *     different desert from the synchronous one.
 *
 *  2. The result is cached as PLAIN TYPED ARRAYS rather than as a
 *     BufferGeometry. Caching the geometry object would mean handing the same
 *     instance to a second mount, and r3f disposes what it is given — a
 *     disposed geometry handed to the next race is a black hole where the
 *     ground should be. Arrays cannot be disposed out from under us, and
 *     rebuilding a BufferGeometry around them is a handful of microseconds
 *     against the three quarters of a second it replaces.
 *
 * The track field itself (`buildTrackField`, `meshHeight`) lives here too, so
 * that `HeightmapTerrain` can import this module without a cycle.
 */
import * as THREE from "three";
/*
 * getTrackSamples(), NOT the TRACK_SAMPLES binding.
 *
 * `export let` is live under real ESM, so importing the binding works in the
 * browser — but jiti transpiles to CJS and snapshots the namespace property at
 * module init, so every headless check of this module measured ash_spire's
 * patch bounds no matter which circuit was active. It looked like a passing
 * test: six different circuits, six identical spans, no error. AGENTS.md 4.
 */
import { duneProfile, getSurfaceAt, getTrackSamples } from "../track";
import { sampleDuneField, sampleRockMask } from "./terrainHeight";
import { SLICE_MS, gateNow, yieldToBrowser } from "./raceGate";
import type { EnvironmentDef } from "./environments";

/**
 * Centre and side length of the heightfield patch, in world metres.
 *
 * Exported because anything that has to sit UNDER or AROUND the patch has to
 * agree with it. The flat sand underlay used to carry its own hardcoded
 * (20, 40) / 340m — Ash Spire's numbers — so on the two long circuits the
 * underlay was smaller than, and offset from, the terrain it was supposed to
 * back. A second copy of this is a second thing to forget to move.
 */
export function terrainPatch() {
  return trackCenter();
}

function trackCenter() {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of getTrackSamples()) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.z < minZ) minZ = s.z;
    if (s.z > maxZ) maxZ = s.z;
  }
  if (!Number.isFinite(minX)) return { cx: 20, cz: 40, span: 400 };
  return {
    cx: (minX + maxX) * 0.5,
    cz: (minZ + maxZ) * 0.5,
    span: Math.max(maxX - minX + 260, maxZ - minZ + 260, 400),
  };
}

type Seg = {
  ax: number;
  az: number;
  ay: number;
  ah: number;
  dx: number;
  dz: number;
  dy: number;
  dh: number;
  len2: number;
};

/** Cell size and query reach of the segment lookup grid, in world metres. */
const GRID_CELL = 32;
/** Must cover the full apron+deep falloff (half + 70) so the blend stays exact. */
const GRID_REACH = 96;

export type TrackField = {
  segs: Seg[];
  grid: Map<number, number[]>;
  coarse: Seg[];
};

const cellKey = (cx: number, cz: number) => cx * 73856093 + cz * 19349663;

/**
 * Track as a polyline of segments, plus a uniform grid for lookup.
 *
 * The old index decimated to ~100 points and measured point distance. Between
 * two consecutive points the true distance to the *road* is much smaller than
 * the distance to either endpoint, so the corridor was never carved there and
 * dunes pushed up through the tarmac — the mountains-in-the-road bug. Exact
 * point-to-segment distance over every sample removes the gap entirely.
 */
/** Exported so mesh-vs-physics agreement can be asserted, not assumed. */
export function buildTrackField(): TrackField {
  const samples = getTrackSamples();
  const n = samples.length;
  const segs: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const a = samples[i]!;
    const b = samples[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    segs.push({
      ax: a.x,
      az: a.z,
      ay: a.y,
      ah: a.width * 0.5,
      dx,
      dz,
      dy: b.y - a.y,
      dh: b.width * 0.5 - a.width * 0.5,
      len2: Math.max(1e-6, dx * dx + dz * dz),
    });
  }

  // Bucket each segment into every cell within GRID_REACH of its extent, so a
  // lookup only ever tests a handful of candidates instead of all ~400.
  const grid = new Map<number, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const minX = Math.min(s.ax, s.ax + s.dx) - GRID_REACH;
    const maxX = Math.max(s.ax, s.ax + s.dx) + GRID_REACH;
    const minZ = Math.min(s.az, s.az + s.dz) - GRID_REACH;
    const maxZ = Math.max(s.az, s.az + s.dz) + GRID_REACH;
    for (let cx = Math.floor(minX / GRID_CELL); cx <= Math.floor(maxX / GRID_CELL); cx++) {
      for (let cz = Math.floor(minZ / GRID_CELL); cz <= Math.floor(maxZ / GRID_CELL); cz++) {
        const k = cellKey(cx, cz);
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(i);
      }
    }
  }

  // Far from the track only the dune field matters, so a decimated scan is
  // enough to recover an approximate road height out there.
  const step = Math.max(1, Math.floor(segs.length / 64));
  const coarse: Seg[] = [];
  for (let i = 0; i < segs.length; i += step) coarse.push(segs[i]!);

  return { segs, grid, coarse };
}

/**
 * How far the terrain sits below the road surface inside the corridor.
 *
 * The terrain used to return exactly `roadY` there, making it coplanar with
 * the road mesh — and coplanar geometry z-fights, which showed up as the road
 * tearing into patches of sand. Sinking it slightly means the road always wins
 * the depth test, and at this scale it just reads as a shallow kerb.
 */
const ROAD_SINK = 0.15;

/** Exported for the same reason as buildTrackField — see its note. */
export function meshHeight(field: TrackField, x: number, z: number): number {
  /*
   * The surface query has to be the SAME one physics uses, not just an
   * equivalent one.
   *
   * This took nearestTrack(field, ...) — an exact point-to-segment sweep that
   * INTERPOLATES roadY along the segment — while getGroundHeight takes
   * getSurfaceAt(x, z), which reports the nearest SAMPLE's y. Same curve, same
   * rock and dune terms, different base: measured ±1.8m apart out in the far
   * desert, which is precisely the jump-zone lift (sin * 1.8) reaching a point
   * 400m away through one query and not the other.
   *
   * `field` is still taken so callers keep a stable signature and so the grid
   * stays available for the carving pass below.
   */
  void field;
  const surf = getSurfaceAt(x, z);
  const dist = surf.dist;
  const half = surf.half;
  const roadY = surf.sample.y;

  /*
   * ONE curve, shared with physics.
   *
   * This function used to carry its own copy of the height profile, and the two
   * had already drifted: dune 16 here against 16.5 in duneProfile, 14 against
   * 13.5 across the mid band, and a rock-mask term worth up to 3.5m that only
   * existed on the visible side. So the ground you could see and the ground you
   * drove on were different surfaces by several metres out in the open desert —
   * which is also why anything placed by the ground query could still look
   * wrong out there after every placement site had been fixed.
   *
   * The rock term moved INTO duneProfile rather than being dropped from here:
   * outcrops are the most legible feature in the far desert, and the correct
   * resolution of "the mesh has rocks and physics does not" is that you should
   * be able to drive over what you can see.
   */
  const h = duneProfile(
    roadY,
    sampleDuneField(x, z),
    sampleRockMask(x, z),
    dist,
    half,
  );

  /*
   * The one place the mesh is ALLOWED to differ: it dips below the physics
   * surface next to the tarmac so the track ribbon wins the depth test instead
   * of z-fighting with the terrain underneath it. Faded out across the apron so
   * it never offsets the open desert, where it would reintroduce exactly the
   * divergence this function was rewritten to remove.
   */
  const fadeStart = half + 2.5;
  const fadeEnd = half + 22;
  const u = Math.min(
    1,
    Math.max(0, (dist - fadeStart) / Math.max(0.01, fadeEnd - fadeStart)),
  );
  const sinkFade = 1 - u * u * (3 - 2 * u);
  return h - ROAD_SINK * sinkFade;
}

/* ── the baked field ────────────────────────────────────────────────── */

export type TerrainBuild = {
  readonly key: string;
  readonly segs: number;
  readonly cx: number;
  readonly cz: number;
  readonly span: number;
  /** World-space, already translated by (cx, 0, cz). Never mutate. */
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly color: Float32Array;
  readonly uv: Float32Array;
  readonly index: Uint32Array;
};

/**
 * Index buffers depend only on the segment count, so the three tiers share at
 * most three of them no matter how many circuits are visited. Kept apart from
 * the main cache because it is 3.5MB at the high tier — the single largest
 * array here, and the one with the least reason to be duplicated.
 */
const indexCache = new Map<number, Uint32Array>();

/**
 * Baked fields, newest last.
 *
 * Three entries is deliberate: the player's circuit, the one they came from,
 * and one spare for a tier change. At ~6.5MB each that is a ~20MB ceiling, paid
 * to make a second race on a circuit you have already driven cost nothing at
 * all — which is the common case, since the loop is race, garage, race again.
 */
const CACHE_LIMIT = 3;
const cache = new Map<string, TerrainBuild>();

/**
 * Identity of a baked field.
 *
 * The environment id and the track epoch are BOTH needed. The epoch alone would
 * be wrong because `setActiveTrack` is a no-op when the id has not changed (so
 * two different circuits can share an epoch across a reload), and the id alone
 * would be wrong because the epoch is what changes when the same circuit is
 * rebuilt underneath us.
 */
export function terrainKey(segs: number, envId: string, epoch: number): string {
  return `${envId}#${epoch}@${segs}`;
}

export function getCachedTerrain(key: string): TerrainBuild | null {
  return cache.get(key) ?? null;
}

function remember(build: TerrainBuild) {
  cache.delete(build.key);
  cache.set(build.key, build);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * The build itself, as a generator that yields its own progress in 0..1.
 *
 * Yields once per ROW rather than once per vertex: at 385 rows the generator
 * overhead is noise, while a per-vertex yield would cost more than the sampling
 * it interrupts.
 */
function* terrainPasses(
  segs: number,
  env: EnvironmentDef,
  key: string,
): Generator<number, TerrainBuild, void> {
  const t = env.terrain;
  const { cx, cz, span } = trackCenter();
  const field = buildTrackField();

  /*
   * PlaneGeometry rather than filling the lattice by hand, even though only its
   * positions and index survive: three's own generator is the definition of
   * where those vertices are, and reimplementing it would mean the mesh and any
   * future consumer of `span`/`segs` could drift by a float.
   */
  const geo = new THREE.PlaneGeometry(span, span, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  const rowLen = segs + 1;
  const colors = new Float32Array(count * 3);
  const ys = new Float32Array(count);

  /* Pass 1 — heights. ~70% of the total cost. */
  let minY = Infinity;
  let maxY = -Infinity;
  for (let row = 0; row < rowLen; row++) {
    const start = row * rowLen;
    const end = Math.min(count, start + rowLen);
    for (let i = start; i < end; i++) {
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cz;
      const y = meshHeight(field, x, z);
      ys[i] = y;
      pos.setY(i, y);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    yield (row / rowLen) * 0.7;
  }
  pos.needsUpdate = true;

  // Normals first: slope is a far better material cue than raw elevation.
  // Wind-scoured rock shows on steep faces while sand settles on flats, and
  // that reads as real landform. Colouring purely by height gave broad
  // horizontal bands that flattened the whole desert.
  //
  // Not sliceable — three walks the whole index buffer in one call — but it is
  // a flat arithmetic pass over the triangles rather than a noise evaluation
  // per vertex, so it is a small fraction of pass 1.
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  yield 0.75;

  /* Pass 2 — vertex colour. */
  const cHollow = new THREE.Color(t.hollow);
  const cLow = new THREE.Color(t.low);
  const cMid = new THREE.Color(t.mid);
  const cHigh = new THREE.Color(t.high);
  const cFace = new THREE.Color(t.face);
  const range = Math.max(0.2, maxY - minY);
  const tmp = new THREE.Color();
  for (let row = 0; row < rowLen; row++) {
    const start = row * rowLen;
    const end = Math.min(count, start + rowLen);
    for (let i = start; i < end; i++) {
      const elev = (ys[i]! - minY) / range;
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cz;
      const rockM = sampleRockMask(x, z);
      // normal.y == 1 on flat ground, falling toward 0 as the face steepens.
      const slope = Math.min(1, Math.max(0, 1 - nrm.getY(i)));

      if (elev < 0.25) tmp.copy(cHollow).lerp(cLow, elev / 0.25);
      else if (elev < 0.55) tmp.copy(cLow).lerp(cMid, (elev - 0.25) / 0.3);
      else tmp.copy(cMid).lerp(cHigh, (elev - 0.55) / 0.45);

      /*
       * Where the ground is a different MATERIAL rather than a different height.
       *
       * The desert rule (faceOnFlats false) is that sand settles on flats and
       * wind strips the steep faces back to rock, so the exposed colour keys off
       * slope. A salt pan inverts it exactly: the crust forms in the flats where
       * the water stood, and the dark material underneath shows on anything
       * steep enough to shed it. Getting that backwards does not look subtly
       * off — it makes a playa look like a dune field with a colour problem,
       * which is why it is a flag on the environment and not a guess here.
       *
       * The rock mask only biases WHERE, never WHETHER, in both directions: it
       * is what keeps the crust patchy instead of painting the whole plain
       * white.
       */
      const facing = t.faceOnFlats ? Math.max(0, 1 - slope * 3.4) : slope;
      const faceAmt = Math.min(1, facing * t.faceStrength * (0.55 + rockM * 0.9));
      if (faceAmt > 0.02) tmp.lerp(cFace, faceAmt);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    yield 0.75 + (row / rowLen) * 0.2;
  }

  /* Pass 3 — world-space UVs. */
  // Tile size is per-environment: ~7m for wind-rippled sand, ~4.5m for the
  // fine grit on the playa, ~5m for broken slag. The old 0.06 scale combined
  // with a repeat of 32 put a full tile inside every half metre, so the
  // ground averaged out to flat colour at any normal viewing distance.
  const UV_PER_METRE = t.uvPerMetre;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      (pos.getX(i) + cx) * UV_PER_METRE,
      (pos.getZ(i) + cz) * UV_PER_METRE,
    );
  }
  uv.needsUpdate = true;

  /*
   * The translate is BAKED IN here rather than applied when the geometry is
   * assembled. `BufferGeometry.translate` mutates the position array in place,
   * so doing it per mount would shift a cached field by (cx, cz) again on every
   * race — the desert would walk away from the circuit one race at a time.
   */
  geo.translate(cx, 0, cz);

  let index = indexCache.get(segs);
  if (!index) {
    const src = geo.index;
    index = src
      ? Uint32Array.from(src.array as ArrayLike<number>)
      : new Uint32Array(0);
    indexCache.set(segs, index);
  }

  const build: TerrainBuild = {
    key,
    segs,
    cx,
    cz,
    span,
    position: pos.array as Float32Array,
    normal: nrm.array as Float32Array,
    color: colors,
    uv: uv.array as Float32Array,
    index,
  };
  remember(build);
  return build;
}

/**
 * Build now, on this thread, blocking until done.
 *
 * This is the FALLBACK, not the intended path: it is what runs if the mesh
 * mounts without the load screen having pre-baked its field (a QA hook that
 * jumps straight to a race, a tier change mid-session, a circuit swapped from
 * the debug panel). It is the old behaviour exactly, hitch and all.
 */
export function buildTerrainSync(
  segs: number,
  env: EnvironmentDef,
  epoch: number,
): TerrainBuild {
  const key = terrainKey(segs, env.id, epoch);
  const hit = cache.get(key);
  if (hit) return hit;
  const gen = terrainPasses(segs, env, key);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/**
 * Build across macrotasks, reporting progress, so the load screen keeps
 * painting and its bar keeps moving.
 *
 * The slice budget is what makes this feel different from the blocking version
 * despite doing identical work: eight milliseconds is under one frame, so the
 * garage behind the overlay stays at its normal frame rate for the whole
 * ~1-1.5s the bake takes. Total wall clock is a little WORSE than the
 * synchronous build — that is the trade being made deliberately.
 */
/**
 * In-flight bakes, so two race starts cannot bake the same field twice.
 *
 * Reachable: the retry button on the results screen is a plain click target and
 * the loading screen takes a moment to appear over it. The gate's generation
 * counter already stops the second start from putting a countdown on the board,
 * but both calls still reach `prepareRaceAssets`, and two interleaved bakes of
 * the same desert would double the one slow step for no result.
 */
const inFlight = new Map<string, Promise<TerrainBuild>>();

export function buildTerrainAsync(
  segs: number,
  env: EnvironmentDef,
  epoch: number,
  onProgress?: (frac: number) => void,
): Promise<TerrainBuild> {
  const key = terrainKey(segs, env.id, epoch);
  const hit = cache.get(key);
  if (hit) {
    onProgress?.(1);
    return Promise.resolve(hit);
  }
  const running = inFlight.get(key);
  if (running) {
    // The second caller gets no incremental progress — it is riding a bake it
    // did not start — so move its bar on completion rather than leaving it at
    // zero for the whole build.
    return running.then((b) => {
      onProgress?.(1);
      return b;
    });
  }

  const job = (async () => {
    const gen = terrainPasses(segs, env, key);
    let sliceStart = gateNow();
    for (;;) {
      const step = gen.next();
      if (step.done) {
        onProgress?.(1);
        return step.value;
      }
      if (gateNow() - sliceStart >= SLICE_MS) {
        onProgress?.(step.value);
        await yieldToBrowser();
        sliceStart = gateNow();
      }
    }
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, job);
  return job;
}

/**
 * Wrap a baked field in a fresh BufferGeometry.
 *
 * Every mount gets its own geometry object over the SAME arrays. That is the
 * whole point: r3f is free to dispose this instance whenever it likes, and the
 * next race pays only for the re-upload.
 */
export function makeTerrainGeometry(build: TerrainBuild): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(build.position, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(build.normal, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(build.color, 3));
  const uv = new THREE.BufferAttribute(build.uv, 2);
  geo.setAttribute("uv", uv);
  // aoMap samples uv1. Same buffer, separate attribute object — three keys its
  // GPU upload off the attribute, so sharing the instance would be fine too,
  // but a second attribute costs nothing and keeps the two independent.
  geo.setAttribute("uv1", new THREE.BufferAttribute(build.uv, 2));
  if (build.index.length > 0) {
    geo.setIndex(new THREE.BufferAttribute(build.index, 1));
  }
  return geo;
}
