/**
 * Procedural desert heightmap with PBR sand.
 * Build is optimized: coarse track index + moderate segments.
 */
import { useMemo } from "react";
import * as THREE from "three";
import { TRACK_SAMPLES } from "../track";
import { sampleDuneField, sampleRockMask } from "./terrainHeight";
import { qualityManager } from "./quality";

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

function buildTrackIndex() {
  const step = Math.max(1, Math.floor(TRACK_SAMPLES.length / 100));
  const pts: { x: number; z: number; half: number; y: number }[] = [];
  for (let i = 0; i < TRACK_SAMPLES.length; i += step) {
    const s = TRACK_SAMPLES[i]!;
    pts.push({ x: s.x, z: s.z, half: s.width * 0.5, y: s.y });
  }
  return pts;
}

function meshHeight(
  pts: { x: number; z: number; half: number; y: number }[],
  x: number,
  z: number,
): number {
  let best = 1e12;
  let half = 13;
  let roadY = 0;
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i]!;
    const d = (x - s.x) * (x - s.x) + (z - s.z) * (z - s.z);
    if (d < best) {
      best = d;
      half = s.half;
      roadY = s.y;
    }
  }
  const dist = Math.sqrt(best);
  if (dist <= half + 2) return roadY;
  const dune = sampleDuneField(x, z);
  const rock = sampleRockMask(x, z);
  const apron = half + 22;
  const deep = half + 70;
  if (dist < apron) {
    const u = (dist - half - 2) / Math.max(0.01, apron - half - 2);
    const s = u * u * (3 - 2 * u);
    return roadY + dune * 1.2 * s + rock * 0.35 * s;
  }
  if (dist < deep) {
    const u = (dist - apron) / Math.max(0.01, deep - apron);
    const s = u * u * (3 - 2 * u);
    const base = 1.1 + dune * 14 + rock * 3;
    return roadY + 1.0 + (base - 1.0) * s;
  }
  return roadY + 1.1 + dune * 16 + rock * 3.5;
}

export function HeightmapTerrain() {
  const tier = qualityManager.get().tier;
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
    const { cx, cz, span } = trackCenter();
    const pts = buildTrackIndex();
    const geo = new THREE.PlaneGeometry(span, span, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);

    const sandLo = new THREE.Color("#c49458");
    const sandMid = new THREE.Color("#e8bc78");
    const sandHi = new THREE.Color("#f8e8c0");
    const rock = new THREE.Color("#5a4a3c");
    const shadow = new THREE.Color("#8a6040");

    let minY = Infinity;
    let maxY = -Infinity;
    const ys = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cz;
      const y = meshHeight(pts, x, z);
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

      if (elev < 0.25) tmp.copy(shadow).lerp(sandLo, elev / 0.25);
      else if (elev < 0.55) tmp.copy(sandLo).lerp(sandMid, (elev - 0.25) / 0.3);
      else tmp.copy(sandMid).lerp(sandHi, (elev - 0.55) / 0.45);

      // Steep faces go to rock; the rock mask only biases where, not whether.
      const rockAmt = Math.min(1, slope * 2.4 * (0.55 + rockM * 0.9));
      if (rockAmt > 0.02) tmp.lerp(rock, rockAmt);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    // One texture tile per ~7m. The old 0.06 scale combined with a repeat of
    // 32 put a full tile inside every half metre, so the sand averaged out to
    // flat colour at any normal viewing distance.
    const UV_PER_METRE = 1 / 7;
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
    const mat = new THREE.MeshStandardMaterial({
      color: "#f5dcac",
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.02,
      envMapIntensity: 1.05,
      emissive: new THREE.Color("#7a5430"),
      emissiveIntensity: 0.0,
    });

    // Async PBR maps — don't block mesh spawn. Tiling comes entirely from the
    // baked UVs above, so repeat stays 1:1 here.
    const loader = new THREE.TextureLoader();
    const apply = (url: string, key: "map" | "normalMap" | "roughnessMap" | "aoMap", srgb = false) => {
      loader.load(url, (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 8;
        if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
        (mat as any)[key] = tex;
        if (key === "normalMap") mat.normalScale = new THREE.Vector2(1.2, 1.2);
        if (key === "aoMap") mat.aoMapIntensity = 1.1;
        mat.needsUpdate = true;
      });
    };
    apply("/assets/textures/sand/diff.jpg", "map", true);
    apply("/assets/textures/sand/nor_gl.jpg", "normalMap");
    apply("/assets/textures/sand/rough.jpg", "roughnessMap");
    apply("/assets/textures/sand/ao.jpg", "aoMap");

    return { geometry: geo, material: mat };
  }, [segs, tier]);

  return (
    <mesh geometry={geometry} material={material} receiveShadow frustumCulled={false} />
  );
}
