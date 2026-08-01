/**
 * Procedural ground: one heightfield, six palettes.
 *
 * The SHAPE of the ground is the circuit's (dunes, rock mask, the carved road
 * corridor) and does not vary by environment — physics drives on it and the
 * height curve is shared with `duneProfile`. What varies is what it is MADE OF:
 * the elevation ramp, which material tiles over it, how rough and how reflective
 * it is, and whether the exposed-material colour belongs on the slopes or on the
 * flats. All of that comes from `getActiveEnvironment().terrain`.
 */
import { useMemo } from "react";
import * as THREE from "three";
import { TRACK_SAMPLES, duneProfile, getSurfaceAt, getTrackEpoch } from "../track";
import { sampleDuneField, sampleRockMask } from "./terrainHeight";
import { qualityManager } from "./quality";
import { attachGpuDetail } from "./shaders/gpuDetail";
import { getMaxAnisotropy } from "./webgl2/configure";
import { clonePbrPack, preloadPbrLibrary } from "./webgl2/textureLibrary";
import { getActiveEnvironment } from "./environments";

function trackCenter() {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of TRACK_SAMPLES) {
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

type TrackField = {
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
  const n = TRACK_SAMPLES.length;
  const segs: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const a = TRACK_SAMPLES[i]!;
    const b = TRACK_SAMPLES[(i + 1) % n]!;
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

/** Exact distance to the track centreline, with road height and half-width. */
function nearestTrack(field: TrackField, x: number, z: number) {
  const list = field.grid.get(
    cellKey(Math.floor(x / GRID_CELL), Math.floor(z / GRID_CELL)),
  );
  let best = Infinity;
  let roadY = 0;
  let half = 13;

  const test = (s: Seg) => {
    const t = Math.min(
      1,
      Math.max(0, ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.len2),
    );
    const ddx = x - (s.ax + s.dx * t);
    const ddz = z - (s.az + s.dz * t);
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 < best) {
      best = d2;
      roadY = s.ay + s.dy * t;
      half = s.ah + s.dh * t;
    }
  };

  if (list) {
    for (let i = 0; i < list.length; i++) test(field.segs[list[i]!]!);
  } else {
    for (let i = 0; i < field.coarse.length; i++) test(field.coarse[i]!);
  }
  return { dist: Math.sqrt(best), roadY, half };
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

export function HeightmapTerrain() {
  const tier = qualityManager.get().tier;
  const epoch = getTrackEpoch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const env = useMemo(() => getActiveEnvironment(), [epoch]);
  /**
   * Sampling resolution of the height field.
   *
   * This was 36/48/64 across a ~600-800m span — 10-16m per quad, two to four
   * times the length of a car. Every octave of sampleDuneField above the very
   * largest was aliased away, which is why the desert read as a handful of
   * enormous flat facets. At 256 the quads are ~2.5m, so the meso and ripple
   * octaves actually survive into the silhouette.
   */
  const segs = tier === "low" ? 128 : tier === "medium" ? 256 : 384;

  const { geometry, material } = useMemo(() => {
    const t = env.terrain;
    const { cx, cz, span } = trackCenter();
    const field = buildTrackField();
    const geo = new THREE.PlaneGeometry(span, span, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);

    const cHollow = new THREE.Color(t.hollow);
    const cLow = new THREE.Color(t.low);
    const cMid = new THREE.Color(t.mid);
    const cHigh = new THREE.Color(t.high);
    const cFace = new THREE.Color(t.face);

    let minY = Infinity;
    let maxY = -Infinity;
    const ys = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cz;
      const y = meshHeight(field, x, z);
      ys[i] = y;
      pos.setY(i, y);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    pos.needsUpdate = true;

    // Normals first: slope is a far better material cue than raw elevation.
    // Wind-scoured rock shows on steep faces while sand settles on flats, and
    // that reads as real landform. Colouring purely by height gave broad
    // horizontal bands that flattened the whole desert.
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal as THREE.BufferAttribute;

    const range = Math.max(0.2, maxY - minY);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
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
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

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
    geo.setAttribute("uv1", (geo.attributes.uv as THREE.BufferAttribute).clone());
    geo.translate(cx, 0, cz);

    // Prefer solid+vertexColor first; maps enhance when loaded
    const q = qualityManager.get();
    const mat = new THREE.MeshStandardMaterial({
      color: t.base,
      vertexColors: true,
      // Dry sand is not a mirror, but at 0.88 the dunes had no terminator
      // sheen at all — they lit like flat paper. 0.82 is enough for the crests
      // to catch the low sun without turning the desert glossy; slag and
      // hardpan sit higher still.
      roughness: t.roughness,
      metalness: t.metalness,
      envMapIntensity: t.envMapIntensity,
      // Set here, not only in the map callback, so the value is correct no
      // matter which map resolves first.
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      /*
       * Ground that is itself hot (cooling slag, a bowl that has not finished
       * burning). Emissive is NOT multiplied by vertex colour in three.js, so
       * this lifts the entire surface uniformly — it reads as the ground
       * refusing to go fully black rather than as glowing veins, and anything
       * above ~0.2 stops reading as heat and starts reading as fog.
       */
      emissive: new THREE.Color(t.emissive),
      emissiveIntensity: t.emissiveIntensity,
    });

    /**
     * Second, finer detail layer — near the camera only.
     *
     * One 7m sand tile is unmistakably *one tile* from inside a car: the same
     * ripple repeats every couple of car lengths and the ground reads as flat
     * wallpaper. attachGpuDetail lays non-repeating fBm over albedo, roughness
     * and (band 3 only) the normal, at roughly half the wavelength of the
     * photo tile, which breaks the seam exactly where it is visible.
     *
     * It is cheap because it is distance-banded: full detail inside lodNear
     * (20m on high), reduced to a single value-noise tap by lodMid, and
     * skipped entirely past lodFar — so the 700m dune field beyond the near
     * band pays only a compare. Low tier runs gpuDetail at 0 and is skipped.
     */
    /*
     * DISABLED pending a measurement on real hardware.
     *
     * This was the one item in the surface pass with a real per-fragment cost
     * (estimated 1-3%), and the terrain plane covers most of the frame. It went
     * in as part of a batch that measured 102fps -> 14fps on a laptop 5080, and
     * an estimate made without profiling is not evidence. Re-enable only with a
     * before/after fps number on the target machine.
     */
    const TERRAIN_DETAIL = false;
    if (TERRAIN_DETAIL && q.gpuDetail > 0.15) {
      attachGpuDetail(mat, { kind: "sand", detailScale: 16, quality: q });
    }

    /*
     * Maps come from the shared PBR library, not from a private TextureLoader.
     *
     * This used to fetch /assets/textures/sand/* directly, which meant the
     * terrain uploaded a SECOND copy of a pack the library already had resident
     * — and, more to the point, it hardcoded which pack. It also cannot survive
     * an environment choosing `rock` or `dirt`, because those packs ship their
     * normal map as nor.jpg while sand ships nor_gl.jpg; the direct URL would
     * 404 on exactly the circuits that most needed a different ground.
     *
     * Awaiting the preload promise rather than testing isPbrLibraryReady() is
     * load-bearing: that predicate goes true once the four CRITICAL packs land,
     * and `rock` and `gravel` are not among them. Testing it would silently
     * leave the Foundry and the Mile untextured — the failure mode that already
     * caught the ridge material out once.
     *
     * Tiling comes entirely from the baked world-space UVs above, so the clone
     * keeps a 1:1 repeat.
     */
    void preloadPbrLibrary().then(() => {
      const pack = clonePbrPack(t.pack, 1, 1);
      if (!pack) return;
      // The UVs run to hundreds of metres, so grazing-angle sampling is the
      // whole game here — this is the one place anisotropy actually buys
      // sharpness on the terrain. Read the cap now rather than at build time:
      // the renderer may not have been configured when the mesh was built, and
      // getMaxAnisotropy() still reports its conservative default then.
      const aniso = Math.min(
        getMaxAnisotropy(),
        qualityManager.get().anisotropy || 8,
      );
      for (const tex of [pack.map, pack.normalMap, pack.roughnessMap, pack.aoMap]) {
        if (!tex) continue;
        tex.anisotropy = aniso;
        tex.needsUpdate = true;
      }
      mat.map = pack.map;
      mat.normalMap = pack.normalMap;
      mat.roughnessMap = pack.roughnessMap;
      if (pack.aoMap) {
        mat.aoMap = pack.aoMap;
        mat.aoMapIntensity = 1.1;
      }
      mat.needsUpdate = true;
    });

    return { geometry: geo, material: mat };
  }, [segs, tier, env]);

  return (
    <mesh geometry={geometry} material={material} receiveShadow frustumCulled={false} />
  );
}
