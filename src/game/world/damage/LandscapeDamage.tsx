/**
 * Renders the persistent landscape damage: crater patches, ground decals and
 * settled wreckage.
 *
 * ---------------------------------------------------------- COST SUMMARY
 *   craters   1 draw call, <= 14 patches x 60 tris  =  840 tris worst case,
 *             rebuilt only when a crater is added (never per frame)
 *   decals    1 draw call, <= 56 quads              =  112 tris worst case
 *   scatter   1 draw call, <= 72 icosahedra x 20 tris = 1440 tris worst case
 *   ------------------------------------------------------------------------
 *   3 draw calls, ~2400 triangles at absolute saturation, zero per-frame
 *   allocation. On low tier the caps drop to 6 / 20 / 24 respectively.
 *
 * The terrain itself is never touched. Craters are additive patch meshes laid
 * on the sampled surface and decals are projected quads — see landscape.ts for
 * why (and for why a crater refuses to spawn on tarmac).
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FRAME } from "../framePriority";
import { qualityManager } from "../quality";
import { getGroundHeight } from "../../track";
import { hash01 } from "../vfx/rng";
import { splatTexture } from "../vfx/sprites";
import { SCATTER_MAX, scatterPool, scatterActiveCount } from "../debris";
import {
  CRATER_MAX,
  DECAL_MAX,
  landscapeCraterVersion,
  landscapeCraters,
  landscapeDecalLive,
  landscapeDecals,
} from "./landscape";

/** Rings past the centre vertex, and segments per ring. */
const CRATER_RINGS = 3;
const CRATER_SEGS = 12;
const CRATER_VERTS = 1 + CRATER_RINGS * CRATER_SEGS;
const CRATER_TRIS = CRATER_SEGS + (CRATER_RINGS - 1) * CRATER_SEGS * 2;

/**
 * Radial position of each ring, as a fraction of the crater radius.
 *
 * Unevenly spaced on purpose: the interesting geometry is the shoulder between
 * 0.4 and 0.8, and spending a ring there instead of out at the flat rim is what
 * gives the bowl a readable silhouette at 12 segments.
 */
const RING_T = [0.4, 0.76, 1] as const;

const UP = new THREE.Vector3(0, 1, 0);

function craterOffsets(depth: number): [number, number, number, number] {
  // Rim height is a fraction of depth and clamped: a deep blast throws up more
  // of a lip, but past ~0.16m the lip starts reading as a wall you should be
  // able to hit, and nothing in the physics knows it is there.
  const rim = Math.max(0.035, Math.min(0.16, depth * 0.2));
  return [-depth, -depth * 0.72, -depth * 0.2 + rim * 0.35, rim];
}

/** Charred floor -> ashy shoulder -> disturbed sand lip. */
const CRATER_COLORS: readonly [number, number, number][] = [
  [0.055, 0.048, 0.042],
  [0.11, 0.09, 0.075],
  [0.28, 0.22, 0.15],
  [0.55, 0.45, 0.31],
];

function CraterPatches() {
  const meshRef = useRef<THREE.Mesh>(null);
  const builtVersion = useRef(-1);
  const builtTier = useRef("");

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(CRATER_MAX * CRATER_VERTS * 3), 3),
    );
    g.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(CRATER_MAX * CRATER_VERTS * 3), 3),
    );
    g.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(CRATER_MAX * CRATER_VERTS * 3), 3),
    );
    g.setIndex(
      new THREE.BufferAttribute(new Uint16Array(CRATER_MAX * CRATER_TRIS * 3), 1),
    );
    g.setDrawRange(0, 0);
    return g;
  }, []);

  useEffect(() => () => geo.dispose(), [geo]);

  useFrame(() => {
    const tier = qualityManager.get().tier;
    const version = landscapeCraterVersion();
    // Rebuilding a crater field is hundreds of getGroundHeight samples, so it
    // happens on a real change only — which for craters means a few times a
    // race, not sixty times a second.
    if (version === builtVersion.current && tier === builtTier.current) return;
    builtVersion.current = version;
    builtTier.current = tier;

    const cap = tier === "low" ? 6 : tier === "medium" ? 10 : CRATER_MAX;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const idx = geo.getIndex()!;
    const parr = pos.array as Float32Array;
    const carr = col.array as Float32Array;
    const iarr = idx.array as Uint16Array;

    let v = 0;
    let t = 0;
    let placed = 0;
    const list = landscapeCraters();

    for (let ci = 0; ci < list.length && placed < cap; ci++) {
      const c = list[ci]!;
      if (!c.active) continue;
      placed++;
      const base = v;
      const off = craterOffsets(c.depth);

      // --- centre vertex
      {
        const o = v * 3;
        parr[o] = c.x;
        parr[o + 1] = getGroundHeight(c.x, c.z) + off[0];
        parr[o + 2] = c.z;
        const cc = CRATER_COLORS[0]!;
        carr[o] = cc[0];
        carr[o + 1] = cc[1];
        carr[o + 2] = cc[2];
        v++;
      }

      for (let r = 0; r < CRATER_RINGS; r++) {
        for (let s = 0; s < CRATER_SEGS; s++) {
          const a = (s / CRATER_SEGS) * Math.PI * 2;
          const h = hash01((c.seed ^ (r * 977) ^ (s * 131)) >>> 0);
          const h2 = hash01((c.seed ^ (r * 31) ^ (s * 7919)) >>> 0);
          // Radial and vertical jitter is what stops fourteen craters reading
          // as fourteen copies of one lathe-turned bowl.
          const rr = c.radius * RING_T[r]! * (0.82 + h * 0.36);
          const px = c.x + Math.cos(a) * rr;
          const pz = c.z + Math.sin(a) * rr;
          const o = v * 3;
          parr[o] = px;
          parr[o + 1] =
            getGroundHeight(px, pz) + off[r + 1]! + (h2 - 0.5) * c.depth * 0.22;
          parr[o + 2] = pz;
          const cc = CRATER_COLORS[r + 1]!;
          const shade = 0.82 + h2 * 0.36;
          carr[o] = cc[0] * shade;
          carr[o + 1] = cc[1] * shade;
          carr[o + 2] = cc[2] * shade;
          v++;
        }
      }

      // --- centre fan
      for (let s = 0; s < CRATER_SEGS; s++) {
        iarr[t * 3] = base;
        iarr[t * 3 + 1] = base + 1 + s;
        iarr[t * 3 + 2] = base + 1 + ((s + 1) % CRATER_SEGS);
        t++;
      }
      // --- ring bands
      for (let r = 0; r < CRATER_RINGS - 1; r++) {
        const a0 = base + 1 + r * CRATER_SEGS;
        const b0 = a0 + CRATER_SEGS;
        for (let s = 0; s < CRATER_SEGS; s++) {
          const s1 = (s + 1) % CRATER_SEGS;
          iarr[t * 3] = a0 + s;
          iarr[t * 3 + 1] = b0 + s;
          iarr[t * 3 + 2] = b0 + s1;
          t++;
          iarr[t * 3] = a0 + s;
          iarr[t * 3 + 1] = b0 + s1;
          iarr[t * 3 + 2] = a0 + s1;
          t++;
        }
      }
    }

    // Park unused vertices far below: an index that still references a stale
    // vertex would otherwise stretch a triangle across the map.
    for (let i = v; i < CRATER_MAX * CRATER_VERTS; i++) {
      parr[i * 3 + 1] = -9999;
    }

    pos.needsUpdate = true;
    col.needsUpdate = true;
    idx.needsUpdate = true;
    geo.setDrawRange(0, t * 3);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const m = meshRef.current;
    if (m) m.visible = t > 0;
  }, FRAME.LATE);

  return (
    <mesh ref={meshRef} visible={false} frustumCulled={false} receiveShadow>
      <primitive object={geo} attach="geometry" />
      <meshStandardMaterial
        vertexColors
        roughness={0.98}
        metalness={0.02}
        // The rim sits ~5cm proud of the sampled surface, but the heightmap's
        // own tessellation error is of the same order, so a depth bias is what
        // actually stops the seam flickering.
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-4}
      />
    </mesh>
  );
}

/**
 * InstancedMesh tints through `instanceColor`, but this build of three only
 * multiplies vColor in under `USE_COLOR` — the material needs `vertexColors`,
 * which needs a real `color` attribute or the unbound generic attribute
 * resolves to (0,0,0) and every instance renders black. Same trap DebrisField
 * documents; same fix.
 */
function withWhiteColors(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const count = geo.getAttribute("position").count;
  geo.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3),
  );
  return geo;
}

function GroundDecals({ playerRef }: { playerRef: React.MutableRefObject<THREE.Vector3> }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const normal = useMemo(() => new THREE.Vector3(), []);
  const map = useMemo(() => splatTexture(128), []);
  const geo = useMemo(
    // Authored in the XZ plane with a +Y normal so aligning it to the terrain
    // normal is a single setFromUnitVectors, and the in-plane spin is then just
    // a rotation about the object's own Y.
    () => withWhiteColors(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
    [],
  );
  useEffect(() => () => geo.dispose(), [geo]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const tier = qualityManager.get().tier;
    const cap = tier === "low" ? 20 : tier === "medium" ? 36 : DECAL_MAX;
    const cull = tier === "low" ? 70 : tier === "medium" ? 110 : 150;
    const cull2 = cull * cull;
    const px = playerRef.current.x;
    const pz = playerRef.current.z;

    let n = 0;
    if (landscapeDecalLive() > 0) {
      const list = landscapeDecals();
      for (let i = 0; i < list.length && n < cap; i++) {
        const d = list[i]!;
        if (!d.active) continue;
        const dx = d.x - px;
        const dz = d.z - pz;
        if (dx * dx + dz * dz > cull2) continue;

        normal.set(d.nx, d.ny, d.nz);
        dummy.position.set(d.x, d.y, d.z);
        dummy.quaternion.setFromUnitVectors(UP, normal);
        dummy.rotateY(d.rot);
        dummy.scale.set(d.across * 2, 1, d.along * 2);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        // A fresh mark darkens in over its first half second. Popping a decal
        // in at full opacity on the frame of impact draws the eye to the seam
        // rather than to the impact.
        const settle = Math.min(1, d.age * 2.2);
        color.setRGB(d.r, d.g, d.b).multiplyScalar(0.6 + settle * 0.4);
        mesh.setColorAt(n, color);
        n++;
      }
    }

    dummy.position.set(0, -900, 0);
    dummy.quaternion.identity();
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    for (let i = n; i < DECAL_MAX; i++) mesh.setMatrixAt(i, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.visible = n > 0;
  }, FRAME.LATE);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, DECAL_MAX]}
      frustumCulled={false}
      visible={false}
      renderOrder={1}
    >
      <primitive object={geo} attach="geometry" />
      <meshStandardMaterial
        map={map}
        alphaMap={map}
        transparent
        // Lit rather than basic: an unlit decal on a sunlit dune reads as a
        // sticker, because it does not darken when the dune turns away from
        // the sun. Cheap here — one extra material, still one draw call.
        roughness={0.94}
        metalness={0}
        vertexColors
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-4}
        polygonOffsetUnits={-8}
        side={THREE.FrontSide}
      />
    </instancedMesh>
  );
}

/**
 * Shape-family proportions for settled wreckage.
 *
 * The live debris field draws four distinct geometries; the persistent field
 * draws ONE, stretched. At rest, half-buried in sand and never closer than a
 * few metres, the silhouette difference between a plank and a slab is carried
 * entirely by proportion — so a single instanced icosahedron with a non-uniform
 * scale buys the same read for a quarter of the draw calls.
 */
const SCATTER_ASPECT: readonly [number, number, number][] = [
  [1, 1, 1],
  [1.9, 0.34, 0.58],
  [1.45, 0.58, 1.2],
  [1.3, 0.22, 1.05],
];

function SettledScatter({ playerRef }: { playerRef: React.MutableRefObject<THREE.Vector3> }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const geo = useMemo(
    () => withWhiteColors(new THREE.IcosahedronGeometry(0.17, 0)),
    [],
  );
  useEffect(() => () => geo.dispose(), [geo]);
  const wasEmpty = useRef(true);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const tier = qualityManager.get().tier;
    const cap = tier === "low" ? 24 : tier === "medium" ? 44 : SCATTER_MAX;
    const cull = tier === "low" ? 60 : tier === "medium" ? 95 : 130;
    const cull2 = cull * cull;
    const px = playerRef.current.x;
    const pz = playerRef.current.z;

    const active = scatterActiveCount();
    // The distance cull depends on where the player is, so this cannot be
    // version-gated the way the crater rebuild is — but an empty field is the
    // common case for the first minute of a race and is worth skipping. One
    // extra pass is spent on the frame it empties, to park the instances.
    if (active === 0 && wasEmpty.current) return;
    wasEmpty.current = active === 0;

    let n = 0;
    if (active > 0) {
      const pool = scatterPool();
      for (let i = 0; i < pool.length && n < cap; i++) {
        const s = pool[i]!;
        if (!s.active) continue;
        const dx = s.x - px;
        const dz = s.z - pz;
        if (dx * dx + dz * dz > cull2) continue;
        const a = SCATTER_ASPECT[s.shape] ?? SCATTER_ASPECT[0]!;
        dummy.position.set(s.x, s.y, s.z);
        dummy.rotation.set(s.rx, s.ry, s.rz);
        dummy.scale.set(s.scale * a[0], s.scale * a[1], s.scale * a[2]);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        color.set(s.colorHex).multiplyScalar(s.tint);
        mesh.setColorAt(n, color);
        n++;
      }
    }

    dummy.position.set(0, -900, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    for (let i = n; i < SCATTER_MAX; i++) mesh.setMatrixAt(i, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.visible = n > 0;
    mesh.castShadow = tier !== "low";
  }, FRAME.LATE);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, SCATTER_MAX]}
      frustumCulled={false}
      visible={false}
      receiveShadow
    >
      <primitive object={geo} attach="geometry" />
      <meshStandardMaterial vertexColors roughness={0.82} metalness={0.35} />
    </instancedMesh>
  );
}

export function LandscapeDamage({
  playerRef,
}: {
  playerRef: React.MutableRefObject<THREE.Vector3>;
}) {
  return (
    <group>
      <CraterPatches />
      <GroundDecals playerRef={playerRef} />
      <SettledScatter playerRef={playerRef} />
    </group>
  );
}
